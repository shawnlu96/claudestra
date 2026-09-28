/**
 * 媒体索引的逐行抽取（纯函数）：一条已翻译成 Claude Code 形状的会话记录 → 里面人与 agent 之间传的附件引用。
 * 认的形态与历史面板一致（session-history.parseHistoryLines / web lib/chat/attachments.extractAttachments）：
 *  - 我发的：<channel> 入站消息正文里的 `[attachment: /path]`，旧 BFF 的 `[用户上传了 N 个文件…:\n- /path]`；
 *    回合中途被队列吸收的入站消息落成 attachment/queued_command 记录，同一 message_id 另有 user 记录时以后者为准（prio 高）；
 *  - agent 发的：reply 工具调用的 input.files（绝对路径，bridge 投递时另拷一份进 inbox）。
 * agent↔agent 消息（is_agent="true"）与 bridge 注入（user="bridge:*"）不收：媒体视图只看人和 agent 之间的往来。
 */
import { channelMessageId, isReplyTool, queuedPromptOf, unwrapChannelMessage } from "./session-history.js";

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

/** 行首 <channel …> 头里的属性（is_agent 不在 unwrapChannelMessage 的返回里） */
function channelHeader(raw: string): string {
  return /^\s*<channel\s+([^>]*)>/.exec(raw)?.[1] ?? "";
}

function inboundRefs(raw: string, seq: number, ts: string | null, prio: number, wrapped: boolean): MediaRef[] {
  let text = raw;
  let sender: string | undefined;
  let mid: string | undefined;
  if (wrapped) {
    const un = unwrapChannelMessage(raw);
    if (!un) return [];
    if (un.from && /^bridge(:|$)/.test(un.from)) return [];
    if (/(?:^|\s)is_agent="true"/.test(channelHeader(raw))) return [];
    text = un.text;
    sender = un.from;
    mid = channelMessageId(raw) ?? undefined;
  }
  return attachmentPathsInText(text).map((path, idx) => ({ seq, ts, idx, dir: "in" as const, sender, path, mid, prio }));
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
    // isMeta + <channel> = 入站消息；非 meta 的裸 user 文本里带标记的是更早的直敲 / 旧格式，照样认
    if (rec.isMeta === true) return inboundRefs(text, seq, ts, 1, true);
    if (rec.isCompactSummary === true) return []; // 压缩摘要里复述的路径不是一次新的发送
    return inboundRefs(text, seq, ts, 1, false);
  }
  if (rec.type === "assistant" && Array.isArray(rec.message?.content)) {
    const out: MediaRef[] = [];
    for (const b of rec.message.content) {
      if (b?.type !== "tool_use" || typeof b.name !== "string" || !isReplyTool(b.name)) continue;
      if (!Array.isArray(b.input?.files)) continue;
      for (const f of b.input.files) {
        if (typeof f === "string" && f.trim()) out.push({ seq, ts, idx: out.length, dir: "out", path: f.trim(), prio: 1 });
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
export const MEDIA_MARKERS = { inbound: ["[attachment:", "用户上传了"], outbound: ['"files":[', '\\"files\\":['], outboundNeeds: 'reply"' };
