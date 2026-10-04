import { tokenizeText } from './data';
import { clone } from './editor';
import type {
  AnchorType,
  Annotation,
  AnnotationKind,
  Chapter,
  Sentence,
  TextDocument,
  VersionSnapshot
} from './types';

/** 合并确认结果在 localStorage 中的保存键（与草稿键分开存放）。 */
export const MERGE_STORAGE_KEY = 'sologsb-1022/public-text-annotator/merge-confirmation/v1';

/** 检测到另一标签页已保存、本方草稿被暂时避让时的备份键。 */
export const TAB_CONFLICT_BACKUP_KEY = 'sologsb-1022/public-text-annotator/tab-conflict-backup/v1';

/** 同 ID 注释在两边并列保留时，副本使用的 ID 后缀。 */
export const REMOTE_COPY_SUFFIX = '__merge_remote__';

// ---------- 类型 ----------

export interface MergeMigration {
  annotationId: string;
  annotationTitle: string;
  fromType: AnchorType;
  toType: AnchorType;
  reason: 'word-not-found' | 'word-ambiguous' | 'sentence-not-found';
  detail: string;
}

export type MergePendingReason =
  | 'both-modified'
  | 'crossref-differs'
  | 'delete-modify'
  | 'both-added'
  | 'sentence-text';

export interface MergePendingItem {
  id: string;
  kind: 'annotation' | 'sentence';
  targetId: string;
  anchorId: string;
  anchorType: AnchorType;
  annotationKind?: AnnotationKind;
  anchorLabel: string;
  local: Annotation | null;
  remote: Annotation | null;
  base: Annotation | null;
  localText: string | null;
  remoteText: string | null;
  baseText: string | null;
  reason: MergePendingReason;
  resolution: 'local' | 'remote' | 'both';
}

export interface MergeSummary {
  reused: number;
  added: number;
  migrated: number;
  pending: number;
}

export interface MergeResult {
  document: TextDocument;
  pending: MergePendingItem[];
  migrations: MergeMigration[];
  baseSnapshotId: string;
  summary: MergeSummary;
}

export interface MergeConfirmation {
  id: string;
  baseSnapshotId: string;
  original: TextDocument;
  merged: TextDocument;
  pending: MergePendingItem[];
  migrations: MergeMigration[];
  createdAt: string;
}

// ---------- 比对工具 ----------

function annotationSignature(annotation: Annotation): string {
  return JSON.stringify({
    anchorId: annotation.anchorId,
    anchorType: annotation.anchorType,
    kind: annotation.kind,
    title: annotation.title,
    body: annotation.body,
    source: annotation.source,
    references: annotation.references,
    tags: annotation.tags
  });
}

function sameReferences(a: Annotation, b: Annotation): boolean {
  return JSON.stringify(a.references) === JSON.stringify(b.references);
}

function findSentenceInDocument(document: TextDocument, sentenceId: string): Sentence | undefined {
  for (const chapter of document.chapters) {
    const sentence = chapter.sentences.find((item) => item.id === sentenceId);
    if (sentence) return sentence;
  }
  return undefined;
}

function findChapterOfSentence(document: TextDocument, sentenceId: string): string {
  for (const chapter of document.chapters) {
    if (chapter.sentences.some((sentence) => sentence.id === sentenceId)) return chapter.id;
  }
  return '';
}

function findTokenContext(document: TextDocument, tokenId: string) {
  for (const chapter of document.chapters) {
    for (const sentence of chapter.sentences) {
      const token = sentence.tokens.find((item) => item.id === tokenId);
      if (token) return { sentenceId: sentence.id, tokenText: token.text.trim() };
    }
  }
  return null;
}

function labelForAnchor(documents: TextDocument[], anchorId: string, anchorType: AnchorType): string {
  for (const document of documents) {
    if (anchorType === 'chapter') {
      const chapter = document.chapters.find((item) => item.id === anchorId);
      if (chapter) return chapter.title;
    }
    const sentence = findSentenceInDocument(document, anchorId);
    if (sentence) return `“${sentence.text}”`;
    for (const chapter of document.chapters) {
      const token = chapter.sentences.flatMap((item) => item.tokens).find((item) => item.id === anchorId);
      if (token) return `“${token.text.trim()}”`;
    }
  }
  return '文本片段';
}

