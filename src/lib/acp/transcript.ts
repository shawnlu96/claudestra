/**
 * ACP 宿主窗口里的可读会话（只看）：tmux attach / 网页终端打开 ACP agent 时看到的就是这些行。输入是宿主推给 bridge 的
 * 同一批条目（updates.ts 翻好的，正文已按消息攒齐，不会一个 chunk 一行），这里只读不改，网页聊天流不受影响。
 * 一律先脱敏（redact-secrets.ts）再显示；工具结果只留开头几行。连接 / 生命周期日志不进这里，只进 host.log（src/acp-host.ts）。
 * tests/acp-transcript.test.ts。
 */
import { hasInboundHeader, stripChannelHeader } from "../inbound-body.js";
import { redactSecrets } from "../redact-secrets.js";
import { formatTool } from "../tool-display-format.js";
import type { AcpFailure } from "./failures.js";
import type { StopReport } from "./turn.js";

type Rec = Record<string, any>;

/** 正文 / reply 也设上限：一条消息可以是几百 KB（长报告），整段灌进 pane 会挤爆历史 */
const RESULT_LINES = 4, RESULT_CHARS = 400, USER_CHARS = 2_000, TEXT_LINES = 200, TEXT_CHARS = 6_000, ONE_LINE = 200;
/** 先脱敏再截断：只扫开头这么多，远大于截断后的长度，截断处不会留下半个密钥 */
const SCAN_CHARS = 8_000;
const STAMP_WIDTH = "[00:00:00] ".length;

/** 截到 lines 行、chars 字；截了就注明原本多少行 */
function clip(raw: string, lines: number, chars: number): string {
  const s = redactSecrets(raw.slice(0, SCAN_CHARS)).trim();
  const all = s.split("\n");
  let out = all.slice(0, lines).join("\n");
  if (out.length > chars) out = out.slice(0, chars);
  return out.length < s.length || raw.length > SCAN_CHARS ? `${out}…（共 ${raw.split("\n").length} 行）` : out;
}

const oneLine = (s: unknown): string => clip(String(s ?? "").replace(/\s*\n\s*/g, " "), 1, ONE_LINE);

const PLAN_MARK: Record<string, string> = { completed: "✓", in_progress: "▸" };

function toolLine(name: string, input: Rec): string {
  if (name === "reply" || name.endsWith("__reply")) return `💬 回复：${clip(String(input?.text ?? ""), TEXT_LINES, TEXT_CHARS)}`;
  if (name === "Bash") return `💻 ${oneLine(input?.command)}`; // formatTool 只留第一个 && 之前，终端里要看整条命令的开头
  if (name === "update_plan") {
    const steps = (Array.isArray(input?.plan) ? input.plan : []).map((p: Rec) => `  ${PLAN_MARK[p?.status] ?? "·"} ${oneLine(p?.step)}`);
    return ["📋 计划", ...steps].join("\n");
  }
  return oneLine(formatTool(name, input));
}

function resultLine(b: Rec): string[] {
  if (String(b.tool_use_id ?? "").startsWith("acp-plan-")) return []; // 计划工具的固定回执（updates.ts plan），没有信息量
  const c = b.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: Rec) => (x?.type === "text" ? String(x.text ?? "") : "")).join("\n") : "";
  const body = text.trim() ? clip(text, RESULT_LINES, RESULT_CHARS) : "（无输出）";
  return [`  ${b.is_error ? "✗" : "↳"} ${body.replace(/\n/g, "\n    ")}`];
}

function blockLines(b: Rec): string[] {
  switch (b?.type) {
    case "text":
      return typeof b.text === "string" && b.text.trim() ? [`🤖 ${clip(b.text, TEXT_LINES, TEXT_CHARS)}`] : [];
    case "thinking":
      return typeof b.thinking === "string" && b.thinking.trim() ? [`💭 ${oneLine(b.thinking)}`] : [];
    case "tool_use":
      return [toolLine(String(b.name ?? "tool"), b.input ?? {})];
    case "tool_result":
      return resultLine(b);
    default:
      return [];
  }
}

/** 一条推给 bridge 的条目 → 窗口里的零到多段（一段可以多行）。失败条目不在这显示：宿主按 AcpFailure 另打（没登录不出条目，也要显示） */
export function transcriptOfEntry(e: Rec): string[] {
  if (!e || typeof e !== "object" || e.error !== undefined) return [];
  if (e.type === "system") return e.subtype === "compact_boundary" ? ["📦 上下文已压缩"] : [];
  const blocks = e.message?.content;
  return Array.isArray(blocks) ? blocks.flatMap(blockLines) : [];
}

/** 收到的消息：只显示正文（不含宿主包的 channel 标签和前言；bridge 的来源头、它真加的打断抬头按历史解析的规则剥掉，来源看 👤 后的名字） */
export function transcriptOfInbound(content: string, meta: Record<string, string>): string {
  const body = hasInboundHeader(content) ? stripChannelHeader(content, meta.interrupt_note === "true") : content.trim();
  return `👤 ${meta.user || meta.chat_id || "?"}：${clip(body, Number.MAX_SAFE_INTEGER, USER_CHARS)}`;
}

/** 回合失败：原因原文（脱敏），按种类给前缀 */
export function transcriptOfFailure(f: AcpFailure): string {
  const head = f.kind === "quota" ? "⛔ 额度用完" : f.kind === "auth" ? "🔑 需要登录" : "❌ 回合失败";
  return `${head}：${redactSecrets(f.message)}`;
}

export function transcriptOfStop(r: StopReport): string {
  return r.event === "Stop" ? "── 回合结束 ──" : r.interrupt ? "── 已打断 ──" : "── 回合失败 ──";
}

/** 一段 → 窗口里的行：首行带时间，续行缩进对齐 */
export function stampTranscript(item: string, at: Date = new Date()): string {
  return `[${at.toTimeString().slice(0, 8)}] ${item.replace(/\n/g, `\n${" ".repeat(STAMP_WIDTH)}`)}`;
}
