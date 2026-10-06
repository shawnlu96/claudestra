/** Evidence drafts only; the canonical offer transaction must append the draft with the new order and lease atomically. */
import type { Database } from "bun:sqlite";
import type { ReborrowFacts } from "./lend-reborrow-facts.js";
import type { ReborrowSource } from "./lend-reborrow-source.js";
import { getLendOrder, type LendOrder } from "./ledger-lend.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";

const REBORROW_OP = "write_reborrow";
export const reborrowKey = (taskId: string, reclaimSeq: number): string => `lend-reborrow:${taskId}:${reclaimSeq}`;

function checkOrder(f: ReborrowFacts, s: ReborrowSource, o: LendOrder): void {
  if (o.taskId !== f.task.id || o.project !== f.task.project || o.peer !== f.lease.peer || o.family !== f.family ||
    o.step !== (f.task.stage === "build" ? "write" : "fix") || o.specRev !== f.task.specRev || o.round !== f.task.round ||
    o.head !== s.remoteHead || o.branch !== f.lease.branch || o.repo !== f.lease.repo || o.base !== "main" ||
    o.pr !== (s.pr?.number ?? null) || o.supersedes !== f.previous.orderId || o.orderId === f.previous.orderId ||
    o.wire.orderId !== o.orderId || o.wire.head !== o.head || o.wire.pr !== o.pr || o.wire.repo !== o.repo) {
    throw new LedgerError("conflict", "新写单未绑定原租约、起点、PR 或作者家族");
  }
}

/** All original lease columns and the complete reclaim event survive replacement of the holder projection. */
export function reborrowEventDraft(facts: ReborrowFacts, source: ReborrowSource, order: LendOrder) {
  checkOrder(facts, source, order);
  return {
    project: facts.task.project, target: facts.task.id, kind: "note" as const,
    text: "PM 正规接回同 peer 写租约（保留原已审 head 与审查会话）",
    data: { lend: { op: REBORROW_OP, orderId: order.orderId, peer: order.peer, previousOrderId: facts.previous.orderId,
      previousLease: facts.lease, reclaim: facts.reclaim, preparedFingerprint: facts.fingerprint,
      ledgerHead: facts.task.headSHA, head: source.remoteHead, providerVerification: "required_at_claim", facts,
      source, family: facts.family, specRev: facts.task.specRev, round: facts.task.round } },
  };
}

/** Same reclaimed lease has one successor even after that order ends. A changed request is a conflict, not a second offer. */
export function replayReborrow(db: Database, facts: ReborrowFacts, source: ReborrowSource): LendOrder | null {
  const event = getEventByDedup(db, reborrowKey(facts.task.id, facts.reclaim.seq));
  if (!event) return null;
  const link = event.data.lend as { orderId?: string } | undefined;
  const order = typeof link?.orderId === "string" ? getLendOrder(db, link.orderId) : null;
  if (!order) throw new LedgerError("conflict", "接续事件缺少 canonical 订单，拒绝重签");
  const expected = reborrowEventDraft(facts, source, order);
  if (event.kind !== expected.kind || event.project !== expected.project || event.target !== expected.target ||
    event.actor !== order.createdBy || JSON.stringify(event.data) !== JSON.stringify(expected.data)) {
    throw new LedgerError("dedup_mismatch", "原租约已用于不同的接续请求或事件绑定损坏");
  }
  return order;
}