// ---------- 句子合并 ----------

function sentencePending(
  sentenceId: string,
  local: Sentence | null,
  remote: Sentence | null,
  base: Sentence | null,
  reason: MergePendingReason,
  documents: TextDocument[]
): MergePendingItem {
  return {
    id: `sentence:${sentenceId}:${reason}`,
    kind: 'sentence',
    targetId: sentenceId,
    anchorId: sentenceId,
    anchorType: 'sentence',
    anchorLabel: labelForAnchor(documents, sentenceId, 'sentence'),
    local: null,
    remote: null,
    base: null,
    localText: local?.text ?? null,
    remoteText: remote?.text ?? null,
    baseText: base?.text ?? null,
    reason,
    resolution: 'local'
  };
}

function mergeSentences(
  base: Sentence[],
  local: Sentence[],
  remote: Sentence[],
  pending: MergePendingItem[],
  documents: TextDocument[]
): Sentence[] {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of base) {
    ids.push(item.id);
    seen.add(item.id);
  }
  for (const item of local) {
    if (!seen.has(item.id)) {
      ids.push(item.id);
      seen.add(item.id);
    }
  }
  for (const item of remote) {
    if (!seen.has(item.id)) {
      ids.push(item.id);
      seen.add(item.id);
    }
  }

  const result: Sentence[] = [];
  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (!b) {
      // 分支之后新增的句子
      if (l && r) {
        if (l.text === r.text) result.push(clone(l));
        else {
          result.push(clone(l));
          pending.push(sentencePending(id, l, r, null, 'both-added', documents));
        }
      } else if (l) {
        result.push(clone(l));
      } else if (r) {
        result.push(clone(r));
      }
      continue;
    }

    if (l && r) {
      const localChanged = l.text !== b.text;
      const remoteChanged = r.text !== b.text;
      if (!localChanged && !remoteChanged) result.push(clone(l));
      else if (localChanged && !remoteChanged) result.push(clone(l));
      else if (!localChanged && remoteChanged) result.push(clone(r));
      else if (l.text === r.text) result.push(clone(l));
      else {
        result.push(clone(l));
        pending.push(sentencePending(id, l, r, b, 'sentence-text', documents));
      }
    } else if (l && !r) {
      // 对方删除，我方改过 → 修改/删除冲突
      if (l.text === b.text) continue;
      result.push(clone(l));
      pending.push(sentencePending(id, l, null, b, 'delete-modify', documents));
    } else if (!l && r) {
      if (r.text === b.text) continue;
      result.push(clone(r));
      pending.push(sentencePending(id, null, r, b, 'delete-modify', documents));
    }
    // 双方都删除 → 不保留
  }
  return result;
}

// ---------- 章节合并 ----------

function mergeChapters(
  base: Chapter[],
  local: Chapter[],
  remote: Chapter[],
  pending: MergePendingItem[],
  documents: TextDocument[]
): Chapter[] {
  const baseMap = new Map(base.map((item) => [item.id, item]));
  const localMap = new Map(local.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.map((item) => [item.id, item]));

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of base) {
    ids.push(item.id);
    seen.add(item.id);
  }
  for (const item of local) {
    if (!seen.has(item.id)) {
      ids.push(item.id);
      seen.add(item.id);
    }
  }
  for (const item of remote) {
    if (!seen.has(item.id)) {
      ids.push(item.id);
      seen.add(item.id);
    }
  }

  const result: Chapter[] = [];
  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (!b) {
      if (l && r) {
        const mergedSentences = mergeSentences([], l.sentences, r.sentences, pending, documents);
        result.push({ id, order: l.order, title: l.title, summary: l.summary, sentences: mergedSentences });
      } else if (l) {
        result.push(clone(l));
      } else if (r) {
        result.push(clone(r));
      }
      continue;
    }

    if (!l && !r) continue;

    const mergedSentences = mergeSentences(
      b.sentences,
      l?.sentences ?? [],
      r?.sentences ?? [],
      pending,
      documents
    );

    let title = b.title;
    let summary = b.summary;
    let order = b.order;
    if (l && r) {
      const localChanged = l.title !== b.title || l.summary !== b.summary;
      const remoteChanged = r.title !== b.title || r.summary !== b.summary;
      if (localChanged && !remoteChanged) {
        title = l.title;
        summary = l.summary;
        order = l.order;
      } else if (!localChanged && remoteChanged) {
        title = r.title;
        summary = r.summary;
        order = r.order;
      } else {
        title = l.title;
        summary = l.summary;
        order = l.order;
      }
    } else if (l) {
      title = l.title;
      summary = l.summary;
      order = l.order;
    } else if (r) {
      title = r.title;
      summary = r.summary;
      order = r.order;
    }

    result.push({ id, order, title, summary, sentences: mergedSentences });
  }
  return result;
}

