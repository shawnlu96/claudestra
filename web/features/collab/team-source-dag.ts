/** Shared snapshots expose current nodes and version number, but no historical snapshots or version metadata. */
import type { FeatureList, FeatureDetail as SharedDetail } from '@/lib/api/shared-ledger';
import type { BoardNode, DagBoard, FeatureCard, FeatureDetail } from './dag/dag-types';
import type { TeamOverview } from './team-source-adapter';
import { looksLikeId, stageOf } from './team-source-adapter';

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
      return { key: displayKey(n.key), taskId: task ? taskId : null,
        oneLine: looksLikeId(n.oneLine) ? view?.title ?? '暂无' : n.oneLine, deps: n.deps.map(displayKey), estimate: n.estimate,
        fileGlobs: n.fileGlobs, inheritedFrom: null, status, statusAtVersion: null, title: view?.title ?? null,
        satisfied: phase === 'done', ready: !view?.blockedBy?.length, missing: !!bound && !task, phase,
        round: null, handler: null, stepLine: null, since: null, pr: view?.pr ?? null, branch: null };
    });
    return { id: f.id, title: f.title, status: f.status === 'done' ? 'done' : 'active', ownerWords: f.description,
      currentVersion: f.version, version: null, pending: null, lastActivityAt: f.updatedAt,
      counts: { total: nodes.length, done: nodes.filter(n => n.phase === 'done').length,
        active: nodes.filter(n => n.phase === 'active').length, idle: nodes.filter(n => n.phase === 'idle').length,
        missing: nodes.filter(n => n.missing).length }, nodes };
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
