/** Derived feature states the backend currently emits; `state` stays a plain string so a newer backend's state never breaks an older page. */
export const PRODUCT_FEATURE_STATES = ['done', 'run', 'blocked', 'stale', 'ready', 'gate', 'wait'] as const;
export type ProductFeatureState = (typeof PRODUCT_FEATURE_STATES)[number];
/** A next-up node: sinceMs is when its card entered the current stage (compare with the response's now); member is a peer name or the local label. */
export interface ProductFrontierItem {
  key: string; taskId: string | null; title: string; stage: string | null; round: number; member: string | null; sinceMs: number | null;
}

export interface ProductFeature {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'done' | 'dropped';
  hasDag: boolean;
  version: number;
  /** activeUnknown: true = active is a placeholder the source could not know; absent = active is a real count (0 is a real 0). */
  counts: { total: number; completed: number; active: number; blocked?: number; ready?: number; deferred?: number; waiting?: number; activeUnknown?: true };
  eta: { at: number | null; done?: boolean; basis?: { cpHours?: number } } | null;
  cards?: { id: string; title: string; stage: string }[];
  /** Optional: absent from older backends and from the team view. Unknown state strings mean "no state" (see knownFeatureState). */
  state?: string;
  complete?: boolean;
  frontier?: ProductFrontierItem[];
  lastActivityAt?: number | null;
}
export interface ProductBoard {
  features: ProductFeature[];
  deps: { from: string; to: string; note: string }[];
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const strOrNull = (v: unknown) => v === null || typeof v === 'string';
const absentOr = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);

export const knownFeatureState = (v: unknown): ProductFeatureState | null =>
  (PRODUCT_FEATURE_STATES as readonly unknown[]).includes(v) ? (v as ProductFeatureState) : null;

const frontierItem = (i: unknown) => record(i) && typeof i.key === 'string' && strOrNull(i.taskId) && typeof i.title === 'string'
  && strOrNull(i.stage) && count(i.round) && strOrNull(i.member) && (i.sinceMs === null || count(i.sinceMs));

/** PDSTATE1 fields are optional, but when present they must be well-formed. */
function derivedFieldsOk(f: Record<string, unknown>, counts: Record<string, unknown>, eta: unknown): boolean {
  return absentOr(counts.waiting, count) && absentOr(f.state, (v) => typeof v === 'string') && absentOr(f.complete, (v) => typeof v === 'boolean')
    && absentOr(f.frontier, (v) => Array.isArray(v) && v.every(frontierItem)) && absentOr(f.lastActivityAt, (v) => v === null || count(v))
    && (!record(eta) || (absentOr(eta.done, (v) => typeof v === 'boolean') && absentOr(eta.basis, (b) => record(b) && absentOr(b.cpHours, count))));
}

/** Reject incomplete successful bodies before rendering; missing fields cannot safely enter the product layout. */
export function assertProductBoard(v: unknown): asserts v is ProductBoard {
  if (!record(v) || !Array.isArray(v.features) || !Array.isArray(v.deps)) throw new Error('Invalid product board');
  const ids = new Set<string>();
  for (const f of v.features) {
    if (!record(f) || typeof f.id !== 'string' || !f.id || ids.has(f.id) || typeof f.title !== 'string'
      || !['active', 'paused', 'done', 'dropped'].includes(String(f.status)) || typeof f.hasDag !== 'boolean'
      || !count(f.version) || !record(f.counts) || !count(f.counts.total) || !count(f.counts.completed) || !count(f.counts.active)
      || (f.hasDag && !count(f.counts.blocked)) || !(f.counts.activeUnknown === undefined || f.counts.activeUnknown === true)
      || !(f.eta === null || (record(f.eta) && (f.eta.at === null || count(f.eta.at))))
      || !derivedFieldsOk(f, f.counts, f.eta)) throw new Error('Invalid product feature');
    if (!f.hasDag && !Array.isArray(f.cards)) throw new Error('Missing feature cards');
    if (f.cards !== undefined && (!Array.isArray(f.cards) || f.cards.some(c =>
      !record(c) || typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.stage !== 'string'))) throw new Error('Invalid feature cards');
    ids.add(f.id);
  }
  if (v.deps.some(d => !record(d) || typeof d.from !== 'string' || typeof d.to !== 'string' || typeof d.note !== 'string')) {
    throw new Error('Invalid product dependencies');
  }
}