// ---------- 注释合并 ----------

function annotationPending(
  annotationId: string,
  local: Annotation | null,
  remote: Annotation | null,
  base: Annotation | null,
  reason: MergePendingReason,
  documents: TextDocument[]
): MergePendingItem {
  const anchor = local ?? remote ?? base;
  return {
    id: `annotation:${annotationId}:${reason}`,
    kind: 'annotation',
    targetId: annotationId,
    anchorId: anchor?.anchorId ?? '',
    anchorType: anchor?.anchorType ?? 'sentence',
    annotationKind: anchor?.kind,
    anchorLabel: labelForAnchor(documents, anchor?.anchorId ?? '', anchor?.anchorType ?? 'sentence'),
    local: local ? clone(local) : null,
    remote: remote ? clone(remote) : null,
    base: base ? clone(base) : null,
    localText: null,
    remoteText: null,
    baseText: null,
    reason,
    resolution: 'both'
  };
}

function mergeAnnotations(
  base: TextDocument,
  local: TextDocument,
  remote: TextDocument,
  pending: MergePendingItem[],
  counters: { reused: number; added: number }
): Annotation[] {
  const baseMap = new Map(base.annotations.map((item) => [item.id, item]));
  const localMap = new Map(local.annotations.map((item) => [item.id, item]));
  const remoteMap = new Map(remote.annotations.map((item) => [item.id, item]));

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of [...base.annotations, ...local.annotations, ...remote.annotations]) {
    if (!seen.has(item.id)) {
      ids.push(item.id);
      seen.add(item.id);
    }
  }

  const documents = [base, local, remote];
  const result: Annotation[] = [];

  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (!b) {
      // 分支之后新增的注释
      if (l && r) {
        if (annotationSignature(l) === annotationSignature(r)) {
          result.push(clone(l));
          counters.added += 1;
        } else {
          result.push(clone(l));
          const remoteCopy = clone(r);
          remoteCopy.id = `${id}${REMOTE_COPY_SUFFIX}`;
          result.push(remoteCopy);
          pending.push(annotationPending(id, l, r, null, 'both-added', documents));
        }
      } else if (l) {
        result.push(clone(l));
        counters.added += 1;
      } else if (r) {
        result.push(clone(r));
        counters.added += 1;
      }
      continue;
    }

    if (l && r) {
      const localChanged = annotationSignature(l) !== annotationSignature(b);
      const remoteChanged = annotationSignature(r) !== annotationSignature(b);
      const refsDiffer = !sameReferences(l, r);

      if (!localChanged && !remoteChanged) {
        result.push(clone(l));
        counters.reused += 1;
      } else if (localChanged && !remoteChanged && !refsDiffer) {
        result.push(clone(l));
      } else if (!localChanged && remoteChanged && !refsDiffer) {
        result.push(clone(r));
      } else {
        // 两边都改，或互见关系不同 → 并列保留，等待人工选择
        result.push(clone(l));
        const remoteCopy = clone(r);
        remoteCopy.id = `${id}${REMOTE_COPY_SUFFIX}`;
        result.push(remoteCopy);
        pending.push(
          annotationPending(id, l, r, b, localChanged && remoteChanged ? 'both-modified' : 'crossref-differs', documents)
        );
      }
    } else if (l && !r) {
      // 对方删除，我方改过 → 修改/删除冲突；我方未改则随删除
      if (annotationSignature(l) === annotationSignature(b)) continue;
      result.push(clone(l));
      pending.push(annotationPending(id, l, null, b, 'delete-modify', documents));
    } else if (!l && r) {
      if (annotationSignature(r) === annotationSignature(b)) continue;
      result.push(clone(r));
      pending.push(annotationPending(id, null, r, b, 'delete-modify', documents));
    }
    // 双方都删除 → 不保留
  }

  return result;
}

