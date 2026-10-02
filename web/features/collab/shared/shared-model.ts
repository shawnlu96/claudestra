import type { Command, Feature, FeatureDetail, PlanNode } from '../../../lib/api/shared-ledger';
import type { BoardNode, FeatureCard } from '../dag/dag-types';
export const stale = (f: Feature, now: number) => f.projection !== null && now - f.projection.observedAt > 30_000;
export function progress(f: Feature, now: number): number {
  return stale(f, now) ? 0 : Math.max(0, Math.min(f.counts.completed, f.counts.total - f.counts.missing));
}
export interface Draft { base: FeatureDetail; nodes: PlanNode[]; reason: string; latest: FeatureDetail | null }
export const makeDraft = (base: FeatureDetail): Draft => ({ base, nodes: structuredClone(base.dag.nodes), reason: '', latest: null });
export function rewrite(d: Draft, requestId: string = crypto.randomUUID()): Command {
  if (d.latest) throw new Error('conflict_requires_reread');
  const bound = new Set(d.base.dag.bindings.map(b => b.nodeKey));
  for (const n of d.base.dag.nodes.filter(n => bound.has(n.key))) {
    if (JSON.stringify(n) !== JSON.stringify(d.nodes.find(x => x.key === n.key))) throw new Error('bound_node_locked');
  }
  if (!d.reason.trim()) throw new Error('reason_required');
  const keys = new Set(d.nodes.map(n => n.key));
  if (keys.size !== d.nodes.length || d.nodes.some(n => !n.key.trim() || !n.oneLine.trim() || !n.fileGlobs.length)) throw new Error('invalid_nodes');
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error('cyclic_dependencies');
    if (done.has(key)) return;
    visiting.add(key);
    for (const dep of d.nodes.find(n => n.key === key)?.deps ?? []) {
      if (!keys.has(dep)) throw new Error('missing_dependency');
      visit(dep);
    }
    visiting.delete(key); done.add(key);
  };
  for (const key of keys) visit(key);
  const f = d.base.feature;
  return { type: d.base.dag.version ? 'dag.rewrite' : 'dag.init', requestId, projectId: f.projectId, featureId: f.id,
    expectedRev: f.rev, baseVersion: d.base.dag.version, nodes: d.nodes, reason: d.reason };
}
/** Re-reading deliberately retains editable work; newly bound nodes must come from the latest graph. */
export function rebaseDraft(d: Draft, latest: FeatureDetail): Draft {
  const bound = new Set(latest.dag.bindings.map(b => b.nodeKey));
  return { base: latest, latest: null, reason: d.reason,
    nodes: [...d.nodes.map(n => bound.has(n.key) ? latest.dag.nodes.find(x => x.key === n.key)! : n),
      ...latest.dag.nodes.filter(n => bound.has(n.key) && !d.nodes.some(x => x.key === n.key))] };
}
export function boardFeature(detail: FeatureDetail, now: number): FeatureCard {
  const f = detail.feature, expired = stale(f, now);
  const nodes: BoardNode[] = detail.dag.nodes.map(n => {
    const binding = detail.dag.bindings.find(b => b.nodeKey === n.key);
    const task = detail.tasks.find(t => t.taskId === binding?.taskId);
    const missing = !!binding && (!task || expired);
    const satisfied = !!task && task.stage === 'done' && !missing;
    return { ...n, taskId: binding?.taskId ?? null, inheritedFrom: null, status: missing ? null : task?.stage ?? 'planned',
      statusAtVersion: null, title: task?.specSummary ?? null, satisfied, ready: false, missing,
      phase: satisfied ? 'done' : task && !missing ? 'active' : 'idle', round: null, handler: null, stepLine: null,
      since: null, pr: task?.pr ? `#${task.pr}` : null, branch: task?.head ?? null };
  });
  return { id: f.id, title: f.title, status: f.status === 'done' && !expired && !f.counts.missing ? 'done' : 'active',
    ownerWords: f.description, currentVersion: detail.dag.version, version: null, pending: null,
    counts: { total: nodes.length, done: nodes.filter(n => n.satisfied).length, active: nodes.filter(n => n.phase === 'active').length,
      idle: nodes.filter(n => n.phase === 'idle').length, missing: nodes.filter(n => n.missing).length },
    lastActivityAt: f.updatedAt, nodes };
}
