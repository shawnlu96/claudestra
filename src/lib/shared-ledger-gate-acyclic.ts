import type { DagNode } from "./ledger-feature.js";
import { LedgerError } from "./ledger-store.js";

/** 依赖只能指向同一版里的节点、不许自环、不许成环（Kahn：剩下排不出去的就在环上） */
export function checkAcyclic(nodes: readonly DagNode[]): void {
  const indeg = new Map(nodes.map((n) => [n.key, n.deps.length]));
  const out = new Map<string, string[]>();
  for (const n of nodes) for (const d of n.deps) out.set(d, [...(out.get(d) ?? []), n.key]);
  const queue = nodes.filter((n) => n.deps.length === 0).map((n) => n.key);
  for (let i = 0; i < queue.length; i++) {
    for (const next of out.get(queue[i]) ?? []) {
      const left = (indeg.get(next) as number) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (queue.length < nodes.length) throw new LedgerError("invalid", `节点依赖成环：${nodes.filter((n) => !queue.includes(n.key)).map((n) => n.key).join(", ")}`);
}
