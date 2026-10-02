import type { FeatureList } from '../../../lib/api/shared-ledger';
import type { ProductBoard } from '../../../lib/api/product-board';
import { progress, stale } from '../shared/shared-model';

/** The shared contract has no feature dependency edges or ETA; never derive them from task dependencies. */
export function sharedProductBoard(list: FeatureList, now: number): ProductBoard {
  return { features: list.features.map(f => ({ id: f.id, title: f.title,
    status: f.status === 'done' && !stale(f, now) && f.counts.missing === 0 ? 'done' : 'active',
    hasDag: true, version: f.version, counts: { total: f.counts.total, completed: progress(f, now),
      active: 0, blocked: f.counts.blocked }, eta: null })), deps: [] };
}
