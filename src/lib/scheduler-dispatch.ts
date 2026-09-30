/**
 * plan → durable intent → claim → submit → receipt, with the ledger deciding every step. The claim (pending→submitted)
 * is written before the external send, so a crash, a duplicate tick or a restarted service can never send twice:
 * a claimed intent with no receipt is either proven by a ledger result or handed to PM as unknown.
 */
import type { IntentStatus, SchedulerIntent } from "./ledger-scheduler.js";
import type { SessionRef, SubmitReceipt, WorkerSession, WorkOrder } from "./worker-session.js";

export interface SchedulerLedgerOps {
  intent(id: string): SchedulerIntent | null;
  /** CAS through the guarded ledger CLI; false = someone else moved the intent first (stop, the ledger is right). */
  settle(id: string, from: IntentStatus, to: IntentStatus, receipt: string): Promise<boolean>;
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

function receiptText(r: SubmitReceipt): string {
  return oneLine(r.status === "sent" ? `route=${r.route}; key=${r.messageKey}; ${r.evidence}` : `route=${r.route}; ${r.reason}`);
}

export async function driveDispatch(ops: SchedulerLedgerOps, worker: WorkerSession, ref: SessionRef, order: WorkOrder): Promise<DriveOutcome> {
  const intent = ops.intent(order.dedupKey);
  if (!intent) return { kind: "held", reason: "台账里没有这个调度意图" };
  if (intent.status === "done" || intent.status === "cancelled") return { kind: "settled", status: intent.status };
  if (intent.status === "unknown") return { kind: "held", reason: `外部结果不明，等 PM 核对：${intent.receipt ?? intent.reason}` };
  if (intent.action !== "dispatch" && intent.action !== "review") return { kind: "held", reason: `意图 ${intent.action} 不走 worker 派单` };
  if (intent.recipient !== ref.agent || intent.taskId !== ref.taskId) return { kind: "held", reason: "意图收件人与 session 不一致" };
  if (intent.status === "submitted") {
    if (ops.now() - intent.updatedAt < CLAIM_LEASE_MS) return { kind: "held", reason: "另一轮已认领，租约未到期" };
    return reconcileClaimed(ops, worker, ref, order, intent);
  }
  if (!(await ops.settle(intent.id, "pending", "submitted", `claimed; route=${worker.route}; session=${ref.sessionId}`))) return { kind: "lost_race" };
  const receipt = await worker.submit(ref, intent.id, order);
  const text = receiptText(receipt);
  if (receipt.status === "sent") {
    return (await ops.settle(intent.id, "submitted", "done", text)) ? { kind: "sent", receipt } : { kind: "lost_race" };
  }
  if (receipt.status === "rejected") {
    return (await ops.settle(intent.id, "submitted", "cancelled", `未投递：${text}`)) ? { kind: "replan", reason: receipt.reason } : { kind: "lost_race" };
  }
  await ops.settle(intent.id, "submitted", "unknown", `投递结果不明：${text}`);
  return { kind: "held", reason: receipt.reason };
}

/** After a restart the only acceptable proof of delivery is the worker's own ledger result; otherwise stop for PM. */
async function reconcileClaimed(ops: SchedulerLedgerOps, worker: WorkerSession, ref: SessionRef, order: WorkOrder, intent: SchedulerIntent): Promise<DriveOutcome> {
  const seen = await worker.observe(ref, order);
  if (seen.state === "result" && seen.outcome !== "failed") {
    const ok = await ops.settle(intent.id, "submitted", "done", `对账：台账已有本单结果 seq ${seen.eventSeq}`);
    return ok ? { kind: "settled", status: "done" } : { kind: "lost_race" };
  }
  const ok = await ops.settle(intent.id, "submitted", "unknown", "已认领但没有投递回执，也没有台账结果；不重发，交 PM 核对");
  return ok ? { kind: "held", reason: "claimed_without_receipt" } : { kind: "lost_race" };
}
