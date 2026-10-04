import type { ConfirmedMerge, DraftEnvelope, MergeReview, WorkspaceState } from './types';

export const DRAFT_KEY = 'sologsb-1022/public-text-annotator/v2/draft';
export const REVIEW_KEY = 'sologsb-1022/public-text-annotator/v2/merge-review';
export const CONFIRMED_KEY = 'sologsb-1022/public-text-annotator/v2/confirmed-merge';
/** 兼容首版直接存 WorkspaceState 的旧键 */
export const LEGACY_DRAFT_KEY = 'sologsb-1022/public-text-annotator/v1';

export function readEnvelope(): { envelope: DraftEnvelope | null; legacy: WorkspaceState | null } {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DraftEnvelope;
      if (parsed.v === 2 && parsed.workspace?.document?.chapters?.length) {
        return { envelope: parsed, legacy: null };
      }
    }
  } catch {
    // 落到旧键
  }
  try {
    const raw = localStorage.getItem(LEGACY_DRAFT_KEY);
    if (raw) {
      const legacy = JSON.parse(raw) as WorkspaceState;
      if (legacy.document?.chapters?.length) return { envelope: null, legacy };
    }
  } catch {
    // 损坏的草稿交给调用方提示
  }
  return { envelope: null, legacy: null };
}

export function writeEnvelope(workspace: WorkspaceState, revision: number): DraftEnvelope {
  const envelope: DraftEnvelope = {
    v: 2,
    revision,
    savedAt: new Date().toISOString(),
    workspace
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(envelope));
  // 旧键保留一份，避免回退版本读到空白
  localStorage.setItem(LEGACY_DRAFT_KEY, JSON.stringify(workspace));
  return envelope;
}

export function readReview(): MergeReview | null {
  try {
    const raw = localStorage.getItem(REVIEW_KEY);
    return raw ? (JSON.parse(raw) as MergeReview) : null;
  } catch {
    return null;
  }
}

export function writeReview(review: MergeReview | null) {
  if (review) localStorage.setItem(REVIEW_KEY, JSON.stringify(review));
  else localStorage.removeItem(REVIEW_KEY);
}

export function readConfirmed(): ConfirmedMerge | null {
  try {
    const raw = localStorage.getItem(CONFIRMED_KEY);
    return raw ? (JSON.parse(raw) as ConfirmedMerge) : null;
  } catch {
    return null;
  }
}

export function writeConfirmed(confirmed: ConfirmedMerge | null) {
  if (confirmed) localStorage.setItem(CONFIRMED_KEY, JSON.stringify(confirmed));
  else localStorage.removeItem(CONFIRMED_KEY);
}
