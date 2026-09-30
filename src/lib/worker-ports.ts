/**
 * Injected edges of the worker adapters. Each port is the single replacement point for its effect: T48's unified
 * dispatch replaces MessagePort, the ACP host bridge implements AcpPort, manager create/archive implements SessionPort.
 * Unit tests drive the adapters through mocks of exactly these interfaces.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { SessionRole } from "./scheduler-sessions.js";
import type { ControlReceipt, EnsureResult, OrderProbe, SessionRef, WorkerObservation, WorkerRouteKind } from "./worker-session.js";

/** delivered:false = the transport refused before anything left; "unknown" = a timeout or a dropped link mid-send. */
export type SendResult = { ok: true; messageId: string } | { ok: false; delivered: false | "unknown"; reason: string };
export type LiveState = "busy" | "idle" | "offline" | "unknown";

export interface MessagePort {
  send(agent: string, text: string, key: string): Promise<SendResult>;
  status(agent: string): Promise<LiveState>;
  interrupt(agent: string): Promise<ControlReceipt>;
}

export interface SessionPort {
  /** The ledger binding for this card and role, if one was already recorded (restart / replay reads this first). */
  bound(taskId: string, role: SessionRole): SessionRef | null;
  create(taskId: string, role: SessionRole, family: AuthorFamily, route: WorkerRouteKind): Promise<
    { ok: true; ref: SessionRef } | { ok: false; unknown: boolean; reason: string }>;
  archive(ref: SessionRef): Promise<ControlReceipt>;
}

/** A worker is finished only when the ledger holds its deliver / review event for this round and head. */
export interface LedgerResultPort {
  result(ref: SessionRef, order: OrderProbe): { outcome: "delivered" | "reviewed"; eventSeq: number } | null;
}

export interface AdapterDeps {
  sessions: SessionPort;
  ledger: LedgerResultPort;
}

/** Replays return the recorded binding; a create that may have happened is unknown, never a second create. */
export async function ensureVia(deps: AdapterDeps, route: WorkerRouteKind, taskId: string, role: SessionRole, family: AuthorFamily): Promise<EnsureResult> {
  const bound = deps.sessions.bound(taskId, role);
  if (bound) {
    if (bound.family !== family) return { kind: "manual", reason: `已绑定的 ${role} session 模型家族是 ${bound.family}，与要求的 ${family} 不符` };
    return { kind: "ready", ref: bound, created: false };
  }
  const made = await deps.sessions.create(taskId, role, family, route);
  if (made.ok) return { kind: "ready", ref: made.ref, created: true };
  return made.unknown ? { kind: "unknown", reason: made.reason } : { kind: "manual", reason: made.reason };
}

/** Ledger facts first: a finished result stays finished even if the session later goes offline. */
export function observeVia(deps: AdapterDeps, ref: SessionRef, order: OrderProbe, live: LiveState): WorkerObservation {
  const done = deps.ledger.result(ref, order);
  if (done) return { state: "result", outcome: done.outcome, eventSeq: done.eventSeq };
  if (live === "busy" || live === "idle") return { state: "running", busy: live === "busy" };
  return { state: "unknown", reason: live === "offline" ? `${ref.agent} 不在线` : `读不到 ${ref.agent} 的状态` };
}

export function sendReceipt(route: WorkerRouteKind, key: string, r: SendResult, note: string | null) {
  if (r.ok) return { status: "sent" as const, route, messageKey: key, evidence: [`message:${r.messageId}`, note].filter(Boolean).join("; ") };
  if (r.delivered === false) return { status: "rejected" as const, route, reason: r.reason };
  return { status: "unknown" as const, route, reason: r.reason };
}
