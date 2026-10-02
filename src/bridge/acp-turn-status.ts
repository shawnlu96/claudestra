/**
 * ws `turn_status`（launcher 升级闸，lib/acp-turn-gate.ts）：这些 agent 的 ACP 宿主此刻有没有回合在途。逐个经宿主问
 * AcpTurnLoop.busy（acp-link acpHostTurnBusy），不看事件态也不看画面：事件态 bridge 一重启就空了，「没有事件」不是空闲的证据。
 * 每个 agent 答 busy / idle / unknown；不是 ACP 宿主登记的频道、宿主不答、旧宿主不认这个调用都是 unknown，闸门当忙。
 */
import type { AcpTurn } from "../lib/acp-turn-gate.js";
import { readRegistryAgents } from "../lib/registry.js";
import { acpHostTurnBusy } from "./acp-link.js";

export interface TurnStatusDeps {
  agents: () => Promise<{ name: string; channelId?: string }[]>;
  hostBusy: (channelId: string) => Promise<boolean | null>;
}

const LIVE: TurnStatusDeps = { agents: () => readRegistryAgents(), hostBusy: acpHostTurnBusy };

async function turnsOf(names: string[], deps: TurnStatusDeps): Promise<Record<string, AcpTurn>> {
  const regs = await deps.agents();
  const turnOf = async (name: string): Promise<AcpTurn> => {
    const ch = regs.find((r) => r.name === name)?.channelId;
    const busy = ch ? await deps.hostBusy(ch) : null;
    return busy === null ? "unknown" : busy ? "busy" : "idle";
  };
  return Object.fromEntries(await Promise.all(names.map(async (n) => [n, await turnOf(n)] as const)));
}

/** 永不抛：查不出来回 error（launcher 当未知、照样挡），回包发不出去只记日志（launcher 那头超时，同样挡） */
export async function answerTurnStatus(ws: { send(data: string): unknown }, msg: { requestId?: unknown; agents?: unknown }, deps = LIVE): Promise<void> {
  const names = Array.isArray(msg.agents) ? msg.agents.filter((a): a is string => typeof a === "string") : [];
  let body: Record<string, unknown>;
  try {
    body = { result: { turns: await turnsOf(names, deps) } };
  } catch (e) {
    body = { error: `查 ACP 回合态失败：${(e as Error).message}` };
  }
  try {
    ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, ...body }));
  } catch (e) {
    console.warn(`⚠️ turn_status 回包发不出去（launcher 会超时、按未知挡住）：${(e as Error).message}`);
  }
}
