/**
 * plan → durable intent → claim → submit → receipt, with the ledger deciding every step. The claim (pending→submitted)
 * is written before the external send, so a crash, a duplicate tick or a restarted service can never send twice:
 * a claimed intent with no receipt is either proven by a ledger result or handed to PM as unknown. Before the claim the
 * order, the session and the card as it stands now must all agree with the intent; a stale or misbuilt one is cancelled.
 */
import type { IntentStatus, SchedulerIntent } from "./ledger-scheduler.js";
import type { SessionRole } from "./scheduler-sessions.js";
import { deliveryTag, type SessionRef, type SubmitReceipt, type WorkerSession, type WorkOrder } from "./worker-session.js";

/** The card and its recorded binding as the ledger holds them now (not as the intent remembers them). */
interface CurrentDispatchFacts { specRev: number; head: string | null; round: number; bound: SessionRef | null }

export interface SchedulerLedgerOps {
  intent(id: string): SchedulerIntent | null;
  current(taskId: string, role: SessionRole): CurrentDispatchFacts | null;
  /** CAS through the guarded ledger CLI; false = someone else moved the intent first (stop, the ledger is right). */
  settle(id: string, from: IntentStatus, to: IntentStatus, receipt: string): Promise<boolean>;
  /** The seq of the recipient's order_taken record for this intent (lib/order-mark.ts), or null. */
  taken(id: string): number | null;
  now(): number;
}

/** A claim younger than this may still be mid-send in another tick; only an expired claim is reconciled. */
export const CLAIM_LEASE_MS = 10 * 60_000;

export type DriveOutcome =
  | { kind: "settled"; status: IntentStatus }
  | { kind: "lost_race" }
  | { kind: "sent"; receipt: SubmitReceipt }
  | { kind: "replan"; reason: string }
  | { kind: "held"; reason: string };

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 560);

/** The delivery tag leads so the one-line cap can never cut it off; the unclaimed alarm reads it back (sentAsWake). */
function receiptText(r: SubmitReceipt, order: WorkOrder): string {
  const why = r.fallbackReason ? `; ${r.fallbackReason}` : "";
  const tag = deliveryTag(order.delivery);
  return oneLine(r.status === "sent" ? `${tag}; route=${r.route}; key=${r.messageKey}; ${r.evidence}${why}` : `${tag}; route=${r.route}; ${r.reason}${why}`);
}

const sameRef = (a: SessionRef, b: SessionRef): boolean =>
  a.taskId === b.taskId && a.role === b.role && a.agent === b.agent && a.sessionId === b.sessionId && a.family === b.family && a.transport === b.transport;

/** Every field that decides what is sent and to whom, compared before any external effect. */
function dispatchMismatch(ops: SchedulerLedgerOps, intent: SchedulerIntent, ref: SessionRef, order: WorkOrder): string | null {
  const role: SessionRole = intent.action === "review" ? "reviewer" : "author";
  if (intent.recipient !== ref.agent || intent.taskId !== ref.taskId || ref.role !== role) return "意图收件人与 session 不一致";
  if (order.taskId !== intent.taskId || order.node !== intent.node || order.specRev !== intent.specRev || order.head !== intent.head) {
    return `任务单（${order.taskId}/${order.node}/specRev ${order.specRev}）与意图（${intent.taskId}/${intent.node}/specRev ${intent.specRev}）不符`;
  }
  const now = ops.current(intent.taskId, role);
  if (!now) return "台账里读不到这张卡";
  if (now.specRev !== intent.specRev || now.head !== intent.head || now.round !== order.round) return "卡已被推进（specRev / head / 轮次变了），旧意图作废";
  if (!now.bound || !sameRef(now.bound, ref)) return `session 不是台账当前绑定的 ${role} session`;
  return null;
}

export async function driveDispatch(ops: SchedulerLedgerOps, worker: WorkerSession, ref: SessionRef, order: WorkOrder): Promise<DriveOutcome> {
  const intent = ops.intent(order.dedupKey);
  if (!intent) return { kind: "held", reason: "台账里没有这个调度意图" };
  if (intent.status === "done" || intent.status === "cancelled") return { kind: "settled", status: intent.status };
  if (intent.status === "unknown") return { kind: "held", reason: `外部结果不明，等 PM 核对：${intent.receipt ?? intent.reason}` };
  if (intent.action !== "dispatch" && intent.action !== "review") return { kind: "held", reason: `意图 ${intent.action} 不走 worker 派单` };
  if (intent.status === "submitted") {
    if (intent.recipient !== ref.agent || intent.taskId !== ref.taskId) return { kind: "held", reason: "意图收件人与 session 不一致" };
    if (ops.now() - intent.updatedAt < CLAIM_LEASE_MS) return { kind: "held", reason: "另一轮已认领，租约未到期" };
    return reconcileClaimed(ops, worker, ref, order, intent);
  }
  const bad = dispatchMismatch(ops, intent, ref, order);
  if (bad) {
    return (await ops.settle(intent.id, "pending", "cancelled", `未投递：${oneLine(bad)}`)) ? { kind: "replan", reason: bad } : { kind: "lost_race" };
  }
  const claim = [`claimed; ${deliveryTag(order.delivery)}; route=${worker.route}; session=${ref.sessionId}`, worker.fallbackReason].filter(Boolean).join("; ");
  if (!(await ops.settle(intent.id, "pending", "submitted", oneLine(claim)))) return { kind: "lost_race" };
  const receipt = await worker.submit(ref, intent.id, order);
  const text = receiptText(receipt, order);
  if (receipt.status === "sent") {
    return (await ops.settle(intent.id, "submitted", "done", text)) ? { kind: "sent", receipt } : { kind: "lost_race" };
  }
  if (receipt.status === "rejected") {
    return (await ops.settle(intent.id, "submitted", "cancelled", `未投递：${text}`)) ? { kind: "replan", reason: receipt.reason } : { kind: "lost_race" };
  }
  await ops.settle(intent.id, "submitted", "unknown", `投递结果不明：${text}`);
  return { kind: "held", reason: receipt.reason };
}

/** After a restart the only acceptable proof of delivery is the worker's own ledger record (a result, or it took the order); otherwise stop for PM. */
async function reconcileClaimed(ops: SchedulerLedgerOps, worker: WorkerSession, ref: SessionRef, order: WorkOrder, intent: SchedulerIntent): Promise<DriveOutcome> {
  const seen = await worker.observe(ref, order);
  if (seen.state === "result" && seen.outcome !== "failed") {
    const ok = await ops.settle(intent.id, "submitted", "done", `对账：台账已有本单结果 seq ${seen.eventSeq}`);
    return ok ? { kind: "settled", status: "done" } : { kind: "lost_race" };
  }
  const took = ops.taken(intent.id);
  if (took !== null) {
    const ok = await ops.settle(intent.id, "submitted", "done", `对账：${deliveryTag(order.delivery)}; 收件人已领单 seq ${took}`);
    return ok ? { kind: "settled", status: "done" } : { kind: "lost_race" };
  }
  const ok = await ops.settle(intent.id, "submitted", "unknown", "已认领但没有投递回执，也没有台账结果；不重发，交 PM 核对");
  return ok ? { kind: "held", reason: "claimed_without_receipt" } : { kind: "lost_race" };
}
