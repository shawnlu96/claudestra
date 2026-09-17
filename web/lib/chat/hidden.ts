/**
 * v2.23.1+ 消息「删除」= 跨设备隐藏（owner 2026-09-17「给消息加一条可以右键删除的功能」）。
 *
 * 语义：只从聊天记录视图里隐藏，**不动** agent 的会话 jsonl 与上下文（那份是 Claude Code
 * 的源数据，改它会破坏会话；agent 的上下文也改不了）。服务端记录 → 手机与 Mac 一致。
 *
 * 粒度是 jsonl 原始记录的 seq **区间**：历史里一个 assistant 气泡是多条连续记录合并的
 * （每个 tool_use / 每段 text 各一条），BFF 在合并前按区间过滤原始记录，after/before/
 * 跨 session 各分支天然一致；user / system 气泡区间长度为 1。
 */
import { getDb } from "@/lib/db";

export interface HiddenRange {
  from: number;
  to: number;
}

export function hiddenRanges(agent: string, sessionId: string): HiddenRange[] {
  try {
    return getDb("settings")
      .prepare("SELECT seq_from AS `from`, seq_to AS `to` FROM hidden_messages WHERE agent = ? AND session_id = ?")
      .all(agent, sessionId) as HiddenRange[];
  } catch {
    return [];
  }
}

export function hideRange(agent: string, sessionId: string, from: number, to: number): void {
  getDb("settings")
    .prepare(
      "INSERT INTO hidden_messages (agent, session_id, seq_from, seq_to, hidden_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(agent, session_id, seq_from) DO UPDATE SET seq_to = excluded.seq_to, hidden_at = excluded.hidden_at",
    )
    .run(agent, sessionId, from, to, Date.now());
}

export function unhideRange(agent: string, sessionId: string, from: number): void {
  getDb("settings")
    .prepare("DELETE FROM hidden_messages WHERE agent = ? AND session_id = ? AND seq_from = ?")
    .run(agent, sessionId, from);
}

/** 「seq 是否被隐藏」谓词（合并气泡的循环里用：隐藏的 user/system 仍是分组断点，只是不输出） */
export function hiddenPredicate(agent: string, sessionId: string): ((seq: number) => boolean) | undefined {
  const ranges = hiddenRanges(agent, sessionId);
  if (!ranges.length) return undefined;
  return (seq) => ranges.some((r) => seq >= r.from && seq <= r.to);
}

/** 过滤掉落在隐藏区间内的原始记录（在合并成气泡**之前**调）。没有隐藏记录时原样返回。 */
export function filterHidden<T extends { seq: number }>(agent: string, sessionId: string, items: T[]): T[] {
  if (!items.length) return items;
  const ranges = hiddenRanges(agent, sessionId);
  if (!ranges.length) return items;
  return items.filter((m) => !ranges.some((r) => m.seq >= r.from && m.seq <= r.to));
}
