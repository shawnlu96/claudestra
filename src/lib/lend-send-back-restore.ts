/**
 * What a card gets back when its write lease ends without the peer's work: the assignee before lending (when the card still names
 * the peer's worker) and, for a write order sent back to local work, the auto-start pin on that peer. PM reclaim (ledger-lend.ts)
 * uses the assignee half only; sendBack uses both. Pure: callers apply the patch in their own transaction.
 */
import type { WriteLease } from "./ledger-lend-lease.js";
import type { LedgerTask } from "./ledger-stages.js";

export interface LeaseRestore {
  /** setTask patch: `agent` alone for a local agent, `assigneeKind` / `assignee` otherwise (as PM reclaim always wrote it) */
  patch: Record<string, unknown>;
  restored: { assigneeKind: string | null; assignee: string | null } | null;
  unpinned: string | null;
}

/** `unpinPeer`: the peer the order could not reach; extra.placement equal to `peer:<it>` is dropped, every other extra key kept as is. */
export function leaseRestore(task: Pick<LedgerTask, "assigneeKind" | "assignee" | "extra">, lease: WriteLease | null, unpinPeer?: string):
  LeaseRestore | null {
  const back = !!lease && task.assigneeKind === "peer_agent" && !!task.assignee?.startsWith(`${lease.fp}/`);
  const pin = unpinPeer !== undefined && task.extra.placement === `peer:${unpinPeer}`;
  if (!back && !pin) return null;
  const patch: Record<string, unknown> = {};
  if (back) Object.assign(patch, lease!.prevAssigneeKind === "agent" ? { agent: lease!.prevAssignee }
    : { assigneeKind: lease!.prevAssigneeKind, assignee: lease!.prevAssignee });
  if (pin) patch.extra = Object.fromEntries(Object.entries(task.extra).filter(([k]) => k !== "placement"));
  return { patch, restored: back ? { assigneeKind: lease!.prevAssigneeKind, assignee: lease!.prevAssignee } : null,
    unpinned: pin ? `peer:${unpinPeer}` : null };
}
