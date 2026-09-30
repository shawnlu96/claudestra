/** 旧 TUI 退出并换宿主期间，所有来源的入站都留在既有押后队列，防止迁移与新回合竞态。 */
import { randomUUID } from "node:crypto";
import { extensionSocketOf } from "./pi-abort.js";
import { getAgentStatus, isBusyStatus } from "./event-bus.js";
import { readRegistryAgents } from "../lib/registry.js";
import type { Envelope, LocalEndpoint, Delivery } from "./router.js";
type Socket = { send(s: string): void };
const holds = new Map<string, { token: string; until: number; ws?: Socket }>();
const drains = new Map<string, { ws: Socket; done(ok: boolean): void }>();
export function migrationDrained(msg: Record<string, any>, ws: Socket): void {
  const d = drains.get(String(msg.id));
  if (d?.ws === ws) d.done(msg.ok === true);
}
function drainReceiver(ws: Socket, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), 3_000);
    const done = (ok: boolean) => { clearTimeout(timer); drains.delete(token); resolve(ok); };
    drains.set(token, { ws, done });
    try { ws.send(JSON.stringify({ type: "migration_drain", token })); }
    catch (e) { console.warn(`[migration] 接收端排空握手失败: ${String(e)}`); done(false); }
  });
}
function release(channel: string): void {
  const h = holds.get(channel);
  holds.delete(channel);
  try { h?.ws?.send(JSON.stringify({ type: "migration_resume", token: h.token })); }
  catch (e) { console.warn(`[migration] 接收端恢复失败，连接已关闭或租约到期恢复: ${String(e)}`); }
}
export function migrationHeld(channelId: string): boolean {
  const h = holds.get(channelId);
  if (!h) return false;
  if (h.until <= Date.now()) { release(channelId); return false; }
  return true;
}
export function holdDuringMigration(env: Envelope, to: LocalEndpoint, queue: { holdEnv(e: Envelope): unknown }): Delivery | null {
  if (!migrationHeld(to.channelId)) return null;
  queue.holdEnv(env);
  return { envelope: env, outcome: { kind: "sent", note: "queued" } };
}
export async function migrationHold(msg: Record<string, any>, read = readRegistryAgents, socket = extensionSocketOf, drain = drainReceiver) {
  const channel = String(msg.channelId ?? "");
  if (msg.release) {
    if (holds.get(channel)?.token !== msg.token) return { ok: false };
    release(channel);
    return { ok: true };
  }
  const agent = (await read()).find((a) => a.channelId === channel);
  if (!agent || agent.runtime !== "codex" || !((agent.transport === "tmux" && agent.acpPending) || (agent.transport === "acp" && agent.acpRestartPending && agent.acpRestartFrom === "tmux"))
    || isBusyStatus(getAgentStatus(agent.name)) || migrationHeld(channel)) return { ok: false };
  const token = randomUUID();
  const ws = socket(channel);
  holds.set(channel, { token, until: Date.now() + 240_000, ws });
  if ((ws && !(await drain(ws, token))) || (!ws && agent.transport === "tmux")) {
    release(channel);
    return { ok: false, reason: "接收端无法确认排空，保留旧会话；空闲后可手动 transport acp" };
  }
  return { ok: true, token };
}
