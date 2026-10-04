import type { FeatureList } from '../../../lib/api/shared-ledger';
import type { LedgerTaskView } from '../collab-model';
import type { ProductBoard } from '../../../lib/api/product-board';
import { progress, stale } from '../shared/shared-model';

const SETTLED = new Set(['done', 'verified']);
const IDLE = new Set(['done', 'verified', 'spec', 'cancelled']);

/** 卡算出来的完成数和中心 Feature.counts.completed 交叉核对：对不上以中心为准并 warn（中心按绑定的执行镜像算，全队同一份） */
function completedOf(f: FeatureList['features'][number], mine: number): number {
  if (mine === f.counts.completed) return mine;
  console.warn(`[team] feature ${f.id} 卡算出的完成数 ${mine} 与中心 counts.completed ${f.counts.completed} 不一致，以中心为准`);
  return f.counts.completed;
}

/** Task-backed progress uses the same stages as the sidebar, including stale snapshots; absence of updates does not undo completion.
 * With tasks, completion is cross-checked against the center's counts (center wins) and active comes from the mirrored stages.
 * The shared contract has no feature dependency edges or ETA; never derive them from task dependencies. */
export function sharedProductBoard(list: FeatureList, now: number, tasks?: readonly LedgerTaskView[]): ProductBoard {
  return { features: list.features.map(f => {
    const mine = tasks?.filter(t => t.itemId === f.id);
    return { id: f.id, title: f.title,
      status: f.status === 'done' && !stale(f, now) && f.counts.missing === 0 ? 'done' : 'active',
      hasDag: f.version > 0, cards: [], version: f.version, counts: { total: f.counts.total,
        completed: mine ? completedOf(f, mine.filter(t => SETTLED.has(t.stage)).length) : progress(f, now),
        active: mine ? mine.filter(t => !IDLE.has(t.stage)).length : 0, blocked: f.counts.blocked }, eta: null };
  }), deps: [] };
}
