/**
 * 「待你处理」→ 原消息在哪（T11b 第 6 条）：发起 agent 的会话记录里是哪一行（seq = jsonl 行号，和历史接口同一个坐标），
 * 网页拿 {sessionId, seq} 调 store.jumpToContext 跳过去、滚到那条并闪一下高亮；不在当前分页里的，按 seq 往前翻页找得到。
 * - reply 类：找那次 reply 的 tool_use（input.text 和 ask.body 一字不差）；
 * - 运行时弹框（AUQ / 权限）、找不到 reply 的：退到建 ask 那一刻之前的最后一条记录。
 * 当前会话先找，找不到再翻最近几个归档会话；结果记进 ask.extra.loc，下次直接用。只认 Claude Code 的记录格式（Pi / Codex 返回 null，网页只开对话不跳）。
 */
import { readFileSync } from "node:fs";
import { getAsk, patchAsk, type Ask } from "../lib/ledger-asks.js";
import { agentRuntime } from "../lib/registry.js";
import { listAgentSessions } from "../lib/session-history.js";
import { sessionJsonlPath } from "../lib/session-source.js";
import { askDb, askReadDb, registry } from "./asks.js";

export interface AskLocation {
  agent: string;
  sessionId: string;
  seq: number;
}

/** 最多翻几个归档会话（agent 重启 / compact 换了会话之后，老 ask 的原消息在归档里） */
const MAX_SESSIONS = 4;

/** reply 工具调用那一行：工具名以 __reply 结尾、input.text 就是 ask 的原文 */
function isReplyLine(line: string, body: string): boolean {
  if (!line.includes('"tool_use"') || !line.includes("__reply")) return false;
  try {
    const rec = JSON.parse(line) as { message?: { content?: { type?: string; name?: string; input?: { text?: string } }[] } };
    return (rec.message?.content ?? []).some((b) => b.type === "tool_use" && !!b.name?.endsWith("__reply") && b.input?.text === body);
  } catch {
    return false; // 半行（正在写的最后一行）：跳过这一行就好
  }
}

const tsOf = (line: string): number => Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? "");

/** 纯函数（单测直接喂行）：reply 类按原文找，找不到再按时间退到建 ask 之前的最后一条；都没有 → null */
export function locateInLines(lines: string[], a: Pick<Ask, "source" | "body" | "createdAt">): number | null {
  if (a.source === "reply" && a.body) {
    for (let i = lines.length - 1; i >= 0; i--) if (isReplyLine(lines[i], a.body)) return i;
  }
  let best: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const ts = tsOf(lines[i]);
    if (Number.isFinite(ts) && ts <= a.createdAt) best = i;
  }
  return best;
}

async function locateFresh(a: Ask): Promise<AskLocation | null> {
  const reg = (await registry()).find((r) => r.name === a.fromAgent);
  if (!reg?.cwd || agentRuntime(reg) !== "claude-code") return null;
  const sessions = await listAgentSessions(reg.name, { cwd: reg.cwd, currentSessionId: reg.sessionId, runtime: reg.runtime });
  // 当前会话在前，其余按新到旧
  const order = [...sessions].sort((x, y) => Number(y.sessionId === reg.sessionId) - Number(x.sessionId === reg.sessionId) || (y.mtime ?? "").localeCompare(x.mtime ?? ""));
  for (const s of order.slice(0, MAX_SESSIONS)) {
    const path = s.sessionId === reg.sessionId ? (sessionJsonlPath(reg.runtime, reg.cwd, s.sessionId) ?? s.path) : s.path;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue; // 归档被清掉 / 正在轮转：看下一个会话
    }
    const seq = locateInLines(text.split("\n"), a);
    // 按时间退的只在当前会话里认（归档里「之前最后一条」多半是更早的无关对话）
    if (seq !== null && (a.source === "reply" || s.sessionId === reg.sessionId)) return { agent: reg.name, sessionId: s.sessionId, seq };
  }
  return null;
}

/** 找原消息的位置（结果缓存进 extra.loc）；人 / 系统发起的、找不到的 → null */
export async function locateAsk(id: string): Promise<AskLocation | null> {
  const db = askReadDb();
  const a = db ? getAsk(db, id) : null;
  if (!a?.fromAgent) return null;
  const cached = a.extra.loc as AskLocation | undefined;
  if (cached && typeof cached.seq === "number") return cached;
  const loc = await locateFresh(a);
  if (loc) patchAsk(askDb(), a.id, { extra: { loc } });
  return loc;
}
