import type { FeatureDetail, FeatureList } from '../../../lib/api/shared-ledger';
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
export function sharedProductBoard(list: FeatureList, now: number, tasks?: readonly LedgerTaskView[], details?: ReadonlyMap<string, FeatureDetail>): ProductBoard {
  return { features: list.features.map(f => {
    const found = tasks?.filter(t => t.itemId === f.id);
    // 真实源按详情可用性判断：中心 total=0 也不能证明详情已读到；完整空详情的 0 则是已知值。
    const mine = found && (details ? details.has(f.id) : found.length > 0 || f.counts.total === 0) ? found : undefined;
    if (found && !mine) console.warn(`[team] feature ${f.id} 没有卡（详情没读到）：完成数按中心 counts，在跑未知`);
    return { id: f.id, title: f.title,
      status: f.status === 'done' && !stale(f, now) && f.counts.missing === 0 ? 'done' : 'active',
      hasDag: f.version > 0, cards: [], version: f.version, counts: { total: f.counts.total,
        completed: mine ? completedOf(f, mine.filter(t => SETTLED.has(t.stage)).length) : found ? f.counts.completed : progress(f, now),
        active: mine ? mine.filter(t => !IDLE.has(t.stage)).length : 0, blocked: f.counts.blocked,
        ...(!mine ? { activeUnknown: true as const } : {}) }, eta: null };
  }), deps: [] };
}
