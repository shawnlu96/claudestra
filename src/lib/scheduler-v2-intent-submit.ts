/**
 * S2I central send: one dispatch / review order for a route=central card runs inside X8's executeSchedulerCentral, which
 * checks the center (authorization.check + intent.check) immediately before the send and reports operation.result once after.
 * X8's journal is the durable outbox: a send that may have happened is never run again for the same intent, whatever the ledger
 * later asks. A lease lost mid-send is unknown with the resources held (X8 rechecks after the effect); nothing retries locally.
 * X8 is the only result writer for such an intent: the driver's later scheduler-settle is answered by centralSettle, never by
 * a second operation.result / intent.cancel through S2Q. The current route is part of the local owner check up to the send, so
 * a card switched off / to migrating while X8 awaits the center is refused before any effect (blocked, nothing reported).
 * A transport refusal after X8 began is reported and returned as unknown (held for PM): the center has no failed→cancelled.
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
  if (outcome.state === "blocked") return { status: "rejected", route, reason: outcome.reason === "route_changed"
    ? "route_changed：等中心核验期间卡已不走中心，未投递" : `中心核验未通过，未投递：${outcome.reason}` };
  if (outcome.state === "unknown" || !sent) {
    const why = sent && sent.status !== "sent" ? `；本机回执 ${sent.status}：${sent.reason}` : sent ? `；本机已发 ${sent.messageKey}` : "";
    return { status: "unknown", route, reason: oneLine(`中心结果不明（${outcome.reason}），资源保留、不重发，交 PM 核对${why}`) };
  }
  return sent; // succeeded = the transport's own sent receipt (a refusal is reported and returned as unknown above)
}

/** Intents whose result X8 owns (intentId → taskId), filled as soon as the driver touches them through the central worker. */
export type SchedulerV2CentralOwned = Map<string, string>;

/**
 * The driver's scheduler-settle from submitted for an intent X8 has journaled: X8 already reported (or owns) its result, so it is
 * answered by the port's `settled` (S2F: sync the projection, return the projected intent) and never forwarded to S2Q.
 * Returns null when the settle is not X8's (passthrough). Missing `settled` or context = held, zero center requests.
 */
export async function centralSettle(port: SchedulerV2IntentPort, owned: SchedulerV2CentralOwned, args: readonly string[],
  held: (taskId: string, code: string) => void): Promise<Record<string, unknown> | null> {
  if (args[1] !== "scheduler-settle") return null;
  const intentId = args[2], flag = (name: string) => { const i = args.indexOf(`--${name}`); return i > 2 ? args[i + 1] : undefined; };
  const taskId = intentId ? owned.get(intentId) : undefined, to = flag("to");
  if (!taskId || flag("from") !== "submitted" || !to) return null;
  let journaled = true;
  try {
    const bound = port.central?.(taskId, intentId!);
    if (bound) journaled = bound.journal.read(parseSchedulerCentralContext(bound.context)) !== null;
  } catch { /* unreadable journal: X8 refuses to run it again, so it stays X8's */ }
  if (!journaled) return null; // X8 never began (blocked / refused before any effect): nothing reported, S2Q settles as usual
  if (!port.settled) { held(taskId, "v2_unmapped"); return { ok: false, code: "v2_unmapped" }; }
  return port.settled(taskId, intentId!, to);
}

/** WorkerSession's methods, listed by name (own, inherited or non-enumerable alike); a fixed list, never Object.keys. */
const WORKER_METHODS = ["ensure", "submit", "observe", "cancel", "archive"] as const;

/**
 * A new object forwarding to `w` without touching it (a frozen worker or class instance stays as it is): route and
 * fallbackReason are read once, and each listed method the original has is called on the original (same this, arguments,
 * return and throw); a method the original lacks is absent here too. Not a Proxy over `w` (frozen own methods break its invariants).
 */
export function forwardWorker(w: WorkerSession): WorkerSession {
  const out: Record<string, unknown> = { route: w.route, fallbackReason: w.fallbackReason };
  for (const key of WORKER_METHODS) {
    const fn = (w as unknown as Record<string, unknown>)[key];
    if (typeof fn === "function") out[key] = (...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(w, args);
  }
  return out as unknown as WorkerSession;
}

export function centralSubmit(port: SchedulerV2IntentPort, w: WorkerSession, held: (code: string) => void,
  owned: SchedulerV2CentralOwned = new Map()): WorkerSession {
  const refused = { ok: false as const, unknown: false, reason: "v2_unmapped：execution 卡的会话控制不由自动调度执行" };
  return {
    ...forwardWorker(w),
    ensure: async () => ({ kind: "wait", reason: "v2_unmapped：建 session 走调度器的 ensure" }),
    cancel: async () => refused,
    archive: async () => refused,
    observe: async (ref, order) => { owned.set(order.dedupKey, ref.taskId); return w.observe(ref, order); },
    submit: async (ref, intentId, order) => {
      owned.set(intentId, ref.taskId);
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
      let sent: SubmitReceipt | null = null, sending = false, left = false;
      const lock = bound.runtime.lock;
      // Before the send the route is part of local ownership: X8 asserts it after every center await and right before the effect.
      const runtime = { ...bound.runtime, lock: { held: () => {
        if (!sending && port.route(ref.taskId) !== "central") left = true;
        return lock.held() && (sending || !left);
      } } };
      let outcome: SchedulerCentralOutcome;
      try {
        outcome = await executeSchedulerCentral(bound.context, runtime, bound.journal, async (entry) => {
          sending = true;
          const step = { operationId: `send-${intentId}`, state: "started" as "started" | "succeeded" | "failed" | "unknown" };
          entry.steps.push(step);
          bound.journal.write(entry); // the send is on disk as started before it leaves
          sent = await w.submit(ref, intentId, order);
          step.state = sent.status === "sent" ? "succeeded" : sent.status === "rejected" ? "failed" : "unknown";
          bound.journal.write(entry);
          // An explicit refusal (journaled as failed: nothing left) is still reported as unknown: the center settles any
          // non-unknown result as done, which the driver would read as sent and wait forever. unknown keeps the resources,
          // matches the driver's own submitted→unknown settle and stops the card for PM, never as "dispatched".
          return { state: step.state === "succeeded" ? "succeeded" : "unknown", head: bound.context.head,
            summary: oneLine(sent.status === "sent" ? `sent ${sent.messageKey}` : `${sent.status === "rejected" ? "未投递（本机明确拒收）" : "投递不明"}：${sent.reason}`) || "send", artifactIds: [] };
        });
      } catch (e) {
        // A corrupt / mismatched journal refuses before any effect could run again; the claim stays for PM.
        outcome = { state: "unknown", resourceHeld: true, reported: false, replayed: true, reason: (e as { code?: string }).code ?? "unavailable", result: null };
      }
      if (left && outcome.state === "blocked") outcome = { ...outcome, reason: "route_changed" };
      if (outcome.state !== "succeeded") held(outcome.state === "blocked" ? outcome.reason : "unknown");
      return receiptOf(outcome, sent, w.route);
    },
  };
}
