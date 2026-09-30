/**
 * Real edges of the E1 adapters for the scheduler service. Orders go out as a bridge `route_to_agent` from "scheduler"
 * (today's send_to_agent path; T48 replaces MessagePort). Every call first checks that the agent's registry session is
 * still the ledger-bound one. Liveness is only "window present / absent"; Codex quota and login failures are the
 * runtime asks the ACP link already opens, attributed to the last order this scheduler sent that agent before them.
 */
import type { Database } from "bun:sqlite";
import { bridgeSend } from "./bridge-client.js";
import { listAsks } from "./ledger-asks.js";
import type { RegistryAgent } from "./registry.js";
import { listAgentWindows } from "./tmux-helper.js";
import type { AcpPort, AcpTurnState } from "./worker-acp.js";
import type { LiveState, MessagePort, SendResult } from "./worker-ports.js";

export type RegistryRow = (agent: string) => RegistryAgent | undefined;

const sendVia = (registryRow: RegistryRow) => async (agent: string, sessionId: string, text: string, key: string): Promise<SendResult> => {
  const row = registryRow(agent);
  if (!row || row.sessionId !== sessionId) return { ok: false, delivered: false, reason: `${agent} 的当前 session 不是台账绑定的 ${sessionId}` };
  const r = await bridgeSend({ type: "route_to_agent", targetName: agent, text, fromName: "scheduler", oneShot: true }, { timeoutMs: 30_000 });
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

export function messagePort(registryRow: RegistryRow): MessagePort {
  return { send: sendVia(registryRow), status: livenessVia(registryRow), interrupt: noInterrupt };
}

/** The newest Codex runtime failure card for this agent, tied to the last order sent to it before the card opened. */
function lastFailure(db: Database, agent: string): AcpTurnState["lastFailure"] {
  const card = listAsks(db, { fromAgent: agent, source: "codex", states: ["open"] }).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!card) return undefined;
  const quota = card.extra.quota === true;
  if (!quota && card.kind !== "owner_action") return undefined;
  const before = db.query(`SELECT id FROM scheduler_intents WHERE recipient = ? AND status = 'done' AND action IN ('dispatch','review')
    AND updatedAt <= ? ORDER BY updatedAt DESC LIMIT 1`).get(agent, card.createdAt) as { id: string } | null;
  const message = typeof card.extra.raw === "string" ? card.extra.raw : card.title;
  return { failure: { kind: quota ? "quota" : "auth", key: card.id, message }, afterKey: before?.id ?? null };
}

export function acpPort(db: Database, registryRow: RegistryRow): AcpPort {
  const liveness = livenessVia(registryRow);
  return {
    prompt: sendVia(registryRow),
    async turnState(agent, sessionId) {
      const live = await liveness(agent, sessionId);
      return { live, lastFailure: lastFailure(db, agent) };
    },
    cancel: noInterrupt,
  };
}
