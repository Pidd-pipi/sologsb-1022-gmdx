export type ViewMode = 'reading' | 'editing' | 'critical';
export type AnchorType = 'chapter' | 'sentence' | 'word';
export type AnnotationKind = 'footnote' | 'variant' | 'background' | 'crossref';
export type AnnotationStatus = 'open' | 'resolved';

export interface TextToken {
  id: string;
  text: string;
}

export interface Sentence {
  id: string;
  order: number;
  text: string;
  tokens: TextToken[];
}

export interface Chapter {
  id: string;
  order: number;
  title: string;
  summary: string;
  sentences: Sentence[];
}

export interface Annotation {
  id: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  title: string;
  body: string;
  source: string;
  references: string[];
  status: AnnotationStatus;
  tags: string[];
  conflictState: 'open' | 'resolved';
  conflictResolution?: string;
  updatedAt: string;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  note: string;
  createdAt: string;
  chapters: Chapter[];
  annotations: Annotation[];
}

export interface TextDocument {
  id: string;
  title: string;
  author: string;
  edition: string;
  chapters: Chapter[];
  annotations: Annotation[];
  snapshots: VersionSnapshot[];
  updatedAt: string;
}

export interface WorkspaceState {
  document: TextDocument;
  mode: ViewMode;
  selectedChapterId: string;
  selectedSentenceId: string;
  selectedAnnotationId: string | null;
  query: string;
  dirty: boolean;
}

export interface EditorState {
  workspace: WorkspaceState;
  past: WorkspaceState[];
  future: WorkspaceState[];
  lastAction: string;
}

export interface SearchResult {
  chapterId: string;
  sentenceId?: string;
  annotationId?: string;
  title: string;
  excerpt: string;
  kind: 'text' | 'annotation';
}

export interface ConflictGroup {
  key: string;
  anchorId: string;
  anchorType: AnchorType;
  kind: AnnotationKind;
  anchorLabel: string;
  annotations: Annotation[];
}

export type MergeSide = 'local' | 'incoming';
export type MergeResolution = 'local' | 'incoming' | 'both' | 'keep' | 'delete';

export interface MergeChange {
  id: string;
  tone: 'carry' | 'local' | 'incoming' | 'add-local' | 'add-incoming' | 'migrate' | 'delete' | 'conflict';
  label: string;
  detail: string;
}

export interface MergeConflict {
  id: string;
  type: 'annotation' | 'sentence-text' | 'delete-vs-edit' | 'same-id-different';
  reason: string;
  chapterId: string;
  sentenceId?: string;
  anchorLabel: string;
  kind?: AnnotationKind;
  localAnnotation?: Annotation;
  incomingAnnotation?: Annotation;
  localText?: string;
  incomingText?: string;
  keepAnnotation?: Annotation;
  keepProvenance?: MergeSide;
  deletedSide?: MergeSide;
}

export interface SentenceMergeState {
  chapterId: string;
  sentenceId: string;
  baseText: string;
  localText: string;
  incomingText: string;
  status: 'same' | 'local' | 'incoming' | 'conflict' | 'local-only' | 'incoming-only';
  conflictId?: string;
}

export interface AcceptedAnnotation {
  provenance: MergeSide;
  annotation: Annotation;
  migratedToSentence: boolean;
  change: MergeChange;
}

export interface MergePlan {
  baseSnapshotId: string;
  baseLabel: string;
  source: 'import' | 'tabsync';
  generatedAt: string;
  incomingTitle: string;
  baseChapters: Chapter[];
  localChapters: Chapter[];
  incomingChapters: Chapter[];
  incomingSnapshots: VersionSnapshot[];
  mergedChapters: Chapter[];
  sentenceStates: SentenceMergeState[];
  accepted: AcceptedAnnotation[];
  conflicts: MergeConflict[];
  changes: MergeChange[];
  idRewrites: [string, string][];
}

export interface MergeReview {
  plan: MergePlan;
  resolutions: Record<string, MergeResolution>;
}

export interface ConfirmedMerge {
  id: string;
  appliedAt: string;
  source: MergePlan['source'];
  changeCount: number;
  conflictCount: number;
  migratedCount: number;
  document: TextDocument;
  backup: { workspace: WorkspaceState; review: MergeReview | null };
}

export interface DraftEnvelope {
  v: 2;
  revision: number;
  savedAt: string;
  workspace: WorkspaceState;
}
