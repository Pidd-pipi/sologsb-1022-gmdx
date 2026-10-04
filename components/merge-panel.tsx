'use client';

import {
  Button,
  Card,
  CardBody,
  Chip,
  ScrollShadow,
  Select,
  SelectItem
} from '@heroui/react';
import {
  AlertTriangle,
  Check,
  FileJson,
  GitMerge,
  History,
  RotateCcw,
  Upload,
  X
} from 'lucide-react';
import { useRef, useState } from 'react';
import { kindLabel } from '@/lib/editor';
import { MergeValidationError, buildMergePlan } from '@/lib/merge';
import type {
  ConfirmedMerge,
  MergeConflict,
  MergePlan,
  MergeResolution,
  MergeReview,
  TextDocument
} from '@/lib/types';

interface MergePanelProps {
  document: TextDocument;
  snapshots: TextDocument['snapshots'];
  review: MergeReview | null;
  confirmed: ConfirmedMerge | null;
  notice: string;
  onStart: (plan: MergePlan) => void;
  onResolve: (conflictId: string, resolution: MergeResolution) => void;
  onConfirm: () => void;
  onRollback: () => void;
  onDiscard: () => void;
}

function parseIncomingDraft(raw: string): TextDocument {
  const parsed = JSON.parse(raw) as Partial<TextDocument>;
  if (!parsed || !Array.isArray(parsed.chapters) || !Array.isArray(parsed.annotations)) {
    throw new MergeValidationError('文件不是有效的草稿 JSON：缺少 chapters 或 annotations');
  }
  for (const chapter of parsed.chapters) {
    if (!chapter.id || !Array.isArray(chapter.sentences)) {
      throw new MergeValidationError('草稿章节结构不完整');
    }
    for (const sentence of chapter.sentences) {
      if (!sentence.id || typeof sentence.text !== 'string') {
        throw new MergeValidationError('草稿句子结构不完整');
      }
      if (!Array.isArray(sentence.tokens) || !sentence.tokens.length) {
        throw new MergeValidationError(`「${sentence.text.slice(0, 12)}」缺少词语数据，无法重新定位`);
      }
    }
  }
  return parsed as TextDocument;
}

const toneChip: Record<string, { color: 'default' | 'primary' | 'success' | 'warning' | 'danger'; text: string }> = {
  carry: { color: 'default', text: '沿用' },
  local: { color: 'primary', text: '甲稿' },
  incoming: { color: 'success', text: '乙稿' },
  'add-local': { color: 'primary', text: '甲增' },
  'add-incoming': { color: 'success', text: '乙增' },
  migrate: { color: 'warning', text: '迁移' },
  delete: { color: 'danger', text: '删除' },
  conflict: { color: 'danger', text: '待决' }
};

function AnnotationCompareCard({
  annotation,
  badge,
  badgeColor
}: {
  annotation: MergeConflict['localAnnotation'];
  badge: string;
  badgeColor: 'primary' | 'success';
}) {
  if (!annotation) return null;
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <Chip size="sm" color={badgeColor} variant="flat">{badge}</Chip>
        <span className="text-xs text-stone-500">{annotation.source} · {kindLabel(annotation.kind)}</span>
      </div>
      <h5 className="mt-2 text-sm font-semibold text-stone-900">{annotation.title}</h5>
      <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-stone-600">{annotation.body}</p>
      {annotation.references.length ? (
        <p className="mt-2 text-[11px] text-stone-500">互见：{annotation.references.join('、')}</p>
      ) : null}
      <p className="mt-1 text-[11px] text-stone-400">
        {annotation.anchorType === 'word' ? '词级引用' : annotation.anchorType === 'sentence' ? '句级引用' : '章节引用'} · {annotation.id}
      </p>
    </div>
  );
}

