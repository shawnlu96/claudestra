/** ACP 接线集中分派，bridge.ts 只保留一次调用；管理状态直接问宿主，不猜日志画面。 */
import type { Client } from "discord.js";
import { migrationDrained, migrationHold } from "./acp-migration-hold.js";
import { acpStatus, onAcpFrame } from "./acp-link.js";
const FRAME_TYPES = new Set(["acp_entries", "acp_config", "acp_failure", "acp_permission", "acp_call_result", "acp_rebind"]);
export async function dispatchAcp(msg: Record<string, any>, ws: { send(s: string): void }, discord: Client): Promise<boolean> {
  if (FRAME_TYPES.has(msg.type)) { await onAcpFrame(msg, ws, discord); return true; }
  if (msg.type === "acp_migration_drained") { migrationDrained(msg, ws); return true; }
  if (msg.type === "acp_migration_hold") {
    ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: await migrationHold(msg) }));
    return true;
  }
  if (msg.type !== "acp_status") return false;
  ws.send(JSON.stringify({ type: "response", requestId: msg.requestId, result: await acpStatus(String(msg.channelId ?? "")) }));
  return true;
}
