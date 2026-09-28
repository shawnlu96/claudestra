/**
 * 媒体索引的逐行抽取（纯函数）：一条已翻译成 Claude Code 形状的会话记录 → 里面人与 agent 之间传的附件引用。
 *  - 我发的：<channel> 头里的 attachments="a;b" 是 bridge 落盘后写的，**唯一可信**的「消息 → 文件」绑定（trusted）；
 *    正文里的 `[attachment: /path]`、旧 BFF 的 `[用户上传了 N 个文件…]`、裸 user 文本都是发送者能随手写的，
 *    只作不可信引用（非 manage 调用方只拿到占位，见 media-query.isRestricted；伪造标记读别的 agent 的文件 = T22 审查 P0）；
 *    回合中途被队列吸收的入站消息落成 attachment/queued_command 记录，同一 message_id 另有 user 记录时以后者为准（prio 高）；
 *  - agent 发的：reply 工具调用的 input.files（agent 本地路径；副本由 bridge 拷进 inbox 并记账，见 media-outbound.ts）。
 * agent↔agent 消息（is_agent="true"）与 bridge 注入（user="bridge:*"）不收：媒体视图只看人和 agent 之间的往来。
 */
import { channelAttachmentPaths } from "./inbound-body.js";
import { isReplyTool, queuedPromptOf } from "./session-history.js";

export interface MediaRef {
  seq: number;
  ts: string | null;
  /** 同一条消息里的第几个附件 */
  idx: number;
  dir: "in" | "out";
  /** 入站消息的发送者标签（<channel user=…>）；出站为空，由索引层填 agent 名 */
  sender?: string;
  /** 记录里的原始路径（入站 = 落盘位置；出站 = agent 本地路径，真正的副本要去 inbox 按名字 + 时间找） */
  path: string;
  /** 入站消息的 bridge message_id：同一条消息的 queued 记录与 user 记录按它合并 */
  mid?: string;
  /** 同 mid 两份记录时谁说了算：user 记录 1，queued 记录 0 */
  prio: number;
  /** 入站：路径来自 bridge 写的头属性（可信）；正文标记为 false。出站恒 false，可信与否由副本账本决定 */
  trusted: boolean;
  /** 入站发送者 id（<channel user_id=…>）：前端据此认「我发的」 */
  senderId?: string;
}

const ATTACH_TAG_RE = /\[attachment:\s*([^\]\n]+)\]/g;
const BFF_BLOCK_RE = /\[用户上传了 \d+ 个文件[^\n\]]*:\s*\n((?:\s*- [^\n]+\n?)+)\s*\]/g;

/** 正文里的附件路径（两种 wire 格式，按出现顺序） */
export function attachmentPathsInText(text: string): string[] {
  const hits: { at: number; path: string }[] = [];
  for (const m of text.matchAll(ATTACH_TAG_RE)) hits.push({ at: m.index ?? 0, path: m[1].trim() });
  for (const m of text.matchAll(BFF_BLOCK_RE)) {
    let off = 0;
    for (const line of m[1].split("\n")) {
      const p = /^\s*- (.+)$/.exec(line)?.[1]?.trim();
      if (p) hits.push({ at: (m.index ?? 0) + off++, path: p });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.path).filter(Boolean);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n");
}

const CHANNEL_HEAD_RE = /^\s*<channel\s+([^>]*)>/;

/** 头里的普通属性（发送者、message_id 等；附件路径走 inbound-body.channelAttachmentPaths，它会解码 XML 实体） */
function attr(attrs: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];
}

/** canTrust：记录本身是 bridge 投递的（isMeta 的 channel 消息 / queued_command）；裸 user 文本里自称的 <channel> 头不算 */
function inboundRefs(raw: string, seq: number, ts: string | null, prio: number, canTrust: boolean): MediaRef[] {
  const head = canTrust ? CHANNEL_HEAD_RE.exec(raw) : null;
  const base = { seq, ts, dir: "in" as const, prio };
  // isMeta 却没有 channel 头 = caveat / 命令输出，不是消息；裸 user 文本只给不可信引用
  if (!head) return canTrust ? [] : attachmentPathsInText(raw).map((path, idx) => ({ ...base, idx, path, trusted: false }));
  const attrs = head[1];
  const sender = attr(attrs, "user");
  if ((sender && /^bridge(:|$)/.test(sender)) || attr(attrs, "is_agent") === "true") return [];
  const who = { sender, senderId: attr(attrs, "user_id"), mid: attr(attrs, "message_id") };
  // 头属性（可信）在前；正文里的标记只补头属性里没有的（不可信）
  const trusted = channelAttachmentPaths(attrs);
  const body = attachmentPathsInText(raw.slice(head[0].length)).filter((p) => !trusted.includes(p));
  return [...trusted.map((path) => ({ path, trusted: true })), ...[...new Set(body)].map((path) => ({ path, trusted: false }))]
    .map((r, idx) => ({ ...base, ...who, ...r, idx }));
}

/** 一条记录 → 附件引用（没有返回空数组）。rec 是 translateSessionLine 的结果。 */
export function mediaRefsOf(rec: any, seq: number): MediaRef[] {
  if (!rec || typeof rec !== "object") return [];
  const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
  if (rec.type === "attachment") {
    const queued = queuedPromptOf(rec);
    return queued ? inboundRefs(queued, seq, ts, 0, true) : [];
  }
  if (rec.type === "user") {
    const text = textOf(rec.message?.content);
    if (!text) return [];
    if (rec.isCompactSummary === true) return []; // 压缩摘要里复述的路径不是一次新的发送
    // 非 meta 的裸 user 文本（更早的直敲 / 旧格式）没有 channel 头：inboundRefs 只给不可信引用
    return inboundRefs(text, seq, ts, 1, rec.isMeta === true);
  }
  if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
    const out: MediaRef[] = [];
    for (const b of rec.message.content) {
      if (b?.type !== "tool_use" || typeof b.name !== "string" || !isReplyTool(b.name)) continue;
      if (!Array.isArray(b.input?.files)) continue;
      for (const f of b.input.files) {
        if (typeof f === "string" && f.trim()) out.push({ seq, ts, idx: out.length, dir: "out", path: f.trim(), prio: 1, trusted: false });
      }
    }
    return out;
  }
  return [];
}

/**
 * 零解析预筛：一行不含这些字节就不可能带附件，大会话里绝大多数行在字节层面就跳过。
 * 出站 files 的标记太常见（工具参数、配置文件内容里都有），所以要求同一行里还有 `reply"`（MCP 名与 Pi 裸名都以它结尾）；
 * Codex 的工具参数是 JSON 字符串，引号被转义，单列一种写法。
 */
export const MEDIA_MARKERS = { inbound: ["[attachment:", "用户上传了", 'attachments=\\"'], outbound: ['"files":[', '\\"files\\":['], outboundNeeds: 'reply"' };
