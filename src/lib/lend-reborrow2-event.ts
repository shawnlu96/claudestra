/**
 * REBOR2 evidence: one event per (old order, gen), appended in the same transaction as the successor order and held lease.
 * It quotes the complete ended lease, old order terminal row and source split; it never rewrites them or claims a PM reclaim.
 * The basis reader is the only way a successor is trusted later (getLendOrder / cardMoved). tests/lend-reborrow2-apply.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { Reborrow2Facts } from "./lend-reborrow2-facts.js";
import type { Reborrow2Source } from "./lend-reborrow2-source.js";
import { classifyReserved, type Reborrow2Binding } from "./lend-reborrow2-marker.js";
import type { LendOrder } from "./ledger-lend.js";
import { getEventByDedup, LedgerError } from "./ledger-store.js";

const OP = "write_reborrow2";
export const reborrow2Key = (taskId: string, oldOrderId: string, gen: number): string => `lend-reborrow2:${taskId}:${oldOrderId}:${gen}`;

export interface Reborrow2Basis { ledgerHead: string | null; previousOrderId: string; gen: number; samePeer: boolean }

type Order = Omit<LendOrder, "reborrowBasis" | "reborrow2Basis">;

function orderMatches(f: Reborrow2Facts, s: Reborrow2Source, o: Order): boolean {
  return o.taskId === f.task.id && o.project === f.task.project && o.peer === f.target.peer && o.family === f.family &&
    o.step === (f.task.stage === "build" ? "write" : "fix") && o.specRev === f.task.specRev && o.round === f.task.round &&
    o.head === s.startHead && o.branch === f.target.branch && o.repo === f.target.repo && o.base === "main" &&
    o.pr === (s.pr?.number ?? null) && o.supersedes === f.previous.orderId && o.orderId !== f.previous.orderId &&
    o.wire.orderId === o.orderId && o.wire.head === o.head && o.wire.pr === o.pr && o.wire.repo === o.repo;
}

export function reborrow2EventDraft(facts: Reborrow2Facts, source: Reborrow2Source, order: Order) {
  if (!orderMatches(facts, source, order)) throw new LedgerError("conflict", "新写单未绑定原终态、起点、分支、PR 或作者家族");
  return {
    project: facts.task.project, target: facts.task.id, kind: "note" as const,
    text: `PM 采用已结束写租约（${facts.end}）为终态事实，正规接续写单（原租约 / 订单终态原样引用）`,
    data: { lend: { op: OP, orderId: order.orderId, peer: order.peer, previousOrderId: facts.previous.orderId, previousGen: facts.previous.leaseGen,
      previousLease: facts.lease, previousOrder: { status: facts.previous.status, reason: facts.previous.reason, updatedAt: facts.previous.updatedAt },
      end: facts.end, samePeer: facts.samePeer, preparedFingerprint: facts.fingerprint, ledgerHead: facts.task.headSHA, head: source.startHead,
      providerVerification: "required_at_claim", facts, source, family: facts.family, originalFamily: facts.originalFamily, epochSeq: facts.epochSeq,
      specRev: facts.task.specRev, round: facts.task.round } },
  };
}

/** One successor per old order generation; a changed request for the same generation is a conflict, not a second offer. */
export function replayReborrow2(db: Database, facts: Reborrow2Facts, source: Reborrow2Source, get: (id: string) => Order | null): Order | null {
  const event = getEventByDedup(db, reborrow2Key(facts.task.id, facts.previous.orderId, facts.previous.leaseGen));
  if (!event) return null;
  const link = event.data.lend as { orderId?: string } | undefined;
  const order = typeof link?.orderId === "string" ? get(link.orderId) : null;
  if (!order) throw new LedgerError("conflict", "终态接续事件缺少 canonical 订单，拒绝重签");
  const expected = reborrow2EventDraft(facts, source, order);
  if (event.kind !== expected.kind || event.project !== expected.project || event.target !== expected.target ||
    event.actor !== order.createdBy || JSON.stringify(event.data) !== JSON.stringify(expected.data)) {
    throw new LedgerError("dedup_mismatch", "原终态已用于不同的接续请求或事件绑定损坏");
  }
  return order;
}

/** undefined = not a REBOR2 order; null = damaged or not yet committed (callers must reject it, never treat it as ordinary). */
export function readReborrow2Basis(db: Database, o: Order): Reborrow2Basis | null | undefined {
  const c = classifyReserved(o.wire.acceptance);
  if (c.kind === "none" || c.kind === "v1") return undefined;
  if (c.kind === "invalid") return null;
  const b: Reborrow2Binding = c.binding;
  const e = getEventByDedup(db, reborrow2Key(o.taskId, b.orderId, b.gen));
  const l = e?.data.lend as { op?: string; orderId?: string; facts?: Reborrow2Facts; source?: Reborrow2Source; head?: string } | undefined;
  if (!e || e.kind !== "note" || e.target !== o.taskId || e.project !== o.project || e.actor !== o.createdBy || l?.op !== OP || l.orderId !== o.orderId) return null;
  const f = l.facts, s = l.source;
  if (!f?.task || !f.previous || !f.lease || !f.target || !s) return null;
  try {
    if (JSON.stringify(e.data) !== JSON.stringify(reborrow2EventDraft(f, s, o).data)) return null;
  } catch { return null; } // A draft mismatch is exactly "damaged basis"; the caller rejects the order.
  const old = db.query("SELECT * FROM lend_orders WHERE orderId = ?").get(b.orderId) as Record<string, unknown> | null;
  if (!old || old.status !== f.previous.status || old.leaseGen !== b.gen || old.peer !== f.lease.peer || old.branch !== f.lease.branch ||
    old.repo !== o.repo || old.updatedAt !== f.previous.updatedAt || f.previous.orderId !== b.orderId || f.previous.leaseGen !== b.gen ||
    (b.peer === "same") !== f.samePeer || b.end !== f.end || b.src !== f.lease.branch || b.ended !== f.lease.updatedAt ||
    f.lease.state !== "ended" || f.task.id !== o.taskId || f.task.specRev !== o.specRev || f.task.round !== o.round || l.head !== o.head) return null;
  return { ledgerHead: f.task.headSHA, previousOrderId: b.orderId, gen: b.gen, samePeer: f.samePeer };
}
