/** ACP 清线程后确认 registry 与 watcher 同步；请求来自当前登记的宿主（acp-link 先校验 ws）。 */
import type { Client } from "discord.js";
import { readRegistryAgents } from "../lib/registry.js";
import { startWatching } from "./jsonl-watcher.js";
import { retireAgentSessionEvents } from "./event-bus.js";

export async function rebindAcpWatcher(channelId: string, sessionId: string, discord: Client, previousSessionId = ""): Promise<{ ok: boolean; error?: string }> {
  const reg = (await readRegistryAgents()).find((a) => a.channelId === channelId && a.status === "active");
  if (!reg || reg.transport !== "acp" || reg.sessionId !== sessionId || !reg.cwd) return { ok: false, error: "registry 尚未指向这个 ACP 线程" };
  await startWatching(reg.name, reg.cwd, sessionId, channelId, discord, { runtime: reg.runtime, transport: "acp", rebind: true });
  if (previousSessionId) retireAgentSessionEvents(reg.name, previousSessionId);
  return { ok: true };
}
