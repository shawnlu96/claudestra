/**
 * 宿主重启 / 迁移后窗口先回放最近一段历史（src/acp-host.ts 在 TTY 上调一次）：session/resume 不回放，不回放窗口就是整屏空白。
 * 读会话文件末尾 REPLAY_BYTES（宿主按运行时交来路径和 session-source.ts 的翻译器，这里不认运行时），每段照常先打码再截断，
 * 只取最后 REPLAY_ITEMS 段；入站消息的来源核不了，按宿主给的 userText 只去包装、原文照登，不认人不藏字（cc-own-records.ts）。
 * 有文件就一定画「已接续会话」（没取到可显示的也画），没文件是新会话、不画。tests/acp-transcript-replay.test.ts。
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { LineTranslator } from "../session-source.js";
import type { TtyScreen } from "./tty-screen.js";
import { clipThought, transcriptOfEntry, transcriptOfInbound } from "./transcript.js";

export const REPLAY_ITEMS = 20;
const REPLAY_BYTES = 1 << 20;

type Rec = Record<string, any>;

export interface ReplayItem {
  item: string;
  at?: Date;
}

/** 文件最后 max 字节的整行（开头半行丢掉） */
export function tailLines(path: string, max = REPLAY_BYTES): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n");
    return len < size ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

/** 回放从哪读、怎么读（宿主按运行时给，这里不认运行时） */
export interface ReplaySource {
  /** 会话文件路径；null = 新会话 */
  path(): string | null;
  translate: LineTranslator;
  /** user 记录的文字 → 显示的正文：Pi / Codex 文本里的 <channel> 来源头谁都能写，只去包装标签、原文照登（plainUserText） */
  userText(rec: Rec, text: string): string;
}
type Reader = Pick<ReplaySource, "translate" | "userText">;

/** 收到的消息：来源一律不认（「消息」），正文是 userText 给的原文，不剥头、不按头过滤 */
function inboundOf(src: Reader, e: Rec, text: string): string[] {
  const body = text.trim() ? src.userText(e, text) : "";
  return body.trim() ? [transcriptOfInbound(body, { user: "消息" }, true)] : [];
}

/** 收到的消息（会话文件里是 user 的文字块）按「> 来源：」显示；思考用终端视图的多行版（clipThought）；其余块照 transcriptOfEntry */
function itemsOf(src: Reader, e: Rec): string[] {
  const c = e.message?.content;
  if (e.type === "assistant" && Array.isArray(c)) {
    return c.flatMap((b: Rec) => (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()
      ? [`✻ ${clipThought(b.thinking)}`] : transcriptOfEntry({ ...e, message: { ...e.message, content: [b] } })));
  }
  if (e.type !== "user") return transcriptOfEntry(e);
  if (typeof c === "string") return inboundOf(src, e, c);
  const text = Array.isArray(c) ? c.filter((b: Rec) => b?.type === "text" && typeof b.text === "string").map((b: Rec) => b.text).join("\n") : "";
  const rest = (Array.isArray(c) ? c : []).filter((b: Rec) => b?.type !== "text");
  return [...inboundOf(src, e, text), ...transcriptOfEntry({ ...e, message: { content: rest } })];
}

/** 会话文件的行 → 最近 max 段（翻译器有状态，同一次读一个实例） */
export function replayOfLines(src: Reader, lines: readonly string[], max = REPLAY_ITEMS): ReplayItem[] {
  const out: ReplayItem[] = [];
  for (const line of lines) {
    const e = line.trim() ? src.translate(line) : null;
    if (!e) continue;
    const at = typeof e.timestamp === "string" || typeof e.timestamp === "number" ? new Date(e.timestamp) : undefined;
    for (const item of itemsOf(src, e)) out.push({ item, ...(at && !Number.isNaN(at.getTime()) ? { at } : {}) });
  }
  return out.slice(-max);
}

/** 回放进窗口：没有文件 = 新会话，不画；有文件但读不了 / 尾巴里没有可显示的（最后一条记录比读取窗口还长），只画接续提示 */
export function showReplay(screen: Pick<TtyScreen, "show">, src: ReplaySource, log: (m: string) => void): void {
  let p: string | null = null, items: ReplayItem[] = [];
  try {
    p = src.path();
    if (p) items = replayOfLines(src, tailLines(p));
  } catch (e) {
    log(`读会话历史回放失败（窗口照常起${p ? "，只提示已接续" : ""}）：${String(e)}`);
  }
  if (!p) return; // 找不到文件（含找文件时出错）当新会话
  const { head, foot } = replayFrame(items.length);
  if (!items.length) return screen.show(head);
  screen.show(head);
  for (const r of items) screen.show(r.item, r.at);
  screen.show(foot);
}

/** 顶部提示：一行，不放本机路径（连接日志用 /log 看） */
export function tuiHeader(agentName: string, sessionId: string, typing: boolean): string {
  return `ACP 会话 ${agentName} · 线程 ${sessionId.slice(0, 8)} · ${typing ? "/help 看命令" : "只看"}`;
}

/** 回放的前后两行：说清这是接续前的记录、更早的去网页看 */
export function replayFrame(n: number): { head: string; foot: string } {
  const head = n ? `⏹ 已接续会话 · 下面是最近 ${n} 条（更早的见网页）` : "⏹ 已接续会话 · 最近记录见网页";
  return { head, foot: "── 以上是接续前的记录 ──" };
}
