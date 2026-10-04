import { clone } from './editor';
import { tokenizeText } from './data';
import type {
  AcceptedAnnotation,
  Annotation,
  Chapter,
  ConfirmedMerge,
  MergeChange,
  MergeConflict,
  MergePlan,
  MergeResolution,
  MergeReview,
  MergeSide,
  Sentence,
  SentenceMergeState,
  TextDocument,
  TextToken,
  VersionSnapshot,
  WorkspaceState
} from './types';

export class MergeValidationError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MergeValidationError(message);
}

interface SentenceIndex {
  byId: Map<string, { chapter: Chapter; sentence: Sentence }>;
}

function buildSentenceIndex(chapters: Chapter[]): SentenceIndex {
  const byId = new Map<string, { chapter: Chapter; sentence: Sentence }>();
  for (const chapter of chapters) {
    for (const sentence of chapter.sentences) byId.set(sentence.id, { chapter, sentence });
  }
  return { byId };
}

function findSentence(chapters: Chapter[], sentenceId: string) {
  for (const chapter of chapters) {
    const sentence = chapter.sentences.find((item) => item.id === sentenceId);
    if (sentence) return { chapter, sentence };
  }
  return undefined;
}

/** 记录某个词在一句话里出现的位置序号（同名同形词消歧） */
function occurrenceIndex(sentence: Sentence, tokenId: string): number {
  const token = sentence.tokens.find((item) => item.id === tokenId);
  if (!token) return -1;
  let occurrence = 0;
  for (const item of sentence.tokens) {
    if (item.text === token.text) {
      if (item.id === tokenId) return occurrence;
      occurrence += 1;
    }
  }
  return occurrence;
}

/**
 * 按校订快照重新定位词级锚点：
 * - 在对方句子里按“同形 + 同一次出现序号”唯一命中 → 沿用新 token id
 * - 同形词不止一个 / 找不到 / 跨句 → 词已消失，迁移到所属句子
 */
export function relocateTokenAnchor(args: {
  baseSentence: Sentence;
  targetSentence: Sentence;
  tokenId: string;
}): { anchorId: string; anchorType: 'word' | 'sentence'; targetToken?: TextToken; reason: string } {
  const { baseSentence, targetSentence, tokenId } = args;
  const baseToken = baseSentence.tokens.find((item) => item.id === tokenId);
  if (!baseToken) return { anchorId: targetSentence.id, anchorType: 'sentence', reason: '原词在快照中已不存在' };
  if (targetSentence.id !== baseSentence.id) {
    return { anchorId: targetSentence.id, anchorType: 'sentence', reason: '原句已改，词语随句迁移' };
  }
  const sameShape = targetSentence.tokens.filter((item) => item.text === baseToken.text);
  const occurrence = occurrenceIndex(baseSentence, tokenId);
  if (sameShape.length <= occurrence) {
    return {
      anchorId: targetSentence.id,
      anchorType: 'sentence',
      reason: sameShape.length === 0
        ? `原词“${baseToken.text.trim()}”已消失，迁移到所属句`
        : `原词“${baseToken.text.trim()}”的第 ${occurrence + 1} 处出现已消失，无法唯一定位，迁移到所属句`
    };
  }
  const candidate = sameShape.length === 1 ? sameShape[0] : sameShape[occurrence];
  if (!candidate) {
    return { anchorId: targetSentence.id, anchorType: 'sentence', reason: `原词“${baseToken.text.trim()}”已消失，迁移到所属句` };
  }
  return { anchorId: candidate.id, anchorType: 'word', targetToken: candidate, reason: '沿用' };
}

function normalizeTokenIds(sentence: Sentence, prefer: Sentence): Sentence {
  // 以 prefer 侧的 token id 为准重建，让词级注释能沿用到对方正文
  const next: Sentence = clone(sentence);
  next.tokens = tokenizeText(next.text, next.id, prefer.tokens);
  return next;
}

function normalizeText(value: string) {
  return value.trim();
}

function refsKey(annotation: Annotation) {
  return [...annotation.references].sort().join('');
}

