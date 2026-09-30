/**
 * token 账（T83）的纯逻辑：Claude Code 会话记录里哪一条是「外来输入」（开新一轮）、来源摘要怎么渲染和脱敏、
 * 一条 assistant 记录算哪一次调用。切轮规则的完整说明见 docs/architecture/token-usage.md，单测 tests/usage-classify.test.ts。
 */
import { channelMessageId, queuedPromptOf, unwrapChannelMessage } from "./session-history.js";
import { commandRecordLine } from "./inbound-body.js";
import { usageDedupKey } from "./jsonl-cost.js";

/** 触发一轮的来源 */
type InboundKind = "human" | "channel" | "peer" | "notification" | "scheduled" | "command" | "subagent" | "continued";

export interface Inbound {
  kind: InboundKind;
  /** 原文（还没渲染、没脱敏）；摘要用 triggerSummary 生成 */
  raw: string;
  /** channel 消息的 message_id：同一条消息既进队列附件又落 user 记录时认成同一轮 */
  messageId?: string;
}

type Rec = Record<string, any>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
}

const hasBlock = (content: unknown, type: string) => Array.isArray(content) && content.some((b) => b?.type === type);

/** 不是外来输入的 user 文本：打断标记、本地命令 / ! 命令的输出 */
const NOT_INBOUND_TEXT_RE = /^\s*(\[Request interrupted by user|<local-command-(stdout|stderr|caveat)>|<bash-(stdout|stderr)>)/;

function kindOfText(text: string): InboundKind {
  const t = text.trimStart();
  if (t.startsWith("<channel")) return "channel";
  if (t.startsWith("<task-notification")) return "notification";
  if (/^<command-(name|message)>/.test(t)) return "command";
  return "human";
}

function inbound(kind: InboundKind, raw: string): Inbound {
  const messageId = kind === "channel" ? channelMessageId(raw) ?? undefined : undefined;
  return messageId ? { kind, raw, messageId } : { kind, raw };
}

/**
 * 一条会话记录是不是外来输入（开新一轮）；不是返回 null。
 * 算：人敲的字 / 斜杠命令、channel 消息（含忙时被队列吸收进本轮的那种）、peer、空闲时的后台任务通知、定时任务。
 * 不算：工具结果、打断标记（归被打断的那一轮）、isMeta 附加（图片说明 / skill 正文 / stop hook）、compact 摘要、
 * 自动续跑、本地命令输出、忙时插进本轮的后台任务通知。
 */
export function inboundOf(rec: Rec): Inbound | null {
  if (rec?.type === "attachment") {
    const q = queuedPromptOf(rec);
    return q ? inbound(kindOfText(q), q) : null;
  }
  if (rec?.type !== "user" || rec.isCompactSummary) return null;
  const content = rec.message?.content;
  if (hasBlock(content, "tool_result")) return null;
  const text = textOf(content);
  if (NOT_INBOUND_TEXT_RE.test(text)) return null;
  const origin = typeof rec.origin === "object" ? rec.origin?.kind : rec.origin;
  if (origin === "channel") return inbound("channel", text);
  if (origin === "peer") return inbound("peer", text);
  if (origin === "task-notification") return inbound("notification", text);
  if (origin === "human") return inbound(kindOfText(text) === "command" ? "command" : "human", text);
  if (origin) return null; // auto-continuation 等：系统接着跑，不是新输入
  if (rec.scheduledTaskId) return inbound("scheduled", text);
  if (rec.isMeta) return null;
  if (!text.trim() && !hasBlock(content, "image")) return null;
  return inbound(kindOfText(text), text);
}

// ── 来源摘要 ────────────────────────────────────────────────────────────

const SUMMARY_CHARS = 80;

/** 已知形态的密钥 / token，以及「key=值」里名字像密钥的值 */
const SECRET_RES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g,
  /\b[a-f0-9]{32,}\b/gi,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}/g,
];
const BEARER_RE = /\b(bearer|token)\s+[A-Za-z0-9._~+/-]{12,}=*/gi;
const KV_SECRET_RE = /\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*)(["']?\s*[:=]\s*["']?)[^\s"',;&]{4,}/gi;

/** 把文本里像密钥的片段换成 [redacted]；先整段脱敏再截断，截断不会把半个密钥留下 */
export function redactSecrets(s: string): string {
  let out = s.replace(KV_SECRET_RE, "$1$2[redacted]").replace(BEARER_RE, "$1 [redacted]");
  for (const re of SECRET_RES) out = out.replace(re, "[redacted]");
  return out;
}

/** 通知 / 命令等带标签的原文 → 给人看的一行 */
function renderRaw(kind: InboundKind, raw: string): string {
  if (kind === "channel") return unwrapChannelMessage(raw)?.text ?? raw.replace(/<[^>]+>/g, " ");
  if (kind === "command") return commandRecordLine(raw) ?? raw.replace(/<[^>]+>/g, " ");
  if (kind === "notification") return /<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1] ?? raw.replace(/<[^>]+>/g, " ");
  return raw;
}

/** 来源摘要：渲染后的正文压成一行、脱敏、截到 80 字（按码点，不切半个 emoji） */
export function triggerSummary(i: Pick<Inbound, "kind" | "raw">): string {
  const line = redactSecrets(renderRaw(i.kind, i.raw).replace(/\s+/g, " ").trim());
  const chars = Array.from(line);
  return chars.length > SUMMARY_CHARS ? `${chars.slice(0, SUMMARY_CHARS).join("")}…` : line;
}

// ── 调用 ────────────────────────────────────────────────────────────────

export interface CallUsage {
  key: string;
  ts: number;
  model: string;
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** 这一行里的工具调用（同一响应的每个内容块各占一行，工具块散在不同行上） */
  tools: { id: string; name: string }[];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 一条带 usage 的 assistant 记录 → 一次调用。去重键与 cost 同一个（message.id + requestId）；
 * 没有 id 的老记录退回条目 uuid，重复导入同一行仍是同一个键。
 */
export function callOf(rec: Rec): CallUsage | null {
  if (rec?.type !== "assistant") return null;
  const u = rec.message?.usage;
  const ts = Date.parse(rec.timestamp);
  if (!u || !Number.isFinite(ts)) return null;
  const key = usageDedupKey(rec) ?? (typeof rec.uuid === "string" && rec.uuid ? `uuid:${rec.uuid}` : null);
  if (!key) return null;
  const content = Array.isArray(rec.message?.content) ? rec.message.content : [];
  const tools = content
    .filter((b: any) => (b?.type === "tool_use" || b?.type === "server_tool_use") && typeof b.id === "string")
    .map((b: any) => ({ id: b.id as string, name: typeof b.name === "string" ? b.name : "?" }));
  return {
    key, ts, model: typeof rec.message?.model === "string" ? rec.message.model : "unknown",
    input: num(u.input_tokens), cacheCreation: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens), output: num(u.output_tokens), tools,
  };
}
