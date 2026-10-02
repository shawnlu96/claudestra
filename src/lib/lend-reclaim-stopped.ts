/** A lender that already reported this lease generation stopped before we cancelled it will never send a clean-cancel ack. */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import { getLendOrder } from "./ledger-lend.js";
import { insertEvent } from "./ledger-tx.js";

type Lend = { orderId?: unknown; peer?: unknown; op?: unknown; reason?: unknown; gen?: unknown };

/**
 * Seq of the lender's own `release stopped` report for this order and generation, written before the first cancellation
 * (PM / scheduler withdraw or the scheduler's convergence cancel). Only ledger events the lease endpoint records count; null = keep waiting.
 */
export function stoppedReportSeq(db: Database, orderId: string, gen: number): number | null {
  const o = getLendOrder(db, orderId);
  if (!o || !(gen > 0) || o.leaseGen !== gen) return null;
  const events = listEvents(db, { project: o.project, target: o.taskId });
  const lend = (data: Record<string, unknown>) => (data.lend ?? {}) as Lend;
  const cancelAt = events.find((e) => (e.kind === "note" && lend(e.data).orderId === orderId && lend(e.data).op === "cancel") ||
    (e.kind === "scheduler" && e.data.op === "convergence_cancel" && e.data.orderId === orderId))?.seq ?? Infinity;
  const report = events.find((e) => e.seq < cancelAt && e.kind === "note" && lend(e.data).orderId === orderId &&
    lend(e.data).peer === o.peer && lend(e.data).op === "release" && lend(e.data).reason === "stopped" && lend(e.data).gen === gen);
  return report?.seq ?? null;
}

/** On reclaim, record which lender report released each writer that had no clean-cancel ack. */
export function recordStoppedExits(db: Database, ctx: WriteCtx, task: { id: string; project: string }, intentId: string,
  orders: { orderId: string; leaseGen: number }[]): void {
  for (const o of orders) {
    const ack = getEventByDedup(db, `convergence-cancel:${o.orderId}`), key = `scheduler:${intentId}:stopped-exit:${o.orderId}`;
    if ((ack?.data.clean === true && ack.data.gen === o.leaseGen) || getEventByDedup(db, key)) continue;
    const seq = stoppedReportSeq(db, o.orderId, o.leaseGen);
    if (seq === null) continue;
    insertEvent(db, { ...ctx, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `旧写单 ${o.orderId} 撤单前出借方已报停（事件 #${seq}），按干净退出处理`,
      data: { op: "convergence_stopped_exit", intentId, orderId: o.orderId, gen: o.leaseGen, reportSeq: seq } }, true);
  }
}
