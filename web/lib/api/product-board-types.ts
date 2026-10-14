/**
 * Derived feature states; `state` stays a plain string so a newer backend's state never breaks an older page.
 * paused / frozen come from PDSTATE2 — older backends never send them.
 */
export const PRODUCT_FEATURE_STATES = ['done', 'run', 'blocked', 'stale', 'ready', 'gate', 'wait', 'paused', 'frozen'] as const;
export type ProductFeatureState = (typeof PRODUCT_FEATURE_STATES)[number];
/** A next-up node: sinceMs is when its card entered the current stage (compare with the response's now); member is a peer name or the local label. */
export interface ProductFrontierItem {
  key: string; taskId: string | null; title: string; stage: string | null; round: number; member: string | null; sinceMs: number | null;
  /** PDSTATE2: the node sits on the freeze list */
  frozen?: true;
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
  /** PDSTATE2 area id (see ProductBoard.areas); null / unknown id = ungrouped */
  area?: string | null;
}
/** Hand copies of TaskEvidence / LockEvidence in src/lib/ledger-product-board-edges.ts (not a twin, same as PDSTATE1). */
export interface ProductTaskEvidence { from: string; to: string; fromStage: string; toStage: string; satisfied: boolean }
export interface ProductLockEvidence { node: string; wanted: string; held: string; holder: string; since: number }
/** feature_deps rows; kind / satisfied / count / evidence come from PDEDGE1 and are absent on older backends. */
export interface ProductDep {
  from: string; to: string; note: string;
  kind?: 'split' | 'declared'; satisfied?: boolean; count?: number; evidence?: unknown[];
}
/** Derived cross-feature edges (PDEDGE1): task dependencies and file-lock contention. */
export interface ProductLink {
  from: string; to: string; note: string; kind: 'task' | 'lock'; satisfied: boolean; count: number;
  evidence: (ProductTaskEvidence | ProductLockEvidence)[];
}
export interface ProductArea { id: string; name: string }
export interface ProductBoard {
  features: ProductFeature[];
  deps: ProductDep[];
  links?: ProductLink[];
  areas?: ProductArea[];
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const strOrNull = (v: unknown) => v === null || typeof v === 'string';
const absentOr = (v: unknown, ok: (v: unknown) => boolean) => v === undefined || ok(v);

export const knownFeatureState = (v: unknown): ProductFeatureState | null =>
  (PRODUCT_FEATURE_STATES as readonly unknown[]).includes(v) ? (v as ProductFeatureState) : null;

const frontierItem = (i: unknown) => record(i) && typeof i.key === 'string' && strOrNull(i.taskId) && typeof i.title === 'string'
  && strOrNull(i.stage) && count(i.round) && strOrNull(i.member) && (i.sinceMs === null || count(i.sinceMs)) && absentOr(i.frozen, (v) => v === true);
const bool = (v: unknown) => typeof v === 'boolean';
const depOk = (d: unknown) => record(d) && typeof d.from === 'string' && typeof d.to === 'string' && typeof d.note === 'string'
  && absentOr(d.satisfied, bool) && absentOr(d.count, count) && absentOr(d.evidence, Array.isArray);
const str = (v: unknown) => typeof v === 'string';
const strs = (r: Record<string, unknown>, keys: string[]) => keys.every(k => str(r[k]));
/** Evidence is checked per kind (same fields as edges.ts TaskEvidence / LockEvidence); an unknown kind is ignored later, so its evidence is not inspected. */
const EVIDENCE_OK: Record<string, (e: unknown) => boolean> = {
  task: (e) => record(e) && strs(e, ['from', 'to', 'fromStage', 'toStage']) && bool(e.satisfied),
  lock: (e) => record(e) && strs(e, ['node', 'wanted', 'held', 'holder']) && count(e.since),
};
const linkOk = (l: unknown) => record(l) && typeof l.from === 'string' && typeof l.to === 'string' && typeof l.note === 'string'
  && typeof l.kind === 'string' && bool(l.satisfied) && count(l.count) && Array.isArray(l.evidence)
  && (!Object.hasOwn(EVIDENCE_OK, l.kind) || l.evidence.every(EVIDENCE_OK[l.kind]));
const areasOk = (a: unknown) => Array.isArray(a) && a.every(x => record(x) && typeof x.id === 'string' && typeof x.name === 'string')
  && new Set(a.map(x => (x as { id: string }).id)).size === a.length;

/** PDSTATE1 fields are optional, but when present they must be well-formed. */
function derivedFieldsOk(f: Record<string, unknown>, counts: Record<string, unknown>, eta: unknown): boolean {
  return absentOr(counts.waiting, count) && absentOr(f.state, (v) => typeof v === 'string') && absentOr(f.complete, (v) => typeof v === 'boolean')
    && absentOr(f.frontier, (v) => Array.isArray(v) && v.every(frontierItem)) && absentOr(f.lastActivityAt, (v) => v === null || count(v))
    && absentOr(f.area, strOrNull)
    && (!record(eta) || (absentOr(eta.done, (v) => typeof v === 'boolean') && absentOr(eta.basis, (b) => record(b) && absentOr(b.cpHours, count))));
}

/**
 * links / areas are optional extras an older backend never sends: a malformed one is dropped (one warning) instead of failing
 * the whole board. Links of an unknown kind are ignored.
 */
function dropBadExtras(v: Record<string, unknown>) {
  const bad = [...(v.links !== undefined && !(Array.isArray(v.links) && v.links.every(linkOk)) ? ['links'] : []),
    ...(v.areas !== undefined && !areasOk(v.areas) ? ['areas'] : [])];
  for (const k of bad) delete v[k];
  if (bad.length) console.warn(`[product] dropped malformed ${bad.join(', ')}`);
  if (Array.isArray(v.links)) v.links = v.links.filter(l => l.kind === 'task' || l.kind === 'lock');
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
  if (!v.deps.every(depOk)) throw new Error('Invalid product dependencies');
  dropBadExtras(v);
}
