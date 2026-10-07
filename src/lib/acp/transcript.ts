/**
 * ACP 宿主窗口里的可读会话（只看）：tmux attach / 网页终端打开 ACP agent 时看到的就是这些行。输入是宿主推给 bridge 的
 * 同一批条目（updates.ts 翻好的，正文已按消息攒齐，不会一个 chunk 一行），这里只读不改，网页聊天流不受影响。
 * 一律先脱敏（redact-secrets.ts）再显示。成功的工具输出只报行数（满屏半截代码会把结论淹掉），失败的留末尾几行（错误在最后）；
 * 命令压成一行人话（tool-display-format.ts summarizeCommand）。连接 / 生命周期日志不进这里，只进 host.log（src/acp-host.ts）。
 * tests/acp-transcript.test.ts、tests/acp-transcript-view.test.ts。
 */
import { hasInboundHeader, stripChannelHeader } from "../inbound-body.js";
import { redactSecrets } from "../redact-secrets.js";
import { formatTool, summarizeCommand } from "../tool-display-format.js";
import type { AcpFailure } from "./failures.js";
import type { StopReport } from "./turn.js";
import { OUTPUT_TAIL } from "./updates.js";

type Rec = Record<string, any>;

/** 正文 / reply 也设上限：一条消息可以是几百 KB（长报告），整段灌进 pane 会挤爆历史 */
const SHOW_LINES = 2, FAIL_LINES = 4, RESULT_CHARS = 400, USER_CHARS = 2_000, TEXT_LINES = 200, TEXT_CHARS = 6_000, ONE_LINE = 200;
/** 先脱敏再截断：只扫开头这么多，比最长的显示（6000 字）多出一条长 JWT 的余量，截断处不会留下半个密钥 */
const SCAN_CHARS = 16_000;
const STAMP_WIDTH = "[00:00:00] ".length;

/**
 * 只扫开头 SCAN_CHARS：截在一个词中间时，那半个词可能是半个密钥、规则认不出，退到最后一个空白处。
 * 摘要会剥掉命令前缀（cd … &&），扫描窗口的尾巴因此可能成为显示内容，不退回就会把半个密钥摆出来。
 */
function scanHead(raw: string): string {
  if (raw.length <= SCAN_CHARS) return raw;
  const s = raw.slice(0, SCAN_CHARS);
  return s.slice(0, Math.max(0, s.search(/\s\S*$/)));
}

/** 截到 lines 行、chars 字；截了就注明原本多少行 */
function clip(raw: string, lines: number, chars: number): string {
  const s = redactSecrets(scanHead(raw)).trim();
  const all = s.split("\n");
  let out = all.slice(0, lines).join("\n");
  if (out.length > chars) out = out.slice(0, chars);
  return out.length < s.length || raw.length > SCAN_CHARS ? `${out}…（共 ${raw.split("\n").length} 行）` : out;
}

const oneLine = (s: unknown): string => clip(String(s ?? "").replace(/\s*\n\s*/g, " "), 1, ONE_LINE);

/** 交给 formatTool 之前逐个字段先打码：它会在 80 / 200 字处截断，截剩的半个密钥匹配不上规则 */
const redactDeep = (v: unknown): unknown =>
  typeof v === "string" ? redactSecrets(scanHead(v))
    : Array.isArray(v) ? v.map(redactDeep)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) : v;

const PLAN_MARK: Record<string, string> = { completed: "✓", in_progress: "▸" };

function toolLine(name: string, input: Rec): string {
  if (name === "reply" || name.endsWith("__reply")) return `💬 回复：${clip(String(input?.text ?? ""), TEXT_LINES, TEXT_CHARS)}`;
  if (name === "Bash") return `💻 ${oneLine(summarizeCommand(redactSecrets(scanHead(String(input?.command ?? "")))))}`;
  if (name === "update_plan") {
    const steps = (Array.isArray(input?.plan) ? input.plan : []).map((p: Rec) => `  ${PLAN_MARK[p?.status] ?? "·"} ${oneLine(p?.step)}`);
    return ["📋 计划", ...steps].join("\n");
  }
  return oneLine(formatTool(redactSecrets(name), redactDeep(input)));
}

