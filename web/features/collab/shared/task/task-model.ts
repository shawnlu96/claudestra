/** Browser-side V2 task editor. The central contract is checked again by X12 before any write. */
export interface Capability { enabled: boolean; code: string | null; reason: string }
export type TaskCapability = 'task.new' | 'task.set' | 'task.spec';
export type TaskCapabilities = Record<TaskCapability, Capability>;
export interface TaskSpec {
  summary: string; originalDigest: string; sharedDigest: string | null; artifactId: string | null;
  visibility: 'home_only' | 'approved_copy'; repositoryPath: string | null; commit: string | null;
}
export interface TaskCard {
  id: string; featureId: string; title: string; plan: string; kind: 'code' | 'investigate' | 'ops';
  stage: string; rev: number; specRev: number; homeInstanceId: string; executorInstanceId: string | null;
  spec: TaskSpec; updatedAt: number;
}
export interface TaskScope {
  teamId: string; projectId: string; serviceGeneration: number; epoch: number; bootId: string;
}
export interface FeatureAnchor { id: string; rev: number; homeInstanceId: string; authorityMode: 'source' | 'planning' | 'execution' }
export interface CreateDraft {
  kind: 'create'; feature: FeatureAnchor; itemId: string | null; title: string; plan: string;
  repository: string; taskKind: 'code' | 'investigate' | 'ops';
}
export interface EditDraft {
  kind: 'edit'; base: TaskCard; title: string; plan: string; specSummary: string; reason: string;
}
export type TaskDraft = CreateDraft | EditDraft;
export interface TaskConflict { currentRev: number; latest: FeatureAnchor | TaskCard | null }
export interface TaskEditorState { draft: TaskDraft; phase: 'idle' | 'submitting' | 'conflict' | 'rejected' | 'saved'; conflict: TaskConflict | null }

const CREATE_KEYS = ['kind', 'feature', 'itemId', 'title', 'plan', 'repository', 'taskKind'];
const EDIT_KEYS = ['kind', 'base', 'title', 'plan', 'specSummary', 'reason'];
const exactly = (value: object, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key)) &&
  keys.every(key => Object.hasOwn(value, key));
const required = (ok: boolean, code: string): void => { if (!ok) throw new Error(code); };
const validDigest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

export function createDraft(feature: FeatureAnchor, repository: string): CreateDraft {
  return { kind: 'create', feature, itemId: null, title: '', plan: '', repository, taskKind: 'code' };
}
export function editDraft(task: TaskCard): EditDraft {
  return { kind: 'edit', base: task, title: task.title, plan: task.plan, specSummary: task.spec.summary, reason: '' };
}
export const beginEditor = (draft: TaskDraft): TaskEditorState => ({ draft, phase: 'idle', conflict: null });
export function changeDraft(state: TaskEditorState, draft: TaskDraft): TaskEditorState {
  required(state.draft.kind === draft.kind, 'draft_kind_changed');
  return { ...state, draft, phase: state.phase === 'rejected' ? 'idle' : state.phase };
}
export function markConflict(state: TaskEditorState, conflict: TaskConflict): TaskEditorState {
  return { ...state, phase: 'conflict', conflict }; // Keep every unsaved field for explicit review.
}
export function refreshConflict(state: TaskEditorState): TaskEditorState {
  required(state.phase === 'conflict' && !!state.conflict?.latest, 'latest_required');
  const latest = state.conflict!.latest!;
  const draft = state.draft.kind === 'create'
    ? { ...state.draft, feature: latest as FeatureAnchor }
    : { ...state.draft, base: latest as TaskCard };
  return { draft, phase: 'idle', conflict: null };
}
export function canSubmit(state: TaskEditorState, capabilities: TaskCapabilities): boolean {
  if (state.phase === 'submitting' || state.phase === 'conflict' || state.phase === 'saved') return false;
  const draft = state.draft;
  if (draft.kind === 'create') return draft.feature.authorityMode === 'execution' && capabilities['task.new'].enabled &&
    !!draft.title.trim() && /^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(draft.repository);
  const inFlight = draft.base.stage !== 'spec';
  if (inFlight) return capabilities['task.spec'].enabled && draft.title === draft.base.title && draft.plan === draft.base.plan &&
    !!draft.reason.trim() && draft.specSummary !== draft.base.spec.summary;
  return capabilities['task.set'].enabled && (draft.title !== draft.base.title || draft.plan !== draft.base.plan) && !!draft.title.trim();
}

/** Construct an exact command body. Extra draft keys and all execution fields are refused. */
export function taskCommand(state: TaskEditorState, capabilities: TaskCapabilities, scope: TaskScope,
  digest: string, requestId: string) {
  required(canSubmit(state, capabilities), 'task_action_disabled');
  required(validDigest(digest) && validId(requestId), 'invalid_command_input');
  const draft = state.draft;
  required(exactly(draft, draft.kind === 'create' ? CREATE_KEYS : EDIT_KEYS), 'forbidden_field');
  if (draft.kind === 'create') {
    const spec: TaskSpec = { summary: draft.plan, originalDigest: digest, sharedDigest: null, artifactId: null,
      visibility: 'home_only', repositoryPath: null, commit: null };
    return { ...scope, requestId, type: 'task.new' as const, payload: { featureId: draft.feature.id,
      expectedRev: draft.feature.rev, itemId: draft.itemId, title: draft.title.trim(), plan: draft.plan,
      kind: draft.taskKind, repository: draft.repository, spec } };
  }
  const base = draft.base, version = { taskId: base.id, expectedRev: base.rev, expectedSpecRev: base.specRev };
  if (base.stage !== 'spec') {
    required(draft.title === base.title && draft.plan === base.plan, 'forbidden_field');
    return { ...scope, requestId, type: 'task.spec' as const, payload: { ...version,
      nextSpecRev: base.specRev + 1, spec: { ...base.spec, summary: draft.specSummary,
        originalDigest: digest, sharedDigest: null, artifactId: null, visibility: 'home_only' as const,
        repositoryPath: null, commit: null }, reason: draft.reason.trim() } };
  }
  required(draft.specSummary === base.spec.summary && !draft.reason, 'forbidden_field');
  const patch: { title?: string; plan?: string } = {};
  if (draft.title !== base.title) patch.title = draft.title.trim();
  if (draft.plan !== base.plan) patch.plan = draft.plan;
  return { ...scope, requestId, type: 'task.set' as const, payload: { ...version, patch } };
}

export function digestText(draft: TaskDraft): string {
  return draft.kind === 'create' ? draft.plan : draft.base.stage === 'spec' ? draft.plan : draft.specSummary;
}
export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const instanceLabel = (id: string | null, names: Readonly<Record<string, string>>): string =>
  id === null ? '—' : names[id] ?? id;
export const dataExpiry = (observedAt: number | null, ttlMs = 30_000): number | null =>
  observedAt === null ? null : observedAt + ttlMs;
export const isDataStale = (observedAt: number | null, now: number, ttlMs = 30_000): boolean =>
  observedAt === null || now >= observedAt + ttlMs;
