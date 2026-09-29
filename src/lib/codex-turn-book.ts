/**
 * Codex 原生回合账（T52 Codex 第 6 轮复审 #204）：只认 rollout 里 event_msg 的 task_started / task_complete / turn_aborted，
 * 按频道记「回合开着没有」和「上次确认空闲之后投了哪些、哪些明确没投进去」。不走展示用的事件环（有上限、会被 bg_task 挤掉、
 * 不落盘），也不从「没看到输出」反推空闲——静默思考时 watcher 一条事件都不发。bridge 重启后在看到第一条原生边界之前 known=false，
 * 一律算拿不准。投递失败能不能收 done 只看 codexConfirmedIdle。tests/codex-turn-book.test.ts
 */

export type CodexTurnMark = { kind: "start" | "end"; turnId: string };

/** rollout 一行是不是原生回合边界；不是 JSON / 不是边界 = null */
export function codexTurnMark(line: string): CodexTurnMark | null {
  if (!line.includes('"event_msg"')) return null;
  let e: { type?: unknown; payload?: { type?: unknown; turn_id?: unknown } };
  try {
    e = JSON.parse(line);
  } catch {
    return null; // 半行 / 坏行：不是边界，watcher 那边照常按自己的规则处理这一行
  }
  const t = e?.type === "event_msg" ? e.payload?.type : undefined;
  const turnId = typeof e?.payload?.turn_id === "string" ? e.payload.turn_id : "";
  if (t === "task_started") return { kind: "start", turnId };
  if (t === "task_complete" || t === "turn_aborted") return { kind: "end", turnId };
  return null;
}

interface Book {
  /** 开着的回合（turn_id）；空 = 确认空闲 */
  open: Set<string>;
  /** 上次确认空闲之后投进来的消息 → 是否已明确没投进去 */
  sinceIdle: Map<string, boolean>;
  lastTurnId: string;
  at: number;
}

const books = new Map<string, Book>();

/** watcher 每读一行 Codex rollout 调一次（别的 runtime 直接返回） */
export function noteCodexTurnLine(runtime: string | undefined, channelId: string, line: string, now = Date.now()): void {
  if (runtime !== "codex" || !channelId) return;
  const m = codexTurnMark(line);
  if (!m) return;
  const b = books.get(channelId) ?? { open: new Set<string>(), sinceIdle: new Map<string, boolean>(), lastTurnId: "", at: 0 };
  books.set(channelId, b);
  if (m.kind === "start") b.open.add(m.turnId);
  else b.open.delete(m.turnId);
  b.lastTurnId = m.turnId;
  b.at = now;
  // 回合都收了：之前投的要么被这些回合吃掉了，要么接着开新回合（task_started 会再把 open 点亮）
  if (m.kind === "end" && b.open.size === 0) b.sinceIdle.clear();
}

/** 消息 ws.send 给了 Codex 频道。还没见过原生边界的频道不记：反正拿不准 */
export function noteCodexSent(channelId: string, messageId: string): void {
  books.get(channelId)?.sinceIdle.set(messageId, false);
}

/** channel-server 报这条没投进 Codex */
export function noteCodexFailed(channelId: string, messageId: string): void {
  const b = books.get(channelId);
  if (b?.sinceIdle.has(messageId)) b.sinceIdle.set(messageId, true);
}

/** 确认空闲：见过原生边界、没有开着的回合、上次空闲之后投的每一条都明确没投进去 */
export function codexConfirmedIdle(channelId: string): boolean {
  const b = books.get(channelId);
  return !!b && b.open.size === 0 && [...b.sinceIdle.values()].every(Boolean);
}

/** agent 被 kill / 频道复用前清掉 */
export function forgetCodexTurns(channelId: string): void {
  books.delete(channelId);
}