/** 留末尾 lines 行：先脱敏再截；扫描窗口截在半行上时那行整行不要（里面可能是半个密钥） */
function tail(raw: string, lines: number, chars: number): string {
  let s = redactSecrets(raw.slice(-SCAN_CHARS));
  if (raw.length > SCAN_CHARS) s = s.includes("\n") ? s.slice(s.indexOf("\n") + 1) : "";
  const out = s.trimEnd().split("\n").slice(-lines).join("\n");
  return out.length > chars ? `…${out.slice(-chars)}` : out;
}

function resultLine(b: Rec): string[] {
  if (String(b.tool_use_id ?? "").startsWith("acp-plan-")) return []; // 计划工具的固定回执（updates.ts plan），没有信息量
  const c = b.content;
  const raw = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: Rec) => (x?.type === "text" ? String(x.text ?? "") : "")).join("\n") : "";
  // 只留了末尾的命令输出（updates.ts），开头那行是截出来的半行，里面可能是半个密钥、规则认不出：整行不要
  const cut = raw.length >= OUTPUT_TAIL;
  const text = (cut ? (raw.includes("\n") ? raw.slice(raw.indexOf("\n") + 1) : "") : raw).trim();
  const n = text ? text.split("\n").length : 0, total = `${n}${cut ? "+" : ""}`;
  const mark = b.is_error ? "✗" : "↳";
  let body: string;
  if (!n) body = cut ? "输出过长，前面截掉了" : "无输出";
  else if (b.is_error) body = n > FAIL_LINES ? `（共 ${total} 行，末尾 ${FAIL_LINES} 行）\n${tail(text, FAIL_LINES, RESULT_CHARS)}` : tail(text, FAIL_LINES, RESULT_CHARS);
  else body = n <= SHOW_LINES && !cut ? clip(text, SHOW_LINES, ONE_LINE) : `${total} 行输出`;
  return [`  ${mark} ${body.replace(/\n/g, "\n    ")}`];
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
  return `👤 ${oneLine(meta.user || meta.chat_id || "?")}：${clip(body, Number.MAX_SAFE_INTEGER, USER_CHARS)}`; // 来源标签也是外来的，同样打码
}

/** 回合失败：原因原文（脱敏），按种类给前缀 */
export function transcriptOfFailure(f: AcpFailure): string {
  const head = f.kind === "quota" ? "⛔ 额度用完" : f.kind === "auth" ? "🔑 需要登录" : "❌ 回合失败";
  return `${head}：${redactSecrets(f.message)}`;
}

export function transcriptOfStop(r: StopReport): string {
  return r.event === "Stop" ? "── 回合结束 ──" : r.interrupt ? "── 已打断 ──" : "── 回合失败 ──";
}

const PARAGRAPH = /^(🤖|💬|👤)/u;

/**
 * 一段 → 窗口里的行。正文 / 回复 / 收到的消息是段落起点：前面空一行、必带时间；其余行只在分钟变了时带时间，
 * 不带的用等宽空白对齐，续行同样对齐。有状态（记上一行的分钟），一个窗口一个实例。
 * 进窗口前最后再打一遍码（各段已在截断前打过；兜住以后新加的显示）
 */
export function createTranscriptStamper(): (item: string, at?: Date) => string {
  let lastMinute = "", started = false;
  return (item, at = new Date()) => {
    const time = at.toTimeString().slice(0, 8), para = PARAGRAPH.test(item);
    const head = para || time.slice(0, 5) !== lastMinute ? `[${time}] ` : " ".repeat(STAMP_WIDTH);
    const gap = para && started ? "\n" : "";
    lastMinute = time.slice(0, 5);
    started = true;
    return `${gap}${head}${redactSecrets(item).replace(/\n/g, `\n${" ".repeat(STAMP_WIDTH)}`)}`;
  };
}

/** 宿主进程只有一个窗口：src/acp-host.ts 直接用这个实例 */
export const stampTranscript = createTranscriptStamper();
