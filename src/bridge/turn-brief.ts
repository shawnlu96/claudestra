/**
 * 目标 agent「当前在做什么」的取数（拼法在 lib/turn-brief.ts）：本回合入站来自 TurnCuts，工具来自 event-bus 的事件环，
 * 在等的问题是这个频道开着的「待你处理」（reply 按钮 / AUQ / 权限 / Codex 弹框；accept 只是请 owner 验收，不算在等）。
 * 全在内存或只读库上，不发网络请求；台账读不到就当没有在等的问题。单测 tests/turn-brief.test.ts。
 */
import { listAsks } from "../lib/ledger-asks.js";
import { recentTools, turnBriefText } from "../lib/turn-brief.js";
import { askReadDb } from "./asks.js";
import { replayEventsSince } from "./event-bus.js";
import { turnCuts } from "./turn-cuts.js";

function openQuestions(channelId: string): string[] {
  const db = askReadDb();
  if (!db) return [];
  try {
    return listAsks(db, { states: ["open"] })
      .filter((a) => a.fromChannelId === channelId && a.kind !== "accept")
      .map((a) => a.title || a.body);
  } catch (e) {
    console.warn(`⚠️ turn-brief 读待答问题失败（当没有，摘要少一段）：${(e as Error).message}`);
    return [];
  }
}

/** ≤300 字；全空 = 不知道它在做什么（空闲 / bridge 刚重启） */
export function turnBrief(agent: string, channelId: string): string {
  return turnBriefText({
    inbound: turnCuts.turnInbound(channelId),
    tools: recentTools(replayEventsSince(0, { agent })),
    questions: openQuestions(channelId),
  });
}
