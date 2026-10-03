import type { FeatureDetail, PlanNode } from '../../../lib/api/shared-ledger';
import type { Draft } from './shared-model';
export interface NodeConflict { key: string; mine: PlanNode | null; latest: PlanNode | null; locked: boolean }
const equal = (a: PlanNode | undefined | null, b: PlanNode | undefined | null) =>
  JSON.stringify(a ? [a.key, a.oneLine, a.deps, a.fileGlobs, a.estimate] : null) ===
  JSON.stringify(b ? [b.key, b.oneLine, b.deps, b.fileGlobs, b.estimate] : null);
/** Start from the latest graph so a full rewrite never silently removes a teammate's new node. */
export function rebaseDraft(d: Draft, latest: FeatureDetail): Draft {
  const base = new Map(d.base.dag.nodes.map(n => [n.key, n]));
  const mine = new Map(d.nodes.map(n => [n.key, n]));
  const incoming = new Map(latest.dag.nodes.map(n => [n.key, n]));
  const unresolved = new Map(d.conflicts.map(c => [c.key, c]));
  for (const c of unresolved.values()) {
    if (c.mine) mine.set(c.key, c.mine); else mine.delete(c.key);
  }
  const bound = new Set(latest.dag.bindings.map(b => b.nodeKey));
  const nodes = structuredClone(latest.dag.nodes), conflicts: NodeConflict[] = [];
  for (const key of new Set([...base.keys(), ...mine.keys(), ...unresolved.keys()])) {
    const old = base.get(key), own = mine.get(key), next = incoming.get(key);
    if (equal(old, own) && !unresolved.has(key)) continue;
    if (unresolved.has(key) || bound.has(key) || !equal(old, next)) {
      // Concurrent deletions agree; other overlaps require an explicit choice, including newly bound nodes.
      if (!own && !next && !unresolved.has(key)) continue;
      conflicts.push({ key, mine: own ? structuredClone(own) : null, latest: next ? structuredClone(next) : null, locked: bound.has(key) });
    } else {
      const index = nodes.findIndex(n => n.key === key);
      if (index >= 0) nodes.splice(index, 1);
      if (own) nodes.splice(index < 0 ? nodes.length : index, 0, structuredClone(own));
    }
  }
  return { base: latest, latest: null, reason: d.reason, nodes, conflicts };
}
export function resolveNodeConflict(d: Draft, key: string, choice: 'mine' | 'latest'): Draft {
  const conflict = d.conflicts.find(c => c.key === key);
  if (!conflict) return d;
  if (conflict.locked && choice === 'mine') throw new Error('bound_node_locked');
  const selected = conflict[choice], nodes = structuredClone(d.nodes);
  const index = nodes.findIndex(n => n.key === key);
  if (index >= 0) nodes.splice(index, 1);
  if (selected) nodes.splice(index < 0 ? nodes.length : index, 0, structuredClone(selected));
  return { ...d, nodes, conflicts: d.conflicts.filter(c => c.key !== key) };
}
