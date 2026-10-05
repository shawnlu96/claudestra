/**
 * Real edges of the E1 adapters for the scheduler service. Orders go out as a bridge `route_to_agent` from "scheduler"
 * (today's send_to_agent path; T48 replaces MessagePort) naming the ledger-bound session, which the bridge checks again
 * when routing and before flushing a held copy; only its typed pre-delivery refusal counts as "not delivered". Liveness is only "window present / absent"; Codex quota and login failures are the
 * runtime asks the ACP link already opens, attributed to the last order claimed for that agent before them.
 */
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { readJsonStateSync } from "./state-file.js";
import { listAsks } from "./ledger-asks.js";
import { isWallState, QUOTA_WALL_PATH, type WallState } from "./quota-wall.js";
import type { RegistryAgent } from "./registry.js";
import { listAgentWindows } from "./tmux-helper.js";
import type { AcpPort, AcpTurnState } from "./worker-acp.js";
import type { HostFailure, LiveState, MessagePort, SendResult } from "./worker-ports.js";

export type RegistryRow = (agent: string) => RegistryAgent | undefined;
/** The scheduler's liveness, asked right before the frame goes out (see bridgeSend). */
export type StillActive = () => boolean;
const always: StillActive = () => true;

export const sendVia = (registryRow: RegistryRow, stillActive: StillActive) => async (agent: string, sessionId: string, text: string, key: string): Promise<SendResult> => {
  const row = registryRow(agent);
  if (!row || row.sessionId !== sessionId) return { ok: false, delivered: false, reason: `${agent} 的当前 session 不是台账绑定的 ${sessionId}` };
  const r = await bridgeSend({ type: "route_to_agent", targetName: agent, text, fromName: "scheduler", oneShot: true, expectSession: sessionId },
    { timeoutMs: 30_000, stillActive });
  if (r.ok) return { ok: true, messageId: `${key}@${String(r.result?.targetChannelId ?? row.channelId ?? "")}` };
  return { ok: false, delivered: r.sent ? "unknown" : false, reason: r.error };
};

const livenessVia = (registryRow: RegistryRow) => async (agent: string, sessionId: string): Promise<LiveState> => {
  const row = registryRow(agent);
  if (!row || row.sessionId !== sessionId) return "offline";
  try {
    return (await listAgentWindows()).includes(agent) ? "idle" : "offline";
  } catch (e) {
    console.error(`⚠️ [scheduler] 读 tmux 窗口失败，${agent} 记为状态未知：${(e as Error).message}`);
    return "unknown";
  }
};

const noInterrupt = async () => ({ ok: false as const, unknown: false, reason: "调度器不自动打断 worker，交 PM" });

/**
 * A Claude Code usage-limit wall is account-wide and recorded by the bridge's quota gate; the agent's own hit, tied to
 * the order claimed before it, is its failure. The gate holds and later resumes messages itself — whether this card waits
 * for that is PM's call, so it is reported like a Codex quota card and never resent.
 */
function wallFailure(db: Database, row: RegistryAgent | undefined, wallPath: string): HostFailure | undefined {
  const r = readJsonStateSync(wallPath, isWallState);
  const wall = r.status === "ok" ? (r.data as WallState).wall : null;
  const hit = wall && !wall.exit && row?.channelId ? wall.hits[row.channelId] : undefined;
  if (!wall || !hit || !row) return undefined;
  const message = `Claude Code 撞额度（${wall.kind}${wall.resetsText ? `，${wall.resetsText} 重置` : ""}）：${hit.error}`;
  return { failure: { kind: "quota", key: wall.id, message }, afterKey: claimedBefore(db, row.name, hit.at)?.id ?? null };
}

export function messagePort(db: Database, registryRow: RegistryRow, wallPath = QUOTA_WALL_PATH, stillActive = always): MessagePort {
  return { send: sendVia(registryRow, stillActive), status: livenessVia(registryRow), interrupt: noInterrupt,
    lastFailure: async (agent) => wallFailure(db, registryRow(agent), wallPath) };
}

/**
 * The last order to this agent claimed (pending→submitted, durable before the send) at or before `at`. A failure can land
 * between the send and the receipt, so the claim — not the completion — is what ties it to the order.
 */
function claimedBefore(db: Database, agent: string, at: number): { id: string } | null {
  return db.query(`SELECT i.id FROM scheduler_intents AS i JOIN events AS e ON e.dedupKey = 'scheduler:' || i.id || ':submitted'
    WHERE i.recipient = ? AND i.action IN ('dispatch','review') AND e.ts <= ? ORDER BY e.seq DESC LIMIT 1`).get(agent, at) as { id: string } | null;
}

/**
 * The newest Codex runtime failure card for this agent, tied to the last order claimed for it before the card opened: quota /
 * login cards (account-wide, so an unattributed one still matters) and failed-turn cards (bridge/acp-link.ts, only their own turn).
 * A failed-turn card is tied by when and where the host says it failed (extra.failedAt / extra.sessionId, lib/acp/host.ts), not by
 * when the bridge wrote it: a late frame from an earlier turn or session must not land on the order claimed since. A card without
 * failedAt (older host) cannot be tied to any order: unknown (afterKey null) once some order was claimed, so PM looks at it.
 */
export function codexFailure(db: Database, agent: string, sessionId?: string): AcpTurnState["lastFailure"] {
  const card = listAsks(db, { fromAgent: agent, source: "codex", states: ["open"] }).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!card) return undefined;
  const quota = card.extra.quota === true;
  if (!quota && card.kind !== "owner_action") return undefined;
  if (card.extra.failure === "error") {
    // 回合失败只关那一轮：归不到任何单（派单前的旧失败）就不算，免得把之后派的单也当成失败交 PM
    const failure = { kind: "error" as const, key: card.id, message: `${card.title}：${card.context}` };
    const failedAt = card.extra.failedAt;
    if (typeof failedAt !== "number" || !Number.isFinite(failedAt)) return claimedBefore(db, agent, card.createdAt) ? { failure, afterKey: null } : undefined;
    if (sessionId && typeof card.extra.sessionId === "string" && card.extra.sessionId !== sessionId) return undefined; // 换会话前的失败：不是这个会话上的单
    const at = claimedBefore(db, agent, failedAt);
    return at ? { failure, afterKey: at.id } : undefined;
  }
  const before = claimedBefore(db, agent, card.createdAt);
  const message = typeof card.extra.raw === "string" ? card.extra.raw : card.title;
  return { failure: { kind: quota ? "quota" : "auth", key: card.id, message }, afterKey: before?.id ?? null };
}

export function acpPort(db: Database, registryRow: RegistryRow, stillActive = always): AcpPort {
  const liveness = livenessVia(registryRow);
  return {
    prompt: sendVia(registryRow, stillActive),
    async turnState(agent, sessionId) {
      const live = await liveness(agent, sessionId);
      return { live, lastFailure: codexFailure(db, agent, sessionId) };
    },
    cancel: noInterrupt,
  };
}
