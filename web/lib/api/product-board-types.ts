export interface ProductFeature {
  id: string;
  title: string;
  status: 'active' | 'paused' | 'done' | 'dropped';
  hasDag: boolean;
  version: number;
  /** activeUnknown: true = active is a placeholder the source could not know; absent = active is a real count (0 is a real 0). */
  counts: { total: number; completed: number; active: number; blocked?: number; ready?: number; deferred?: number; activeUnknown?: true };
  eta: { at: number | null } | null;
  cards?: { id: string; title: string; stage: string }[];
}
export interface ProductBoard {
  features: ProductFeature[];
  deps: { from: string; to: string; note: string }[];
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Reject incomplete successful bodies before rendering; missing fields cannot safely enter the product layout. */
export function assertProductBoard(v: unknown): asserts v is ProductBoard {
  if (!record(v) || !Array.isArray(v.features) || !Array.isArray(v.deps)) throw new Error('Invalid product board');
  const ids = new Set<string>();
  for (const f of v.features) {
    if (!record(f) || typeof f.id !== 'string' || !f.id || ids.has(f.id) || typeof f.title !== 'string'
      || !['active', 'paused', 'done', 'dropped'].includes(String(f.status)) || typeof f.hasDag !== 'boolean'
      || !count(f.version) || !record(f.counts) || !count(f.counts.total) || !count(f.counts.completed) || !count(f.counts.active)
      || (f.hasDag && !count(f.counts.blocked)) || !(f.counts.activeUnknown === undefined || f.counts.activeUnknown === true)
      || !(f.eta === null || (record(f.eta) && (f.eta.at === null || count(f.eta.at))))) throw new Error('Invalid product feature');
    if (!f.hasDag && !Array.isArray(f.cards)) throw new Error('Missing feature cards');
    if (f.cards !== undefined && (!Array.isArray(f.cards) || f.cards.some(c =>
      !record(c) || typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.stage !== 'string'))) throw new Error('Invalid feature cards');
    ids.add(f.id);
  }
  if (v.deps.some(d => !record(d) || typeof d.from !== 'string' || typeof d.to !== 'string' || typeof d.note !== 'string')) {
    throw new Error('Invalid product dependencies');
  }
}
