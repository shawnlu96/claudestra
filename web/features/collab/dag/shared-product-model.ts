import type { FeatureList } from '../../../lib/api/shared-ledger';
import type { LedgerTaskView } from '../collab-model';
import type { ProductBoard } from '../../../lib/api/product-board';
import { progress, stale } from '../shared/shared-model';

/** Task-backed progress uses the same stages as the sidebar, including stale snapshots; absence of updates does not undo completion.
 * The shared contract has no feature dependency edges or ETA; never derive them from task dependencies. */
export function sharedProductBoard(list: FeatureList, now: number, tasks?: readonly LedgerTaskView[]): ProductBoard {
  return { features: list.features.map(f => ({ id: f.id, title: f.title,
    status: f.status === 'done' && !stale(f, now) && f.counts.missing === 0 ? 'done' : 'active',
    hasDag: f.version > 0, cards: [], version: f.version, counts: { total: f.counts.total,
      completed: tasks ? tasks.filter(t => t.itemId === f.id && (t.stage === 'done' || t.stage === 'verified')).length : progress(f, now),
      active: 0, blocked: f.counts.blocked }, eta: null })), deps: [] };
}
