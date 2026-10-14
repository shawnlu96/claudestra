/**
 * dispatch-recovery-PEERLEASE1 · the peer author handover's head reconciliation (recovery-peer-lease-handover.ts). A lender's `release
 * stopped` (or clean cancel ack) proves its worker stopped, not that its work is on the ledger: a worker that pushed past the last
 * delivery and then stopped leaves the result unknown, and the PM reclaim only cancels the order. The local author's worktree starts
 * from task.headSHA, so the lease's branch on the remote must stand exactly there — the same condition the restricted reclaim
 * (lend-reclaim-scheduler.ts) checks before it ends a lease. Unreadable or drifted = wait for PM; the handover never guesses.
 * Only a lease whose every write order never had a worker started (never claimed / `not_started`) needs no read: nothing was pushed.
 * Under on, a block is recorded once per exact session / lease generation / head (HEAD_BLOCK_OP, recovery-peer-lease-handover.ts
 * applyHeadBlock): it moves the task rev, so the plan made on the snapshot that dropped the old row is refused, and from then on
 * handoverCheck refuses the handover — the old row is planned on again and the card goes to PM like any unproven one.
 * tests/recovery-peer-lease-handover.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { RemoteHead } from "./order-deliver.js";
import { getEventByDedup } from "./ledger-store.js";
import { peerLeasePorts } from "./recovery-peer-lease.js";
import type { StopProof } from "./recovery-peer-lease-stop.js";

/** No lender worker ever ran on the lease's branch: there is no remote work to reconcile. */
const headCheckNeeded = (stops: readonly StopProof[]): boolean => stops.some((s) => s.proof !== "never_claimed" && s.proof !== "not_started");

/** Why the remote branch does not prove the ledger's head preserved, or null when it does (or is not needed). */
export function headProblem(stops: readonly StopProof[], head: string, branch: string, remote: RemoteHead | null): string | null {
  if (!headCheckNeeded(stops)) return null;
  if (!remote || !remote.ok) return `远端写分支 ${branch} 的 head 核不了${remote && !remote.ok ? `（${remote.error.slice(0, 200)}）` : ""}：成果是否保全不明，等 PM 核对`;
  if (remote.head !== head) return `远端写分支 ${branch} 在 ${remote.head.slice(0, 12)}，台账 head 是 ${head.slice(0, 12)}：有未交付成果未保全，等 PM 核对后正规入账`;
  return null;
}

/** The default read: `git ls-remote` of the lease's repo, the same as the restricted reclaim's context. */
async function readRemoteHead(repo: string, branch: string): Promise<RemoteHead> {
  const [{ remoteHeadAt }, { runBounded }] = await Promise.all([import("./lend-git.js"), import("./run-bounded.js")]);
  return remoteHeadAt(repo, branch, runBounded);
}

/** Probe the lease branch only when a worker ran on it; the answer the tick notes and the transaction re-checks. */
export async function probeHandoverHead(db: Database, ev: { stops: readonly StopProof[]; repo: string; branch: string; head: string }): Promise<{ remote: RemoteHead | null; why: string | null }> {
  let remote: RemoteHead | null = null;
  if (headCheckNeeded(ev.stops)) {
    try { remote = await (peerLeasePorts(db).remoteHead ?? readRemoteHead)(ev.repo, ev.branch); }
    catch (e) { remote = { ok: false, error: (e as Error).message }; }
  }
  return { remote, why: headProblem(ev.stops, ev.head, ev.branch, remote) };
}

export const HEAD_BLOCK_OP = "peer_author_handover_head_block" as const;
export const headBlockKey = (taskId: string, ev: { sessionId: string; leaseAt: number; head: string }): string =>
  `scheduler:peer-lease-head-block:${taskId}:${ev.sessionId}:${ev.leaseAt}:${ev.head}`;

/** The recorded block of this exact session / lease generation / head, or null. */
export function recordedHeadBlock(db: Database, taskId: string, ev: { sessionId: string; leaseAt: number; head: string }): string | null {
  const e = getEventByDedup(db, headBlockKey(taskId, ev));
  return e && e.target === taskId && e.data.op === HEAD_BLOCK_OP ? String(e.data.why) : null;
}
