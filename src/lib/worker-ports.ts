/**
 * Injected edges of the worker adapters. Each port is the single replacement point for its effect: T48's unified
 * dispatch replaces MessagePort, the ACP host bridge implements AcpPort, manager create/archive implements SessionPort.
 * Unit tests drive the adapters through mocks of exactly these interfaces.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { SessionRole } from "./scheduler-sessions.js";
import { routeMismatch, type ControlReceipt, type EnsureResult, type OrderProbe, type SessionRef, type SubmitReceipt, type WorkerObservation,
  type WorkerRouteKind, type WorkOrder } from "./worker-session.js";

/** delivered:false = the transport refused before anything left; "unknown" = a timeout or a dropped link mid-send. */
export type SendResult = { ok: true; messageId: string } | { ok: false; delivered: false | "unknown"; reason: string };
export type LiveState = "busy" | "idle" | "offline" | "unknown";

/**
 * Every call names the session as well as the agent: an agent name can be reused or restarted onto a new session, so
 * the implementation must refuse (delivered:false / ok:false) when the agent's current session is not sessionId.
 */
export interface MessagePort {
  send(agent: string, sessionId: string, text: string, key: string): Promise<SendResult>;
  status(agent: string, sessionId: string): Promise<LiveState>;
  interrupt(agent: string, sessionId: string): Promise<ControlReceipt>;
}

interface SessionPort {
  /** The ledger binding for this card and role, if one was already recorded (restart / replay reads this first). */
  bound(taskId: string, role: SessionRole): SessionRef | null;
  create(taskId: string, role: SessionRole, family: AuthorFamily, route: WorkerRouteKind): Promise<
    { ok: true; ref: SessionRef } | { ok: false; unknown: boolean; reason: string }>;
  archive(ref: SessionRef): Promise<ControlReceipt>;
}

/** A worker is finished only when the ledger holds its deliver / review event for this round and head. */
interface LedgerResultPort {
  result(ref: SessionRef, order: OrderProbe): { outcome: "delivered" | "reviewed"; eventSeq: number } | null;
}

export interface AdapterDeps {
  sessions: SessionPort;
  ledger: LedgerResultPort;
}

function refMismatch(route: WorkerRouteKind, ref: SessionRef, taskId: string, role: SessionRole, family: AuthorFamily): string | null {
  if (ref.taskId !== taskId || ref.role !== role) return `session 属于 ${ref.taskId}/${ref.role}，不是 ${taskId}/${role}`;
  if (ref.family !== family) return `${role} session 模型家族是 ${ref.family}，与要求的 ${family} 不符`;
  return routeMismatch(route, ref);
}

/** Replays return the recorded binding; a create that may have happened is unknown, never a second create. */
export async function ensureVia(deps: AdapterDeps, route: WorkerRouteKind, taskId: string, role: SessionRole, family: AuthorFamily): Promise<EnsureResult> {
  const bound = deps.sessions.bound(taskId, role);
  if (bound) {
    const bad = refMismatch(route, bound, taskId, role, family);
    return bad ? { kind: "manual", reason: `已绑定的 session 不能用：${bad}` } : { kind: "ready", ref: bound, created: false };
  }
  const made = await deps.sessions.create(taskId, role, family, route);
  if (made.ok) {
    // The session now exists, so a wrong one is an effect PM must reconcile, not something to silently retry.
    const bad = refMismatch(route, made.ref, taskId, role, family);
    return bad ? { kind: "unknown", reason: `新建的 session 不符：${bad}` } : { kind: "ready", ref: made.ref, created: true };
  }
  return made.unknown ? { kind: "unknown", reason: made.reason } : { kind: "manual", reason: made.reason };
}

/** Checked before any external effect: the order must be this intent's, for this session's card, on a host this route drives. */
export function orderMismatch(route: WorkerRouteKind, ref: SessionRef, intentId: string, order: WorkOrder): string | null {
  if (order.dedupKey !== intentId) return "任务单去重键与调度意图不一致";
  if (order.taskId !== ref.taskId) return `任务单属于 ${order.taskId}，session 属于 ${ref.taskId}`;
  if ((order.step === "review") !== (ref.role === "reviewer")) return `任务单步骤 ${order.step} 与 session 角色 ${ref.role} 不符`;
  return routeMismatch(route, ref);
}

/** Ledger facts first: a finished result stays finished even if the session later goes offline. */
export function observeVia(deps: AdapterDeps, ref: SessionRef, order: OrderProbe, live: LiveState): WorkerObservation {
  const done = deps.ledger.result(ref, order);
  if (done) return { state: "result", outcome: done.outcome, eventSeq: done.eventSeq };
  if (live === "busy" || live === "idle") return { state: "running", busy: live === "busy" };
  return { state: "unknown", reason: live === "offline" ? `${ref.agent} 不在线` : `读不到 ${ref.agent} 的状态` };
}

export function sendReceipt(route: WorkerRouteKind, key: string, r: SendResult, fallback: string | null): SubmitReceipt {
  const why = fallback ? { fallbackReason: fallback } : {};
  if (r.ok) return { status: "sent", route, messageKey: key, evidence: `message:${r.messageId}`, ...why };
  return { status: r.delivered === false ? "rejected" : "unknown", route, reason: r.reason, ...why };
}