function ConflictCard({
  conflict,
  resolution,
  onResolve
}: {
  conflict: MergeConflict;
  resolution?: MergeResolution;
  onResolve: (value: MergeResolution) => void;
}) {
  const isSentence = conflict.type === 'sentence-text';
  const isDelete = conflict.type === 'delete-vs-edit';
  const options: { value: MergeResolution; label: string; color: 'primary' | 'success' | 'warning' | 'danger' }[] = isSentence
    ? [
        { value: 'local', label: '采用甲稿正文', color: 'primary' },
        { value: 'incoming', label: '采用乙稿正文', color: 'success' }
      ]
    : isDelete
      ? [
          { value: 'keep', label: '保留注释', color: 'primary' },
          { value: 'delete', label: '随对方删除', color: 'danger' }
        ]
      : [
          { value: 'local', label: '只用甲稿', color: 'primary' },
          { value: 'incoming', label: '只用乙稿', color: 'success' },
          { value: 'both', label: '并列保留两条', color: 'warning' }
        ];

  return (
    <Card shadow="none" className={`border ${resolution ? 'border-amber-200 bg-amber-50/40' : 'border-red-200'}`}>
      <CardBody className="gap-3 p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {conflict.kind ? <Chip size="sm" variant="flat">{kindLabel(conflict.kind)}</Chip> : null}
              <span className="text-xs text-stone-500">{conflict.anchorLabel}</span>
            </div>
            <p className="mt-1 text-xs leading-5 text-stone-600">{conflict.reason}</p>
          </div>
        </div>

        {isSentence ? (
          <div className="grid gap-2">
            <div className={`rounded-lg border p-3 ${resolution === 'local' ? 'border-primary bg-primary-50' : 'border-stone-200 bg-stone-50'}`}>
              <b className="text-xs text-stone-700">甲稿正文</b>
              <p className="mt-1 font-serif text-sm leading-7 text-stone-800">{conflict.localText}</p>
            </div>
            <div className={`rounded-lg border p-3 ${resolution === 'incoming' ? 'border-success bg-success-50' : 'border-stone-200 bg-stone-50'}`}>
              <b className="text-xs text-stone-700">乙稿正文</b>
              <p className="mt-1 font-serif text-sm leading-7 text-stone-800">{conflict.incomingText}</p>
            </div>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <AnnotationCompareCard annotation={conflict.localAnnotation} badge="甲稿" badgeColor="primary" />
            <AnnotationCompareCard annotation={conflict.incomingAnnotation} badge="乙稿" badgeColor="success" />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={resolution === option.value ? 'solid' : 'flat'}
              color={option.color}
              onPress={() => onResolve(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

export function MergePanel({
  document,
  snapshots,
  review,
  confirmed,
  notice,
  onStart,
  onResolve,
  onConfirm,
  onRollback,
  onDiscard
}: MergePanelProps) {
  const [baseSnapshotId, setBaseSnapshotId] = useState(snapshots[0]?.id ?? 'snapshot-base');
  const [incomingText, setIncomingText] = useState<TextDocument | null>(null);
  const [incomingName, setIncomingName] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const plan = review?.plan ?? null;
  const resolutions = review?.resolutions ?? {};
  const unresolved = plan ? plan.conflicts.filter((item) => !resolutions[item.id]).length : 0;

  function handleFile(file: File | undefined) {
    if (!file) return;
    setIncomingName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const incoming = parseIncomingDraft(String(reader.result ?? ''));
        setIncomingText(incoming);
        setError('');
      } catch (cause) {
        setIncomingText(null);
        setError(cause instanceof Error ? cause.message : '无法解析该文件');
      }
    };
    reader.onerror = () => setError('读取文件失败');
    reader.readAsText(file);
  }

  function startMerge(source: MergePlan['source'] = 'import') {
    setError('');
    try {
      const baseSnapshot = document.snapshots.find((item) => item.id === baseSnapshotId);
      if (!baseSnapshot) {
        setError('当前稿里没有共同校订快照，无法离线合并');
        return;
      }
      if (!incomingText && source === 'import') {
        setError('请先导入另一台机器的草稿 JSON');
        return;
      }
      const plan = buildMergePlan({
        baseSnapshot,
        local: document,
        incoming: incomingText as TextDocument,
        source
      });
      onStart(plan);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '合并准备失败，原草稿未改动');
    }
  }

  return (
    <ScrollShadow className="max-h-[calc(100vh-210px)]">
      <div className="space-y-4 pr-1">
        {notice ? (
          <div className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">{notice}</div>
        ) : null}
        {error ? (
          <div className="rounded-xl bg-red-50 px-3 py-2 text-xs leading-5 text-red-800">合并未执行：{error}</div>
        ) : null}

        {!plan ? (
          <>
            <div className="rounded-xl bg-stone-100 p-3 text-xs leading-5 text-stone-600">
              两台机器基于<b>同一份校订快照</b>分别校勘。回来后导入乙稿导出的 JSON，系统按快照重新定位句子和词语：
              唯一对上的注释沿用，原词消失则迁到所属句；同一条注释两边都改或互见关系不同时并列保留，全部裁决后才写入当前稿。
            </div>

            <div className="rounded-xl border border-stone-200 p-3">
              <h3 className="flex items-center gap-2 font-semibold text-stone-900">
                <GitMerge className="h-4 w-4" />离线合并草稿
              </h3>
              <Select
                className="mt-3"
                size="sm"
                label="共同校订快照（基准）"
                selectedKeys={new Set([baseSnapshotId])}
                onSelectionChange={(keys) => setBaseSnapshotId(String(Array.from(keys)[0] ?? ''))}
              >
                {snapshots.map((snapshot) => (
                  <SelectItem key={snapshot.id}>{snapshot.label}</SelectItem>
                ))}
              </Select>

              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label="选择乙稿 JSON"
                onChange={(event) => handleFile(event.target.files?.[0])}
              />
              <Button
                className="mt-3 w-full"
                size="sm"
                variant="flat"
                startContent={<Upload className="h-4 w-4" />}
                onPress={() => fileRef.current?.click()}
              >
                {incomingName ? `已选择：${incomingName}` : '导入乙稿 JSON'}
              </Button>
              {incomingText ? (
                <p className="mt-2 text-[11px] leading-5 text-stone-500">
                  乙稿：{incomingText.title} · {incomingText.chapters.length} 章 · {incomingText.annotations.length} 条注释
                </p>
              ) : null}

              <Button
                className="mt-2 w-full"
                size="sm"
                color="primary"
                startContent={<GitMerge className="h-4 w-4" />}
                isDisabled={!incomingText}
                onPress={() => startMerge('import')}
              >
                按快照重新定位并试合并
              </Button>
              <p className="mt-2 flex items-center gap-1 text-[11px] text-stone-500">
                <FileJson className="h-3 w-3" />乙稿可在其本机“版本”标签页导出 JSON。
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-stone-200 p-3 text-xs leading-5 text-stone-600">
              <div className="flex items-center justify-between">
                <b className="text-sm text-stone-800">
                  {plan.source === 'tabsync' ? '多标签页保存合并' : `与乙稿「${plan.incomingTitle}」合并`}
                </b>
                <Chip size="sm" color={unresolved ? 'danger' : 'success'} variant="flat">
                  {unresolved ? `${unresolved} 处待裁决` : '全部已裁决'}
                </Chip>
              </div>
              <p className="mt-2">基准快照：{plan.baseLabel}</p>
              <p>自动沿用 {plan.changes.filter((item) => item.tone === 'carry').length} 条，
                迁移 {plan.accepted.filter((item) => item.migratedToSentence).length} 条，
                并列待决 {plan.conflicts.length} 处。</p>
            </div>

            {plan.conflicts.length ? (
              <div className="space-y-3">
                <h4 className="text-sm font-semibold text-stone-900">并列保留 · 逐条选择</h4>
                {plan.conflicts.map((conflict) => (
                  <ConflictCard
                    key={conflict.id}
                    conflict={conflict}
                    resolution={resolutions[conflict.id]}
                    onResolve={(value) => onResolve(conflict.id, value)}
                  />
                ))}
              </div>
            ) : (
              <div className="grid place-items-center rounded-xl border border-dashed border-green-200 bg-green-50 p-6 text-center">
                <Check className="h-7 w-7 text-green-600" />
                <p className="mt-2 text-sm font-medium text-green-800">没有冲突，可直接写入当前稿</p>
              </div>
            )}

            <div className="rounded-xl border border-stone-200">
              <div className="border-b border-stone-100 px-3 py-2 text-xs font-semibold text-stone-600">
                自动处理明细（{plan.changes.length}）
              </div>
              <div className="max-h-60 space-y-1.5 overflow-y-auto p-2">
                {plan.changes.map((change, index) => {
                  const chip = toneChip[change.tone] ?? toneChip.carry;
                  return (
                    <div key={`${change.id}-${index}`} className="rounded-lg bg-stone-50 p-2">
                      <div className="flex items-center gap-2">
                        <Chip size="sm" color={chip.color} variant="flat">{chip.text}</Chip>
                        <span className="text-[11px] font-semibold text-stone-700">{change.label}</span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-stone-500">{change.detail}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                color="primary"
                className="flex-1"
                startContent={<Check className="h-4 w-4" />}
                isDisabled={unresolved > 0}
                onPress={onConfirm}
              >
                {unresolved ? `还有 ${unresolved} 处未选择` : '确认并写入当前稿'}
              </Button>
              <Button size="sm" variant="light" startContent={<X className="h-4 w-4" />} onPress={onDiscard}>
                放弃
              </Button>
            </div>
          </>
        )}

        {confirmed ? (
          <div className="rounded-xl border border-green-200 bg-green-50 p-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-green-800">
              <History className="h-4 w-4" />当前确认结果
            </h3>
            <p className="mt-1 text-xs leading-5 text-green-700">
              {new Date(confirmed.appliedAt).toLocaleString('zh-CN')} 写入；
              {confirmed.changeCount} 项变化、{confirmed.conflictCount} 处裁决、
              {confirmed.migratedCount} 条迁移。合并、恢复和导出都读取这份结果。
            </p>
            <Button
              className="mt-2"
              size="sm"
              variant="flat"
              color="warning"
              startContent={<RotateCcw className="h-4 w-4" />}
              onPress={onRollback}
            >
              合并失败/退回：恢复原草稿与待处理项
            </Button>
          </div>
        ) : null}
      </div>
    </ScrollShadow>
  );
}
