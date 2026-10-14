/**
 * dispatch-recovery-PEERLEASE1 · the peer author handover's stop proof (recovery-peer-lease-handover.ts). A PM reclaim only cancels the
 * borrower's order and ends the lease here (ledger-lend.ts reclaimLend); it stops nothing on the lender. So every write / fix order this
 * card ever gave the lease's peer on the lease's branch must carry the lender's own end fact for its exact lease generation, recorded
 * on this ledger before the reclaim:
 * - done: the lender's delivery entered with its receipt (ledger-lend-result.ts sets status, receipt and eventSeq together);
 * - never claimed (no worker, generation 0): no lender worker ever existed for it;
 * - released: the lender's own `release not_started` report of that generation (the worker never started);
 * - cancelled after a claim: the lender's `release stopped` report of that generation before the reclaim (lend-reclaim-stopped.ts,
 *   the same fact CONV2 records as a clean exit), or the lender's clean cancel ack of that generation (`convergence-cancel:<order>`).
 * A borrower-side cancelled status, the reclaim itself or time offline is never one. The card's peer author row must be the worker of
 * one of these orders. Read-only; tests/recovery-peer-lease-stop.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LendOrder } from "./ledger-lend.js";
import { listLendOrders } from "./ledger-lend.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { stoppedReportSeq } from "./lend-reclaim-stopped.js";

/** One proven end: the order, its lease generation and the ledger fact that proves it (seq, or 0 for a never-claimed order). */
export interface StopProof { orderId: string; gen: number; worker: string | null; proof: "delivered" | "never_claimed" | "not_started" | "stopped_report" | "clean_ack"; seq: number }

type Lend = { orderId?: unknown; peer?: unknown; op?: unknown; reason?: unknown; gen?: unknown };

function proofOf(db: Database, o: LendOrder, reclaimSeq: number): StopProof | string {
  const base = { orderId: o.orderId, gen: o.leaseGen, worker: o.worker };
  if (!o.worker && o.leaseGen === 0 && (o.status === "cancelled" || o.status === "released")) return { ...base, proof: "never_claimed", seq: 0 };
  if (o.status === "done") {
    return o.receipt && o.eventSeq !== null && o.eventSeq < reclaimSeq ? { ...base, proof: "delivered", seq: o.eventSeq } : `原单 ${o.orderId} 已交付但回执失读`;
  }
  const events = listEvents(db, { project: o.project, target: o.taskId });
  const lend = (data: Record<string, unknown>) => (data.lend ?? {}) as Lend;
  if (o.status === "released") {
    const r = events.find((e) => e.seq < reclaimSeq && e.kind === "note" && lend(e.data).orderId === o.orderId && lend(e.data).peer === o.peer &&
      lend(e.data).op === "release" && lend(e.data).reason === "not_started" && lend(e.data).gen === o.leaseGen);
    return r ? { ...base, proof: "not_started", seq: r.seq } : `原单 ${o.orderId} 已释放，但缺出借方本代次的未启动报告`;
  }
  if (o.status !== "cancelled") return `原单 ${o.orderId} 仍是 ${o.status}`;
  const report = stoppedReportSeq(db, o.orderId, o.leaseGen);
  if (report !== null && report < reclaimSeq) return { ...base, proof: "stopped_report", seq: report };
  const ack = getEventByDedup(db, `convergence-cancel:${o.orderId}`);
  if (ack && ack.kind === "scheduler" && ack.actor === "scheduler" && ack.target === o.taskId && ack.data.op === "convergence_cancel_ack" &&
    ack.data.orderId === o.orderId && ack.data.clean === true && ack.data.gen === o.leaseGen) return { ...base, proof: "clean_ack", seq: ack.seq };
  return `原单 ${o.orderId} 只是本机撤单（代次 ${o.leaseGen}），缺出借方报停或干净撤单回执：PM 收回不停远端 worker`;
}

/** The proofs of every write order of this peer on this branch, or why the handover waits. `agent` is the peer author row's agent. */
export function peerStopProofs(db: Database, taskId: string, peer: string, branch: string, reclaimSeq: number, agent: string): StopProof[] | string {
  const writers = listLendOrders(db, taskId).filter((o) => (o.step === "write" || o.step === "fix") && o.peer === peer && o.branch === branch)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!writers.length) return "台账没有这条租约的写单，停止证明核不了";
  const proofs: StopProof[] = [];
  for (const o of writers) {
    const p = proofOf(db, o, reclaimSeq);
    if (typeof p === "string") return p;
    proofs.push(p);
  }
  if (!proofs.some((p) => p.worker !== null && `${p.worker}@${peer}` === agent)) return `peer 作者 ${agent} 不是已证停止的原写单 worker：会话代次不符`;
  return proofs;
}
