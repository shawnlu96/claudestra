/**
 * bridge 认「自己的」MCP 工具（jsonl-watcher 据此不把 reply 等当工具行推送）：配置的前缀照旧认；
 * 另一族的前缀只在本机有过按命名族起的会话之后才认——off / observe 从没起过新族会话，过滤与改造前逐字相同；
 * 回滚到 off 后，还在跑 / 续接的新族会话照样被认。同一条工具调用只命中一次，所以两族的输出各显示一次、不重复。
 */
import { familyOfTool } from "./families.js";
import { hasFamilyRecords } from "./store.js";

const RECHECK_MS = 10_000; // watcher 每条工具调用都问；记录目录只会从无到有，晚 10 秒认新族无碍（新会话起来也要几秒）
let cached: { at: number; on: boolean } | null = null;

function familyRecordsSeen(now: number): boolean {
  if (cached?.on) return true;
  if (!cached || now - cached.at >= RECHECK_MS) cached = { at: now, on: hasFamilyRecords() };
  return cached.on;
}

export function isOwnMcpTool(name: string, configuredPrefix: string, seen: (now: number) => boolean = familyRecordsSeen, now = Date.now()): boolean {
  if (name.startsWith(configuredPrefix)) return true;
  return familyOfTool(name) !== null && seen(now);
}