// ---------- 快照合并 ----------

function mergeSnapshots(
  base: VersionSnapshot[],
  local: VersionSnapshot[],
  remote: VersionSnapshot[]
): VersionSnapshot[] {
  const map = new Map<string, VersionSnapshot>();
  for (const snapshot of [...base, ...local, ...remote]) {
    if (!map.has(snapshot.id)) map.set(snapshot.id, snapshot);
  }
  return Array.from(map.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------- 合并后重新定位词语 ----------

function recordMigration(
  migrations: MergeMigration[],
  annotation: Annotation,
  toType: AnchorType,
  reason: MergeMigration['reason'],
  detail: string
) {
  migrations.push({
    annotationId: annotation.id,
    annotationTitle: annotation.title,
    fromType: annotation.anchorType,
    toType,
    reason,
    detail
  });
}

function relocateAnchors(
  document: TextDocument,
  base: TextDocument,
  local: TextDocument,
  remote: TextDocument,
  migrations: MergeMigration[]
) {
  const sources = [base, local, remote];

  for (const annotation of document.annotations) {
    if (annotation.anchorType === 'word') {
      // 按校订快照找回原词与所属句；副本 ID 去掉后缀再找一次
      let context = findTokenContext(base, annotation.anchorId);
      if (!context) context = findTokenContext(local, annotation.anchorId);
      if (!context) context = findTokenContext(remote, annotation.anchorId);
      if (!context && annotation.id.endsWith(REMOTE_COPY_SUFFIX)) {
        const originalId = annotation.id.slice(0, -REMOTE_COPY_SUFFIX.length);
        for (const source of sources) {
          context = findTokenContext(source, originalId);
          if (context) break;
        }
      }

      const sentence = context ? findSentenceInDocument(document, context.sentenceId) : undefined;
      if (!context || !sentence) {
        // 所属句也不在了 → 迁到章节
        const chapterId = context ? findChapterOfSentence(document, context.sentenceId) : '';
        if (chapterId) {
          recordMigration(migrations, annotation, 'chapter', 'sentence-not-found', '校订快照中的原句在合并稿中已不存在');
          annotation.anchorId = chapterId;
          annotation.anchorType = 'chapter';
        }
        continue;
      }

      const matches = sentence.tokens.filter((token) => token.text.trim() === context!.tokenText);
      if (matches.length === 1) {
        // 唯一对上 → 沿用，重新锚定到合并后的 token
        annotation.anchorId = matches[0].id;
      } else {
        // 原词消失或重复难辨 → 迁到所属句
        recordMigration(
          migrations,
          annotation,
          'sentence',
          matches.length === 0 ? 'word-not-found' : 'word-ambiguous',
          matches.length === 0
            ? `校订快照中的原词“${context.tokenText}”在合并后的句子中已消失`
            : `校订快照中的原词“${context.tokenText}”在合并后的句子中重复出现，无法唯一对应`
        );
        annotation.anchorId = sentence.id;
        annotation.anchorType = 'sentence';
      }
      continue;
    }

    if (annotation.anchorType === 'sentence') {
      if (!findSentenceInDocument(document, annotation.anchorId)) {
        const chapterId =
          findChapterOfSentence(base, annotation.anchorId) ||
          findChapterOfSentence(local, annotation.anchorId) ||
          findChapterOfSentence(remote, annotation.anchorId) ||
          document.chapters[0]?.id ||
          '';
        if (chapterId) {
          recordMigration(migrations, annotation, 'chapter', 'sentence-not-found', '注释所在句在合并稿中已不存在');
          annotation.anchorId = chapterId;
          annotation.anchorType = 'chapter';
        }
      }
    }
  }
}

// ---------- 合并入口 ----------

/**
 * 以校订快照为共同底本，合并两台机器的草稿。
 * - 句子按稳定 ID 对齐，词语按快照中的原文重新定位，唯一对上的沿用，原词消失迁到句子。
 * - 同 ID 注释：未改动沿用；单方改动取改动方；两边都改或互见关系不同 → 并列保留进 pending。
 */
export function mergeDrafts(base: TextDocument, local: TextDocument, remote: TextDocument): MergeResult {
  const pending: MergePendingItem[] = [];
  const migrations: MergeMigration[] = [];
  const counters = { reused: 0, added: 0 };

  const chapters = mergeChapters(base.chapters, local.chapters, remote.chapters, pending, [base, local, remote]);
  const annotations = mergeAnnotations(base, local, remote, pending, counters);
  const snapshots = mergeSnapshots(base.snapshots, local.snapshots, remote.snapshots);

  const document: TextDocument = {
    ...clone(local),
    chapters,
    annotations,
    snapshots,
    updatedAt: new Date().toISOString()
  };

  relocateAnchors(document, base, local, remote, migrations);

  return {
    document,
    pending,
    migrations,
    baseSnapshotId: base.id,
    summary: {
      reused: counters.reused,
      added: counters.added,
      migrated: migrations.length,
      pending: pending.length
    }
  };
}

// ---------- 应用待处理项的选择 ----------

/** 按待处理项的选择生成最终草稿；合并、恢复、导出都读取同一份确认结果。 */
export function applyMergeResolution(document: TextDocument, pending: MergePendingItem[]): TextDocument {
  const result = clone(document);

  for (const item of pending) {
    if (item.kind === 'sentence') {
      const sentence = findSentenceInDocument(result, item.targetId);
      if (item.resolution === 'remote') {
        if (item.remoteText === null) {
          // 选择删除该句
          for (const chapter of result.chapters) {
            chapter.sentences = chapter.sentences.filter((sentence) => sentence.id !== item.targetId);
          }
        } else if (sentence) {
          sentence.text = item.remoteText;
          sentence.tokens = tokenizeText(item.remoteText, sentence.id, sentence.tokens);
        }
      }
      continue;
    }

    const remoteCopyId = `${item.targetId}${REMOTE_COPY_SUFFIX}`;
    if (item.resolution === 'local') {
      result.annotations = result.annotations.filter((annotation) => annotation.id !== remoteCopyId);
    } else if (item.resolution === 'remote') {
      result.annotations = result.annotations.filter((annotation) => annotation.id !== item.targetId);
      const remoteCopy = result.annotations.find((annotation) => annotation.id === remoteCopyId);
      if (remoteCopy) remoteCopy.id = item.targetId;
    }
    // 'both' → 两条并列保留
  }

  // 清理指向已删除注释的互见引用
  const existingIds = new Set(result.annotations.map((annotation) => annotation.id));
  for (const annotation of result.annotations) {
    annotation.references = annotation.references.filter((id) => existingIds.has(id));
  }

  result.updatedAt = new Date().toISOString();
  return result;
}

// ---------- 确认结果 ----------

export function createConfirmation(
  baseSnapshotId: string,
  original: TextDocument,
  merged: TextDocument,
  pending: MergePendingItem[],
  migrations: MergeMigration[]
): MergeConfirmation {
  return {
    id: `merge-${Date.now().toString(36)}`,
    baseSnapshotId,
    original: clone(original),
    merged: clone(merged),
    pending: clone(pending),
    migrations: clone(migrations),
    createdAt: new Date().toISOString()
  };
}

export function resolveConfirmationItem(
  confirmation: MergeConfirmation,
  itemId: string,
  resolution: MergePendingItem['resolution']
): MergeConfirmation {
  return {
    ...confirmation,
    pending: confirmation.pending.map((item) => (item.id === itemId ? { ...item, resolution } : item))
  };
}

/** 同一份确认结果：写入当前稿、恢复原稿、导出都从这里取稿。 */
export function confirmationDocument(confirmation: MergeConfirmation): TextDocument {
  return applyMergeResolution(confirmation.merged, confirmation.pending);
}

// ---------- 草稿文件解析 ----------

export function parseDraftFile(text: string): TextDocument {
  const parsed = JSON.parse(text) as Partial<TextDocument>;
  if (!parsed || !Array.isArray(parsed.chapters) || !Array.isArray(parsed.annotations)) {
    throw new Error('草稿文件缺少章节或注释数据');
  }
  return parsed as TextDocument;
}
