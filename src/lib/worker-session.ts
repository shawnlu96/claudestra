/**
 * T68 WorkerSession contract. The engine sees one shape whatever runs the work (Codex over ACP, Claude Code / Pi over
 * the channel protocol, a legacy tmux-typed session, a peer). The ledger stays the source of truth: a receipt is proof
 * that a message left, never proof that work finished; observe() answers "result" only from verified ledger facts.
 */
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { ReviewFinding } from "./scheduler-review.js";
import type { SessionRole, SessionTransport } from "./scheduler-sessions.js";

/** The ledger stores the host transport (as the registry does); the message route is derived from it, never stored apart. */
export type WorkerRouteKind = "acp" | "channel" | "tmux";
export interface SessionRef {
  taskId: string;
  role: SessionRole;
  agent: string;
  sessionId: string;
  family: AuthorFamily;
  transport: SessionTransport;
}

/** Everything a worker needs to act without reading scheduler memory; dedupKey is the intent id. */
export interface WorkOrder {
  taskId: string;
  specRev: number;
  head: string | null;
  round: number;
  node: string;
  step: "restate" | "write" | "review" | "fix";
  dedupKey: string;
  inputs: string[];
  outputs: string[];
  acceptance: string[];
  writeBack: string;
  findings?: ReviewFinding[];
  fallbackWarning?: string | null;
}

/**
 * sent = the transport accepted the message under this key; rejected = provably not delivered (safe to replan);
 * unknown = may or may not have been delivered, so nobody may resend under a new key until PM reconciles.
 * fallbackReason is set on every receipt of a tmux fallback, success or not, so the ledger always shows why.
 */
export type SubmitReceipt = (
  | { status: "sent"; route: WorkerRouteKind; messageKey: string; evidence: string }
  | { status: "rejected"; route: WorkerRouteKind; reason: string }
  | { status: "unknown"; route: WorkerRouteKind; reason: string }
) & { fallbackReason?: string };

/** The part of a work order observe() needs to match a ledger result or a host failure to this exact intent. */
export type OrderProbe = Pick<WorkOrder, "round" | "step" | "head" | "dedupKey">;

type WorkerFailure = { kind: "quota" | "auth" | "error"; message: string };
export type WorkerObservation =
  | { state: "running"; busy: boolean }
  | { state: "result"; outcome: "delivered" | "reviewed"; eventSeq: number }
  | { state: "result"; outcome: "failed"; failure: WorkerFailure }
  /** failure: the host reported a failed turn it could not tie to any order claimed before it; PM's call, not a wait. */
  | { state: "unknown"; reason: string; failure?: WorkerFailure };

export type EnsureResult =
  | { kind: "ready"; ref: SessionRef; created: boolean }
  | { kind: "manual"; reason: string }
  | { kind: "unknown"; reason: string };

export type ControlReceipt = ({ ok: true; evidence: string } | { ok: false; unknown: boolean; reason: string }) & { fallbackReason?: string };

export interface WorkerSession {
  readonly route: WorkerRouteKind;
  /** Non-null only for the tmux fallback; the driver writes it into the claim and every receipt. */
  readonly fallbackReason: string | null;
  ensure(taskId: string, role: SessionRole, family: AuthorFamily): Promise<EnsureResult>;
  submit(ref: SessionRef, intentId: string, order: WorkOrder): Promise<SubmitReceipt>;
  observe(ref: SessionRef, order: OrderProbe): Promise<WorkerObservation>;
  cancel(ref: SessionRef): Promise<ControlReceipt>;
  archive(ref: SessionRef): Promise<ControlReceipt>;
}

/** What the registry says about a local agent, or a peer delegation string from the card's step. */
export interface RouteTarget {
  agent: string;
  runtime?: string;
  transport?: string;
  acpPending?: boolean;
  peer?: string | null;
}

export type WorkerRoute =
  | { kind: "route"; route: WorkerRouteKind; transport: Exclude<SessionTransport, "peer">; family: AuthorFamily; fallbackReason: string | null }
  | { kind: "manual"; reason: string };

/**
 * ACP is primary for Codex; Claude Code / Pi speak the channel protocol. A Codex session still on the TUI is the only
 * tmux fallback, and it always carries a reason that the caller must persist. Peer delegation stays manual until E2.
 * Pi has no audited family pairing yet, so it is refused rather than guessed.
 */
export function selectWorkerRoute(t: RouteTarget): WorkerRoute {
  if (t.peer) return { kind: "manual", reason: `peer 委托（${t.peer}）本段不自动派，退回 manual` };
  if (t.runtime === "pi") return { kind: "manual", reason: "Pi 会话没有已核实的模型家族配对，不自动派" };
  if (t.runtime === "codex") {
    if (t.transport === "acp" && !t.acpPending) return { kind: "route", route: "acp", transport: "acp", family: "codex", fallbackReason: null };
    const why = t.acpPending ? "ACP 适配器或 CLI 暂不可用（acpPending）" : "该 Codex 会话尚未迁到 ACP";
    return { kind: "route", route: "tmux", transport: "tmux", family: "codex", fallbackReason: `tmux 兼容回退：${why}` };
  }
  if (t.runtime === undefined || t.runtime === "claude-code") return { kind: "route", route: "channel", transport: "tmux", family: "claude", fallbackReason: null };
  return { kind: "manual", reason: `未知 runtime ${t.runtime}，不猜派单路径` };
}

/** The host shape each route can drive; anything else is a misbound session and must not be sent to. */
const ROUTE_HOST: Record<WorkerRouteKind, { transport: SessionTransport; family: AuthorFamily }> = {
  acp: { transport: "acp", family: "codex" }, channel: { transport: "tmux", family: "claude" }, tmux: { transport: "tmux", family: "codex" },
};

export function routeMismatch(route: WorkerRouteKind, ref: Pick<SessionRef, "transport" | "family">): string | null {
  const want = ROUTE_HOST[route];
  return ref.transport === want.transport && ref.family === want.family ? null
    : `${route} 路径只驱动 ${want.family}/${want.transport} 宿主，session 是 ${ref.family}/${ref.transport}`;
}
