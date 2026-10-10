import type { FeatureDetail, FeatureList } from '../../../lib/api/shared-ledger';
import type { LedgerTaskView } from '../collab-model';
import type { ProductBoard } from '../../../lib/api/product-board';
import { progress, stale } from '../shared/shared-model';
import { rowsOf, stageOf } from '../team-source-adapter';
import { deferredLine, productNodeCounts } from '../../../lib/product-node-counts';

const SETTLED = new Set(['done', 'verified', 'cancelled']);
const IDLE = new Set(['done', 'verified', 'spec', 'cancelled']);

/** 卡算出来的完成数和中心 Feature.counts.completed 交叉核对：对不上以中心为准并 warn（中心按绑定的执行镜像算，全队同一份） */
function completedOf(f: FeatureList['features'][number], mine: number): number {
  if (mine === f.counts.completed) return mine;
  console.warn(`[team] feature ${f.id} 卡算出的完成数 ${mine} 与中心 counts.completed ${f.counts.completed} 不一致，以中心为准`);
  return f.counts.completed;
}

/** 当前 DAG 的节点行按本机 nodeCounts 同一个纯函数计数；没绑到节点的游离卡（没有节点键的行）不计 */
function nodeCountsOf(d: FeatureDetail) {
  const bound = new Map(d.dag.bindings.map(b => [b.nodeKey, b.taskId]));
  return productNodeCounts(rowsOf(d).flatMap(r => r.key === null ? [] : [{ key: r.key, deferred: deferredLine(r.title),
    taskId: bound.get(r.key) ?? null, stage: r.task ? stageOf(r.task.stage) : null, deps: r.deps }]));
}

/** Task-backed progress uses the same stages as the sidebar, including stale snapshots; absence of updates does not undo completion.
 * With tasks, completion is cross-checked against the center's counts (center wins) and active comes from the mirrored stages.
 * With a DAG detail, completed / active / blocked use the same node counts as the local board (team-project-N8B1).
 * The shared contract has no feature dependency edges or ETA; never derive them from task dependencies. */
export function sharedProductBoard(list: FeatureList, now: number, tasks?: readonly LedgerTaskView[], details?: ReadonlyMap<string, FeatureDetail>): ProductBoard {
  return { features: list.features.map(f => {
    const found = tasks?.filter(t => t.itemId === f.id);
    // 真实源按详情可用性判断：中心 total=0 也不能证明详情已读到；完整空详情的 0 则是已知值。
    const mine = found && (details ? details.has(f.id) : found.length > 0 || f.counts.total === 0) ? found : undefined;
    if (found && !mine) console.warn(`[team] feature ${f.id} 没有卡（详情没读到）：完成数按中心 counts，在跑未知`);
    const d = mine && f.version > 0 ? details?.get(f.id) : undefined, nodes = d ? nodeCountsOf(d) : undefined;
    return { id: f.id, title: f.title,
      status: f.status === 'done' && !stale(f, now) && f.counts.missing === 0 ? 'done' : 'active',
      hasDag: f.version > 0, cards: [], version: f.version, counts: { total: f.counts.total,
        completed: mine ? completedOf(f, nodes ? nodes.completed : mine.filter(t => SETTLED.has(t.stage)).length) : found ? f.counts.completed : progress(f, now),
        active: nodes ? nodes.active : mine ? mine.filter(t => !IDLE.has(t.stage)).length : 0, blocked: nodes ? nodes.blocked : f.counts.blocked,
        ...(!mine ? { activeUnknown: true as const } : {}) }, eta: null };
  }), deps: [] };
}
