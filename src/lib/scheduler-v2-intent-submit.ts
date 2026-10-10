/**
 * S2I central send: one dispatch / review order for a route=central card runs inside X8's executeSchedulerCentral, which
 * checks the center (authorization.check + intent.check) immediately before the send and reports operation.result once after.
 * X8's journal is the durable outbox: a send that may have happened is never run again for the same intent, whatever the ledger
 * later asks. A lease lost mid-send is unknown with the resources held (X8 rechecks after the effect); nothing retries locally.
 */
import { executeSchedulerCentral, type SchedulerCentralOutcome } from "./scheduler-central.js";
import { parseSchedulerCentralContext } from "./scheduler-central-context.js";
import type { SchedulerV2IntentPort } from "./scheduler-v2-intent.js";
import type { SubmitReceipt, WorkerSession, WorkOrder } from "./worker-session.js";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 900);

/** The injected context must bind this very intent, action and head; anything else is refused before any request. */
function boundContext(port: SchedulerV2IntentPort, taskId: string, intentId: string, order: WorkOrder) {
  const bound = port.central?.(taskId, intentId);
  if (!bound) return null;
  const context = parseSchedulerCentralContext(bound.context);
  const action = order.step === "review" ? "review" : "dispatch";
  if (context.taskId !== taskId || context.intentId !== intentId || context.action !== action || context.head !== order.head) return "authorization_mismatch";
  return { ...bound, context };
}

function receiptOf(outcome: SchedulerCentralOutcome, sent: SubmitReceipt | null, route: SubmitReceipt["route"]): SubmitReceipt {
  if (outcome.state === "blocked") return { status: "rejected", route, reason: `中心核验未通过，未投递：${outcome.reason}` };
  if (outcome.state === "unknown" || !sent) {
    const why = sent && sent.status !== "sent" ? `；本机回执 ${sent.status}：${sent.reason}` : sent ? `；本机已发 ${sent.messageKey}` : "";
    return { status: "unknown", route, reason: oneLine(`中心结果不明（${outcome.reason}），资源保留、不重发，交 PM 核对${why}`) };
  }
  return sent; // succeeded = the transport's own sent receipt, failed = its rejected receipt (reported centrally as failed)
}

export function centralSubmit(port: SchedulerV2IntentPort, w: WorkerSession, held: (code: string) => void): WorkerSession {
  const refused = { ok: false as const, unknown: false, reason: "v2_unmapped：execution 卡的会话控制不由自动调度执行" };
  return {
    ...w,
    ensure: async () => ({ kind: "wait", reason: "v2_unmapped：建 session 走调度器的 ensure" }),
    cancel: async () => refused,
    archive: async () => refused,
    submit: async (ref, intentId, order) => {
      let bound: ReturnType<typeof boundContext> | "invalid_context";
      try { bound = boundContext(port, ref.taskId, intentId, order); }
      catch { bound = "invalid_context"; }
      if (!bound || typeof bound === "string") {
        held(bound ?? "v2_unmapped");
        return { status: "rejected", route: w.route, reason: `${bound ?? "v2_unmapped"}：没有可用的中心意图上下文，未投递` };
      }
      if (port.route(ref.taskId) !== "central") {
        held("route_changed");
        return { status: "rejected", route: w.route, reason: "route_changed：卡已不走中心，未投递" };
      }
      let sent: SubmitReceipt | null = null;
      let outcome: SchedulerCentralOutcome;
      try {
        outcome = await executeSchedulerCentral(bound.context, bound.runtime, bound.journal, async (entry) => {
          const step = { operationId: `send-${intentId}`, state: "started" as "started" | "succeeded" | "failed" | "unknown" };
          entry.steps.push(step);
          bound.journal.write(entry); // the send is on disk as started before it leaves
          sent = await w.submit(ref, intentId, order);
          step.state = sent.status === "sent" ? "succeeded" : sent.status === "rejected" ? "failed" : "unknown";
          bound.journal.write(entry);
          return { state: step.state === "succeeded" ? "succeeded" : step.state === "failed" ? "failed" : "unknown", head: bound.context.head,
            summary: oneLine(sent.status === "sent" ? `sent ${sent.messageKey}` : sent.reason) || "send", artifactIds: [] };
        });
      } catch (e) {
        // A corrupt / mismatched journal refuses before any effect could run again; the claim stays for PM.
        outcome = { state: "unknown", resourceHeld: true, reported: false, replayed: true, reason: (e as { code?: string }).code ?? "unavailable", result: null };
      }
      if (outcome.state !== "succeeded") held(outcome.state === "blocked" ? outcome.reason : "unknown");
      return receiptOf(outcome, sent, w.route);
    },
  };
}
