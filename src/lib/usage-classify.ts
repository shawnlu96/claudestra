/**
 * token 账（T83）的纯逻辑：Claude Code 会话记录里哪一条是「外来输入」（开新一轮）、来源摘要怎么渲染和脱敏、
 * 一条 assistant 记录算哪一次调用。切轮规则的完整说明见 docs/architecture/token-usage.md，单测 tests/usage-classify.test.ts。
 */
import { channelMessageId, queuedPromptOf, unwrapChannelMessage } from "./session-history.js";
import { commandRecordLine } from "./inbound-body.js";
import { usageDedupKey } from "./jsonl-cost.js";
import { redactSecrets } from "./redact-secrets.js";

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
  // 老格式的 channel 消息没有 origin、只有 isMeta：认完整的 channel 包装（与历史视图同一个解包），不能当附加信息吞掉
  if (unwrapChannelMessage(text)) return inbound("channel", text);
  if (rec.isMeta) return null;
  if (!text.trim() && !hasBlock(content, "image")) return null;
  return inbound(kindOfText(text), text);
}

// ── 来源摘要 ────────────────────────────────────────────────────────────

const SUMMARY_CHARS = 80;

/** 通知 / 命令等带标签的原文 → 给人看的一行 */
function renderRaw(kind: InboundKind, raw: string): string {
  if (kind === "channel") return unwrapChannelMessage(raw)?.text ?? raw.replace(/<[^>]+>/g, " ");
  if (kind === "command") return commandRecordLine(raw) ?? raw.replace(/<[^>]+>/g, " ");
  if (kind === "notification") return /<summary>([\s\S]*?)<\/summary>/.exec(raw)?.[1] ?? raw.replace(/<[^>]+>/g, " ");
  return raw;
}

/**
 * 同一条外来输入的身份：channel 消息的 message_id + 渲染后正文的哈希。队列附件和随后的 user 记录是同一条输入的两份，身份相同；
 * 同一张卡片上的几次按钮 / 选择共用卡片的 message_id，正文不同，身份也不同。没有 message_id 的输入不会有两份，返回 undefined。
 */
export function inboundIdentity(i: Inbound): string | undefined {
  if (!i.messageId) return undefined;
  return `${i.messageId}#${Bun.hash(renderRaw(i.kind, i.raw).replace(/\s+/g, " ").trim()).toString(36)}`;
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
  /** 推理 token，单列、不含在 output 里（Codex 才有；Claude 的 thinking 算在 output 里，这里恒 0） */
  reasoning?: number;
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
