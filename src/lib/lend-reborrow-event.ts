/** Evidence drafts only; the canonical offer transaction must append the draft with the new order and lease atomically. */
import type { Database } from "bun:sqlite";
import type { ReborrowFacts } from "./lend-reborrow-facts.js";
import type { ReborrowSource } from "./lend-reborrow-source.js";
import { getLendOrder, type LendOrder } from "./ledger-lend.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";
import { CONV_REBORROW_OP } from "./lend-reborrow-conv-evidence.js";

const REBORROW_OP = "write_reborrow";
/** CONV-ended sources get their own op (CONV_REBORROW_OP) and key: a v1 PM-reclaim event never acquires a second meaning. */
export const reborrowKey = (taskId: string, reclaimSeq: number): string => `lend-reborrow:${taskId}:${reclaimSeq}`;
export const convReborrowKey = (taskId: string, endSeq: number): string => `lend-reborrow-conv:${taskId}:${endSeq}`;
export const reborrowKeyFor = (f: ReborrowFacts): string => (f.conv ? convReborrowKey : reborrowKey)(f.task.id, f.reclaim.seq);

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
  const c = facts.conv;
  if (c) {
    return {
      project: facts.task.project, target: facts.task.id, kind: "note" as const,
      text: "PM 按 CONV 正式结束证据续修同 peer 写租约（原已审 head、审查链与安全材料原样保留）",
      data: { lend: { op: CONV_REBORROW_OP, sourceKind: "conv_fix_strategy_reclaim", orderId: order.orderId, peer: order.peer,
        previousOrderId: facts.previous.orderId, previousGen: facts.previous.leaseGen, previousLease: facts.lease, reclaim: facts.reclaim,
        intentId: c.intent.id, materialsSeq: c.materials.seq, cancelSeqs: c.cancels.map((e) => e.seq), proofSeqs: c.proofs.map((e) => e.seq),
        originalFamily: c.from, convFamily: c.to, orderFamily: order.family, preparedFingerprint: facts.fingerprint,
        ledgerHead: facts.task.headSHA, head: source.remoteHead, providerVerification: "required_at_claim", facts,
        source, family: facts.family, specRev: facts.task.specRev, round: facts.task.round } },
    };
  }
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
  const event = getEventByDedup(db, reborrowKeyFor(facts));
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