function tagsKey(annotation: Annotation) {
  return [...annotation.tags].sort().join('');
}

/** 不考虑锚点，只比较注释内容本身（锚点迁移不算“两边都改”） */
function sameAnnotationContent(a: Annotation, b: Annotation) {
  return (
    a.kind === b.kind &&
    a.title === b.title &&
    a.body === b.body &&
    a.source === b.source &&
    refsKey(a) === refsKey(b) &&
    tagsKey(a) === tagsKey(b) &&
    a.status === b.status
  );
}

function conflictLabelFor(annotation: Annotation, baseChapters: Chapter[]) {
  if (annotation.anchorType === 'chapter') {
    const chapter = baseChapters.find((item) => item.id === annotation.anchorId);
    return chapter?.title ?? '章节';
  }
  const hit = findSentence(baseChapters, annotation.anchorId);
  if (hit) return `“${hit.sentence.text.slice(0, 24)}”`;
  for (const chapter of baseChapters) {
    for (const sentence of chapter.sentences) {
      const token = sentence.tokens.find((item) => item.id === annotation.anchorId);
      if (token) return `“${token.text.trim()}”（${sentence.text.slice(0, 16)}…）`;
    }
  }
  return '文本片段';
}

function ensureIdUnique(id: string, used: Set<string>) {
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let suffix = 2;
  let candidate = `${id}-乙${suffix}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${id}-乙${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

let conflictSeq = 0;
function nextConflictId() {
  conflictSeq += 1;
  return `merge-conflict-${Date.now().toString(36)}-${conflictSeq}`;
}

export interface BuildMergeOptions {
  baseSnapshot: VersionSnapshot;
  local: TextDocument;
  incoming: TextDocument;
  source?: MergePlan['source'];
}

/**
 * 三向合并：base（共同校订快照）/ local（本机当前稿）/ incoming（另一台机器草稿）。
 * 不做任何静默取舍——句子正文冲突、注释两边都改、互见关系不同、
 * 一方删除一方修改，都进入 conflicts 等待人工确认。
 */
export function buildMergePlan(options: BuildMergeOptions): MergePlan {
  const { baseSnapshot, local, incoming } = options;
  assert(baseSnapshot, '缺少共同校订快照，无法定位句子和词语');
  assert(local.chapters.length && incoming.chapters.length, '合并草稿的正文数据不完整');

  const baseChapters: Chapter[] = clone(baseSnapshot.chapters);
  const localChapters: Chapter[] = clone(local.chapters);
  const incomingChapters: Chapter[] = clone(incoming.chapters);
  const baseIndex = buildSentenceIndex(baseChapters);
  const localIndex = buildSentenceIndex(localChapters);
  const incomingIndex = buildSentenceIndex(incomingChapters);

  const changes: MergeChange[] = [];
  const conflicts: MergeConflict[] = [];
  const sentenceStates: SentenceMergeState[] = [];
  const accepted: AcceptedAnnotation[] = [];

  // ---- 1. 章节与句子：按稳定 ID 合并正文，记录句子级冲突 ----
  const mergedChapters: Chapter[] = localChapters.map((localChapter) => {
    const baseChapter = baseChapters.find((item) => item.id === localChapter.id);
    const incomingChapter = incomingChapters.find((item) => item.id === localChapter.id);
    const sentences: Sentence[] = localChapter.sentences.map((localSentence) => {
      const baseHit = baseIndex.byId.get(localSentence.id);
      const incomingHit = incomingChapter?.sentences.find((item) => item.id === localSentence.id);
      const baseText = baseHit?.sentence.text ?? localSentence.text;

      // 对方没有这句
      if (!incomingHit) {
        if (localSentence.text !== baseText) {
          sentenceStates.push({
            chapterId: localChapter.id, sentenceId: localSentence.id,
            baseText, localText: localSentence.text, incomingText: '',
            status: 'local-only'
          });
        }
        return normalizeTokenIds(localSentence, localSentence);
      }

      const incomingSentence = incomingHit;
      const localChanged = localSentence.text !== baseText;
      const incomingChanged = incomingSentence.text !== baseText;

      if (localChanged && incomingChanged && localSentence.text !== incomingSentence.text) {
        const conflictId = nextConflictId();
        conflicts.push({
          id: conflictId,
          type: 'sentence-text',
          reason: '同一句两边都有校改，需人工选择采用哪一版正文',
          chapterId: localChapter.id,
          sentenceId: localSentence.id,
          anchorLabel: `${localChapter.title} · 第 ${localSentence.order} 句`,
          localText: localSentence.text,
          incomingText: incomingSentence.text
        });
        sentenceStates.push({
          chapterId: localChapter.id, sentenceId: localSentence.id,
          baseText, localText: localSentence.text, incomingText: incomingSentence.text,
          status: 'conflict', conflictId
        });
        // 冲突未决时先放本机正文，确认后再切换
        return normalizeTokenIds(localSentence, localSentence);
      }

      let merged: Sentence;
      let status: SentenceMergeState['status'];
      if (incomingChanged) {
        merged = normalizeTokenIds(incomingSentence, incomingSentence);
        status = 'incoming';
        changes.push({
          id: localSentence.id, tone: 'incoming',
          label: `${localChapter.title} · 第 ${localSentence.order} 句`,
          detail: `${baseText} → ${incomingSentence.text}`
        });
      } else {
        merged = normalizeTokenIds(localSentence, localSentence);
        status = localChanged ? 'local' : 'same';
        if (localChanged) {
          changes.push({
            id: localSentence.id, tone: 'local',
            label: `${localChapter.title} · 第 ${localSentence.order} 句`,
            detail: `${baseText} → ${localSentence.text}`
          });
        }
      }
      sentenceStates.push({
        chapterId: localChapter.id, sentenceId: localSentence.id,
        baseText, localText: localSentence.text, incomingText: incomingSentence.text,
        status
      });
      return merged;
    });

    // 对方新增的句子
    if (incomingChapter && baseChapter) {
      for (const incomingSentence of incomingChapter.sentences) {
        if (baseIndex.byId.has(incomingSentence.id)) continue;
        if (sentences.some((item) => item.id === incomingSentence.id)) continue;
        sentences.push(normalizeTokenIds(incomingSentence, incomingSentence));
        sentenceStates.push({
          chapterId: localChapter.id, sentenceId: incomingSentence.id,
          baseText: '', localText: '', incomingText: incomingSentence.text,
          status: 'incoming-only'
        });
        changes.push({
          id: incomingSentence.id, tone: 'add-incoming',
          label: `${localChapter.title} · 新增第 ${incomingSentence.order} 句`,
          detail: incomingSentence.text
        });
      }
    }
    return { ...localChapter, summary: incomingChapter?.summary ?? localChapter.summary, sentences };
  });

  // 对方新增的章节
  for (const incomingChapter of incomingChapters) {
    if (mergedChapters.some((item) => item.id === incomingChapter.id)) continue;
    mergedChapters.push(clone(incomingChapter));
    changes.push({
      id: incomingChapter.id, tone: 'add-incoming',
      label: `新增章节 · ${incomingChapter.title}`,
      detail: incomingChapter.summary
    });
  }

  const mergedIndex = buildSentenceIndex(mergedChapters);

  // ---- 2. 注释：按稳定 ID 三向合并，锚点先重定位 ----
  const baseAnnotations = new Map(baseSnapshot.annotations.map((item) => [item.id, item]));
  const localAnnotations = new Map(local.annotations.map((item) => [item.id, item]));
  const incomingAnnotations = new Map(incoming.annotations.map((item) => [item.id, item]));

  const usedIds = new Set<string>();
  const idRewrites: [string, string][] = [];

  // 对方独有的注释 id（撞本机新增 id 时改写）
  for (const [id, annotation] of incomingAnnotations) {
    if (baseAnnotations.has(id)) continue;
    if (!localAnnotations.has(id)) continue;
    // base 里没有、两边都用了同一个 id：不同机器各自新增，撞号
    const localOne = localAnnotations.get(id)!;
    const incomingOne = annotation;
    if (
      localOne.title !== incomingOne.title ||
      localOne.body !== incomingOne.body ||
      localOne.anchorId !== incomingOne.anchorId
    ) {
      const newId = `${id}-乙`;
      const unique = ensureIdUnique(newId, usedIds);
      idRewrites.push([id, unique]);
      conflicts.push({
        id: nextConflictId(),
        type: 'same-id-different',
        reason: '两边各自新增的注释用了同一编号，乙稿已临时改名，可并列保留或删除其一',
        chapterId: '',
        anchorLabel: `${localOne.title} / ${incomingOne.title}`,
        kind: localOne.kind,
        localAnnotation: clone(localOne),
        incomingAnnotation: clone({ ...incomingOne, id: unique })
      });
    }
  }

  function relocatedAnnotation(annotation: Annotation, side: MergeSide): { annotation: Annotation; migrated: boolean; migrateReason?: string } {
    const next = clone(annotation);
    const sourceChapters = side === 'local' ? localChapters : incomingChapters;
    const hit = findSentence(sourceChapters, next.anchorId);
    const tokenHit = (() => {
      if (next.anchorType !== 'word') return undefined;
      for (const chapter of sourceChapters) {
        for (const sentence of chapter.sentences) {
          const token = sentence.tokens.find((item) => item.id === next.anchorId);
          if (token) return { chapter, sentence, token };
        }
      }
      return undefined;
    })();

    if (next.anchorType === 'chapter') {
      if (!mergedChapters.some((chapter) => chapter.id === next.anchorId)) {
        const fallback = mergedChapters[0];
        next.anchorId = fallback.id;
      }
      return { annotation: next, migrated: false };
    }

    const owningSentence = hit?.sentence ?? tokenHit?.sentence;
    const mergedHit = owningSentence ? mergedIndex.byId.get(owningSentence.id) : undefined;
    if (!owningSentence || !mergedHit) {
      // 整句在合并稿里不存在：挂到同章首句，等人工处理
      const fallback = mergedChapters.find((chapter) => chapter.id === (hit?.chapter.id ?? tokenHit?.chapter.id))?.sentences[0]
        ?? mergedChapters[0]?.sentences[0];
      assert(fallback, '注释无法在合并正文里定位');
      next.anchorId = fallback.id;
      next.anchorType = 'sentence';
      return { annotation: next, migrated: true, migrateReason: '所属句子已不存在，迁移到相邻句' };
    }

    if (next.anchorType === 'sentence') {
      next.anchorId = mergedHit.sentence.id;
      return { annotation: next, migrated: false };
    }

    const baseSentence = baseIndex.byId.get(owningSentence.id)?.sentence ?? owningSentence;
    const relocated = relocateTokenAnchor({
      baseSentence: side === 'incoming' ? baseSentence : baseSentence,
      targetSentence: mergedHit.sentence,
      tokenId: next.anchorId
    });
    if (relocated.anchorType === 'sentence') {
      next.anchorId = mergedHit.sentence.id;
      next.anchorType = 'sentence';
      if (!next.title.endsWith('（引用已随校改迁移）')) next.title = `${next.title}（引用已随校改迁移）`;
      return { annotation: next, migrated: true, migrateReason: relocated.reason };
    }
    next.anchorId = relocated.anchorId;
    return { annotation: next, migrated: false };
  }

  function pushAccepted(side: MergeSide, annotation: Annotation, migrated: boolean, change: MergeChange) {
    accepted.push({ provenance: side, annotation, migratedToSentence: migrated, change });
    changes.push(change);
  }

  const allIds = new Set<string>([...baseAnnotations.keys(), ...localAnnotations.keys(), ...incomingAnnotations.keys()]);

  for (const id of allIds) {
    const base = baseAnnotations.get(id);
    let localOne = localAnnotations.get(id);
    let incomingOne = incomingAnnotations.get(id);

    // 撞号的对方注释走重写后的 id
    const rewrite = idRewrites.find(([from]) => from === id);
    if (rewrite && incomingOne) {
      incomingOne = { ...incomingOne, id: rewrite[1] };
    }
    const finalId = rewrite ? rewrite[1] : id;
    if (localOne) localOne = { ...localOne };

    // ---- 新增注释 ----
    if (!base) {
      if (localOne && !incomingOne) {
        const { annotation, migrated, migrateReason } = relocatedAnnotation(localOne, 'local');
        pushAccepted('local', annotation, migrated, {
          id, tone: 'add-local',
          label: `甲稿新增注释 · ${annotation.title}`,
          detail: migrateReason ?? annotation.body
        });
      } else if (incomingOne && !localOne) {
        const { annotation, migrated, migrateReason } = relocatedAnnotation({ ...incomingOne, id: finalId }, 'incoming');
        pushAccepted('incoming', annotation, migrated, {
          id: finalId, tone: 'add-incoming',
          label: `乙稿新增注释 · ${annotation.title}`,
          detail: migrateReason ?? annotation.body
        });
      } else if (localOne && incomingOne) {
        // 撞号已在上面登记冲突；未撞号（同 id 且内容相同）说明是同一注释
        if (rewrite) {
          const a = relocatedAnnotation(localOne, 'local');
          const b = relocatedAnnotation({ ...incomingOne, id: finalId }, 'incoming');
          pushAccepted('local', a.annotation, a.migrated, {
            id, tone: 'add-local', label: `甲稿新增注释 · ${a.annotation.title}`, detail: a.migrateReason ?? a.annotation.body
          });
          pushAccepted('incoming', b.annotation, b.migrated, {
            id: finalId, tone: 'add-incoming', label: `乙稿新增注释 · ${b.annotation.title}`, detail: b.migrateReason ?? b.annotation.body
          });
        } else if (sameAnnotationContent(localOne, incomingOne)) {
          const { annotation, migrated } = relocatedAnnotation(localOne, 'local');
          pushAccepted('local', annotation, migrated, {
            id, tone: 'carry', label: `两边一致新增 · ${annotation.title}`, detail: annotation.body
          });
        }
      }
      continue;
    }

    // ---- base 已有：删除 / 修改 / 沿用 ----
    if (localOne && !incomingOne) {
      if (!sameAnnotationContent(localOne, base)) {
        // 乙删、甲改：冲突
        conflicts.push({
          id: nextConflictId(),
          type: 'delete-vs-edit',
          reason: '乙稿删除了这条注释，甲稿仍作了修改',
          chapterId: '',
          anchorLabel: conflictLabelFor(base, baseChapters),
          kind: base.kind,
          localAnnotation: clone(localOne),
          deletedSide: 'incoming',
          keepAnnotation: clone(localOne),
          keepProvenance: 'local'
        });
        const { annotation, migrated } = relocatedAnnotation(localOne, 'local');
        pushAccepted('local', annotation, migrated, {
          id, tone: 'conflict', label: `待裁决：乙删甲改 · ${annotation.title}`, detail: annotation.body
        });
      } else {
        changes.push({ id, tone: 'delete', label: `乙稿删除注释 · ${base.title}`, detail: base.body.slice(0, 60) });
      }
      continue;
    }
    if (incomingOne && !localOne) {
      if (!sameAnnotationContent(incomingOne, base)) {
        conflicts.push({
          id: nextConflictId(),
          type: 'delete-vs-edit',
          reason: '甲稿删除了这条注释，乙稿仍作了修改',
          chapterId: '',
          anchorLabel: conflictLabelFor(base, baseChapters),
          kind: base.kind,
          incomingAnnotation: clone({ ...incomingOne, id: finalId }),
          deletedSide: 'local',
          keepAnnotation: clone({ ...incomingOne, id: finalId }),
          keepProvenance: 'incoming'
        });
        const { annotation, migrated } = relocatedAnnotation({ ...incomingOne, id: finalId }, 'incoming');
        pushAccepted('incoming', annotation, migrated, {
          id: finalId, tone: 'conflict', label: `待裁决：甲删乙改 · ${annotation.title}`, detail: annotation.body
        });
      } else {
        changes.push({ id, tone: 'delete', label: `甲稿删除注释 · ${base.title}`, detail: base.body.slice(0, 60) });
      }
      continue;
    }
    if (!localOne || !incomingOne) continue;

    // 两边都在：内容都没变 → 沿用（仍做锚点重定位）
    const localEdited = !sameAnnotationContent(localOne, base);
    const incomingEdited = !sameAnnotationContent(incomingOne, base);
    if (!localEdited && !incomingEdited) {
      const { annotation, migrated, migrateReason } = relocatedAnnotation(localOne, 'local');
      pushAccepted('local', annotation, migrated, {
        id, tone: 'carry',
        label: `唯一匹配，沿用 · ${annotation.title}`,
        detail: migrateReason ?? annotation.body
      });
      continue;
    }
    if (localEdited && !incomingEdited) {
      const { annotation, migrated, migrateReason } = relocatedAnnotation(localOne, 'local');
      pushAccepted('local', annotation, migrated, {
        id, tone: 'local', label: `采用甲稿修改 · ${annotation.title}`, detail: migrateReason ?? annotation.body
      });
      continue;
    }
    if (incomingEdited && !localEdited) {
      const { annotation, migrated, migrateReason } = relocatedAnnotation({ ...incomingOne, id: finalId }, 'incoming');
      pushAccepted('incoming', annotation, migrated, {
        id: finalId, tone: 'incoming', label: `采用乙稿修改 · ${annotation.title}`, detail: migrateReason ?? annotation.body
      });
      continue;
    }

    // 两边都改
    const refsDiffer = refsKey(localOne) !== refsKey(incomingOne);
    if (sameAnnotationContent(localOne, incomingOne)) {
      const { annotation, migrated, migrateReason } = relocatedAnnotation(localOne, 'local');
      pushAccepted('local', annotation, migrated, {
        id, tone: 'carry', label: `两边修改一致 · ${annotation.title}`, detail: migrateReason ?? annotation.body
      });
      continue;
    }
    const conflictId = nextConflictId();
    const parallelId = id === finalId ? ensureIdUnique(`${id}-乙`, usedIds) : finalId;
    if (parallelId !== id) idRewrites.push([id, parallelId]);
    const relocatedLocal = relocatedAnnotation(localOne, 'local');
    const relocatedIncoming = relocatedAnnotation({ ...incomingOne, id: parallelId }, 'incoming');
    conflicts.push({
      id: conflictId,
      type: 'annotation',
      reason: refsDiffer
        ? '同一条注释两边都有修改，且互见关系不同，并列保留待人工选择'
        : '同一条注释两边都有修改，并列保留待人工选择',
      chapterId: '',
      anchorLabel: conflictLabelFor(base, baseChapters),
      kind: base.kind,
      localAnnotation: relocatedLocal.annotation,
      incomingAnnotation: relocatedIncoming.annotation
    });
    pushAccepted('local', relocatedLocal.annotation, relocatedLocal.migrated, {
      id, tone: 'conflict', label: `待裁决（甲稿）· ${relocatedLocal.annotation.title}`, detail: relocatedLocal.migrateReason ?? relocatedLocal.annotation.body
    });
    pushAccepted('incoming', relocatedIncoming.annotation, relocatedIncoming.migrated, {
      id: parallelId, tone: 'conflict', label: `待裁决（乙稿）· ${relocatedIncoming.annotation.title}`, detail: relocatedIncoming.migrateReason ?? relocatedIncoming.annotation.body
    });
  }

  const incomingLabel = incoming.title || '乙稿';
  return {
    baseSnapshotId: baseSnapshot.id,
    baseLabel: baseSnapshot.label,
    source: options.source ?? 'import',
    generatedAt: new Date().toISOString(),
    incomingTitle: incomingLabel,
    baseChapters,
    localChapters,
    incomingChapters,
    incomingSnapshots: clone(incoming.snapshots),
    mergedChapters,
    sentenceStates,
    accepted,
    conflicts,
    changes,
    idRewrites
  };
}

function unresolvedConflicts(plan: MergePlan, resolutions: Record<string, MergeResolution>) {
  return plan.conflicts.filter((conflict) => !resolutions[conflict.id]);
}

/** 根据人工确认结果产出最终合并稿；有未决项或锚点失效则抛错（由调用方回滚） */
export function finalizeMerge(
  plan: MergePlan,
  resolutions: Record<string, MergeResolution>,
  meta: { local: TextDocument; incoming: TextDocument }
): TextDocument {
  const pending = unresolvedConflicts(plan, resolutions);
  if (pending.length) {
    throw new MergeValidationError(`仍有 ${pending.length} 处并列内容未选择，未写入当前稿`);
  }

  const chapters: Chapter[] = clone(plan.mergedChapters);
  const sentenceIndex = buildSentenceIndex(chapters);

  // 句子正文冲突：按选择切换正文，并以所选侧 token 重新编号
  for (const conflict of plan.conflicts.filter((item) => item.type === 'sentence-text')) {
    const choice = resolutions[conflict.id];
    assert(choice === 'local' || choice === 'incoming', '句子正文冲突必须选择甲稿或乙稿');
    const target = sentenceIndex.byId.get(conflict.sentenceId!);
    assert(target, '冲突句子在合并正文中找不到，已取消合并');
    const sourceSide = choice === 'local' ? plan.localChapters : plan.incomingChapters;
    const source = findSentence(sourceSide, conflict.sentenceId!);
    assert(source, '所选版本正文缺失，已取消合并');
    target.sentence.text = source.sentence.text;
    target.sentence.tokens = tokenizeText(source.sentence.text, target.sentence.id, source.sentence.tokens);
  }

  const kept: { annotation: Annotation; provenance: MergeSide }[] = [];

  for (const conflict of plan.conflicts) {
    const choice = resolutions[conflict.id];
    if (conflict.type === 'sentence-text') continue;
    if (conflict.type === 'delete-vs-edit') {
      if (choice === 'delete') continue;
      kept.push({ annotation: clone(conflict.keepAnnotation!), provenance: conflict.keepProvenance ?? 'local' });
      continue;
    }
    if (choice === 'local') {
      if (conflict.localAnnotation) kept.push({ annotation: clone(conflict.localAnnotation), provenance: 'local' });
    } else if (choice === 'incoming') {
      if (conflict.incomingAnnotation) kept.push({ annotation: clone(conflict.incomingAnnotation), provenance: 'incoming' });
    } else if (choice === 'both') {
      if (conflict.localAnnotation) kept.push({ annotation: clone(conflict.localAnnotation), provenance: 'local' });
      if (conflict.incomingAnnotation) kept.push({ annotation: clone(conflict.incomingAnnotation), provenance: 'incoming' });
    } else {
      throw new MergeValidationError('存在未选择的并列注释，已取消合并');
    }
  }

  // 无冲突直接采纳的注释
  for (const item of plan.accepted) {
    const relatedConflict = plan.conflicts.find(
      (conflict) =>
        conflict.type !== 'sentence-text' &&
        ((conflict.localAnnotation?.id === item.annotation.id && item.provenance === 'local') ||
          (conflict.incomingAnnotation?.id === item.annotation.id && item.provenance === 'incoming'))
    );
    if (relatedConflict) continue; // 冲突项已按 resolutions 处理
    kept.push({ annotation: clone(item.annotation), provenance: item.provenance });
  }

  // 去重（并列保留时撞号已经改写；这里再兜底）
  const seen = new Set<string>();
  const deduped: Annotation[] = [];
  for (const entry of kept) {
    if (seen.has(entry.annotation.id)) continue;
    seen.add(entry.annotation.id);
    deduped.push(entry.annotation);
  }

  // 记录每个最终注释来自哪一边（决定互见 id 改写作用域）
  const provenanceById = new Map<string, MergeSide>();
  for (const entry of kept) provenanceById.set(entry.annotation.id, entry.provenance);

  // 句子正文切换为乙稿后，原词级锚点按共同快照重新定位；原词消失则迁到句子
  const baseIndexFinal = buildSentenceIndex(plan.baseChapters);
  const finalIndex = buildSentenceIndex(chapters);
  for (const annotation of deduped) {
    if (annotation.anchorType === 'chapter') {
      if (!chapters.some((chapter) => chapter.id === annotation.anchorId)) {
        throw new MergeValidationError('章节级注释找不到章节，已取消合并');
      }
      continue;
    }
    if (annotation.anchorType === 'word') {
      let found = false;
      for (const chapter of chapters) {
        for (const sentence of chapter.sentences) {
          if (sentence.tokens.some((token) => token.id === annotation.anchorId)) {
            found = true;
            break;
          }
        }
      }
      if (found) continue;

      // 最终正文里找不到原 token：按快照在所属句里重新定位
      let baseSentence: Sentence | undefined;
      for (const chapter of plan.baseChapters) {
        for (const sentence of chapter.sentences) {
          if (sentence.tokens.some((token) => token.id === annotation.anchorId)) {
            baseSentence = sentence;
            break;
          }
        }
      }
      const targetSentence = baseSentence ? finalIndex.byId.get(baseSentence.id)?.sentence : undefined;
      if (!baseSentence || !targetSentence) {
        throw new MergeValidationError(`注释「${annotation.title}」的词语锚点无法定位，已取消合并`);
      }
      const relocated = relocateTokenAnchor({
        baseSentence: baseIndexFinal.byId.get(baseSentence.id)!.sentence,
        targetSentence,
        tokenId: annotation.anchorId
      });
      annotation.anchorId = relocated.anchorId;
      annotation.anchorType = relocated.anchorType;
      if (relocated.anchorType === 'sentence' && !annotation.title.endsWith('（引用已随校改迁移）')) {
        annotation.title = `${annotation.title}（引用已随校改迁移）`;
      }
      continue;
    }
    if (!finalIndex.byId.has(annotation.anchorId)) {
      throw new MergeValidationError(`注释「${annotation.title}」的句子锚点失效，已取消合并`);
    }
  }

  // 互见引用：只改写乙稿注释里的撞号 id；清除悬空引用
  const rewriteMap = new Map(plan.idRewrites);
  const validIds = new Set(deduped.map((item) => item.id));
  for (const annotation of deduped) {
    annotation.references = Array.from(
      new Set(
        annotation.references
          .map((ref) => (provenanceById.get(annotation.id) === 'incoming' ? rewriteMap.get(ref) ?? ref : ref))
          .filter((ref) => validIds.has(ref))
      )
    );
  }

  deduped.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));

  // 快照列表取并集（按 id）
  const snapshotIds = new Set(meta.local.snapshots.map((item) => item.id));
  const snapshots = [...meta.local.snapshots];
  for (const snapshot of meta.incoming.snapshots) {
    if (!snapshotIds.has(snapshot.id)) snapshots.push(clone(snapshot));
  }

  return {
    id: meta.local.id,
    title: meta.local.title,
    author: meta.local.author,
    edition: meta.local.edition,
    chapters,
    annotations: deduped,
    snapshots,
    updatedAt: new Date().toISOString()
  };
}

export function autoResolutionsForTabSync(plan: MergePlan): Record<string, MergeResolution> {
  // 后保存的标签页：句子正文以先保存者为准；注释两边都改并列保留；删除冲突保留修改方
  const resolutions: Record<string, MergeResolution> = {};
  for (const conflict of plan.conflicts) {
    if (conflict.type === 'sentence-text') resolutions[conflict.id] = 'incoming';
    else if (conflict.type === 'delete-vs-edit') resolutions[conflict.id] = 'keep';
    else resolutions[conflict.id] = 'both';
  }
  return resolutions;
}

export function createConfirmedMerge(
  document: TextDocument,
  plan: MergePlan,
  resolutions: Record<string, MergeResolution>,
  backup: { workspace: WorkspaceState; review: MergeReview | null }
): ConfirmedMerge {
  return {
    id: `confirmed-${Date.now().toString(36)}`,
    appliedAt: new Date().toISOString(),
    source: plan.source,
    changeCount: plan.changes.length,
    conflictCount: plan.conflicts.length,
    migratedCount: plan.accepted.filter((item) => item.migratedToSentence).length,
    document: clone(document),
    backup: { workspace: clone(backup.workspace), review: backup.review ? clone(backup.review) : null }
  };
}

export { unresolvedConflicts };
