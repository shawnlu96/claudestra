/** Shared snapshots expose current nodes and version number, but no historical snapshots or version metadata. */
import type { FeatureList, FeatureDetail as SharedDetail } from '@/lib/api/shared-ledger';
import type { BoardNode, DagBoard, FeatureCard, FeatureCounts, FeatureDetail } from './dag/dag-types';
import type { TeamOverview } from './team-source-adapter';
import { looksLikeId, stageOf } from './team-source-adapter';
import { teamStepLine } from './team-source-steps';

/**
 * 节点算出来的进度和中心 Feature.counts（refreshFeatureState：绑定的执行镜像里 done / verified 才算完成）交叉核对：
 * 对不上以中心为准并 warn（中心是全队同一份）；在跑 / 未开始只有节点知道，照节点的。
 */
const nodeCounts = (nodes: readonly BoardNode[]): FeatureCounts => ({ total: nodes.length, done: nodes.filter(n => n.phase === 'done').length,
  active: nodes.filter(n => n.phase === 'active').length, idle: nodes.filter(n => n.phase === 'idle').length,
  missing: nodes.filter(n => n.missing).length });

export function checkedCounts(f: FeatureList['features'][number], nodes: readonly BoardNode[]): FeatureCounts {
  const mine = nodeCounts(nodes);
  const center = f.counts;
  if (mine.total === center.total && mine.done === center.completed && mine.missing === center.missing) return mine;
  console.warn(`[team] feature ${f.id} 节点进度与中心 counts 不一致，以中心为准：节点 ${mine.done}/${mine.total} 缺 ${mine.missing}，`
    + `中心 ${center.completed}/${center.total} 缺 ${center.missing}`);
  return { ...mine, total: center.total, done: center.completed, missing: center.missing };
}

/**
 * 详情没读到（读失败、也没有缓存）：节点画不出来，但中心 counts 照样可信——总数 / 完成 / 缺失用中心的，不因读失败变 0；
 * 在跑 / 未开始只有详情里的节点知道，这里不知道：FeatureCounts 还表示不了未知（team-parity-Bc1 加标记），先明确 warn
 */
export function centerCounts(f: FeatureList['features'][number]): FeatureCounts {
  console.warn(`[team] feature ${f.id} 详情没读到：总数 / 完成 / 缺失按中心 counts，在跑 / 未开始未知`);
  return { total: f.counts.total, done: f.counts.completed, active: 0, idle: 0, missing: f.counts.missing };
}

export function teamDagBoard(project: string, list: FeatureList, details: ReadonlyMap<string, SharedDetail>, team: TeamOverview): DagBoard {
  const features: FeatureCard[] = list.features.map(f => {
    const d = details.get(f.id);
    const ids = new Map([...team.index].filter(([, at]) => at.featureId === f.id && at.key).map(([id, at]) => [at.key!, id]));
    const displayKey = (key: string) => looksLikeId(key) ? ids.get(key) ?? '节点' : key;
    const nodes: BoardNode[] = (d?.dag.nodes ?? []).map(n => {
      const taskId = ids.get(n.key) ?? null;
      const bound = d?.dag.bindings.find(b => b.nodeKey === n.key);
      const task = bound ? d?.tasks.find(t => t.taskId === bound.taskId) : undefined;
      const status = task ? stageOf(task.stage) : 'planned';
      const phase = status === 'done' || status === 'verified' ? 'done' : status === 'planned' ? 'idle' : 'active';
      const view = team.ov.tasks.find(t => t.id === taskId);
      const stepLine = task ? teamStepLine(task.steps, stageOf(task.stage)) : null;
      return { key: displayKey(n.key), taskId: task ? taskId : null,
        oneLine: looksLikeId(n.oneLine) ? view?.title ?? '暂无' : n.oneLine, deps: n.deps.map(displayKey), estimate: n.estimate,
        fileGlobs: n.fileGlobs, inheritedFrom: null, status, statusAtVersion: null, title: view?.title ?? null,
        satisfied: phase === 'done', ready: !view?.blockedBy?.length, missing: !!bound && !task, phase,
        round: null, handler: null, stepLine, since: null, pr: view?.pr ?? null, branch: null };
    });
    return { id: f.id, title: f.title, status: f.status === 'done' ? 'done' : 'active', ownerWords: f.description,
      currentVersion: f.version, version: null, pending: null, lastActivityAt: f.updatedAt,
      counts: d ? checkedCounts(f, nodes) : centerCounts(f), nodes };
  });
  return { ok: true, project, exists: true, now: team.ov.now, asOfSeq: list.serverSeq, features, agents: [] };
}

export function teamDagFeature(board: DagBoard, id: string, version?: number | 'pending'): FeatureDetail {
  const f = board.features.find(f => f.id === id);
  if (!f) throw new Error('Shared feature not found');
  if (version !== undefined && version !== f.currentVersion) throw new Error('Shared historical snapshots are unavailable');
  const { nodes, ...feature } = f;
  void nodes; // Only the board carries current nodes; historical snapshot metadata is absent from the shared contract.
  return { ok: true, project: board.project, now: board.now, feature, versions: [], snapshot: null };
}
