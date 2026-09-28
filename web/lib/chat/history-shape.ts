/**
 * 历史的纯变换（从已删的 BFF app/api/chat/history/route.ts 整体搬进前端，tests/web-history-shape.test.ts）：
 * bridge 的中性记录 → ChatMessage，并**合并同一回合的连续 assistant 记录**——CC 的 jsonl 里一个回合会被拆成很多条
 * （每个 tool_use / 每段 text 各一条），1:1 映射成气泡刷新后就「稀碎」；实时链路不碎是因为 ensureLiveAssistant 把整回合并进一个气泡。
 * 这里让历史对齐实时：连续 assistant 记录累积进一个气泡，遇到 user / system / compact 边界断开。
 */
import { matchClickedRow } from "./reply-clicks";
import { FormLookup } from "./form-restore";
import { parseInlineButtons, plainLabel } from "./inline-buttons";
import { stripMentionDirective } from "./mention-directive";
import type { ChatMessage, ToolCallView, AssistantSegment, ChatAttachmentView } from "@/features/chat/type";
import type { WebComponentRow } from "./events";
import { attachmentFromPath, extractAttachments } from "./attachments";

export interface NeutralMessage {
  seq: number;
  ts?: string;
  role: "user" | "assistant" | "system";
  text?: string;
  tools?: { name: string; summary: string; detail?: string; error?: boolean }[];
  /** reply() 的最终回复正文（后端从 jsonl 的 reply tool_use 提取） */
  replyText?: string;
  /** reply() 附带的按钮/选单 */
  replyComponents?: WebComponentRow[];
  /** reply() 出站附件文件名（basename） */
  replyFiles?: string[];
  /** 回合耗时 ms（正常收尾的回合才有）——历史尾轮据此渲染完成标记 */
  turnMs?: number;
  compactSummary?: boolean;
  /** 进度句（💭）：Fable 5.1 的 progress-update thinking 块 */
  progress?: string;
  /** 入站消息发送者标签（<channel> user 属性：API 凭据名 / Discord 用户名 / 来源 agent） */
  from?: string;
  /** 发送者 id（user_id）：认本人的所有来源 */
  fromId?: string;
}

/** owner 设备的聊天身份（§3：owner 的所有设备共享 chat_id = api:owner:self） */
export const OWNER_CHAT_ID = "api:owner:self";

/**
 * 这条入站消息是不是本人发的（任何来源）。有 fromId 按 id 认（自己的所有设备、自己的 Discord 账号都在 selfIds 里）；
 * 没有（老 bridge 的历史 / 事件）退回按旧 web token 名认。from 为空 = 本端乐观消息，本来就是本人。
 */
export function isSelfSource(from: string | undefined, fromId: string | undefined, selfIds: ReadonlySet<string>): boolean {
  if (!from) return true;
  if (fromId && selfIds.size) return selfIds.has(fromId);
  return from === "web-ui";
}

/** 本人的发送者 id 集合：自己的聊天身份 + bridge whoami 给的本人 Discord 账号 */
export function selfIdsFrom(principalId: string | undefined, whoami: { tokenId?: unknown; ownerIds?: unknown } | null): Set<string> {
  const ids = new Set<string>();
  ids.add(principalId ? `api:${principalId}` : OWNER_CHAT_ID);
  if (typeof whoami?.tokenId === "string" && whoami.tokenId) ids.add(`api:${whoami.tokenId}`);
  if (Array.isArray(whoami?.ownerIds)) for (const x of whoami.ownerIds) if (typeof x === "string" && x) ids.add(x);
  return ids;
}

export interface ShapeOpts {
  /** false = before 分页片段（片段尾不是全局尾轮，不标完成） */
  tail?: boolean;
  sid?: string;
  isHidden?: (seq: number) => boolean;
  selfIds?: ReadonlySet<string>;
}

function systemDivider(m: NeutralMessage, content: string, sid?: string): ChatMessage {
  return { id: `h${m.seq}`, role: "system", content, ts: m.ts, sid, seqEnd: m.seq };
}

/** 按钮 / 选单点击的机器 payload → 组件里的人类可读 label（与 live 乐观气泡同形），并回填该气泡的 replyClicks */
function resolveClick(text: string, anchor: ChatMessage | null, forms: FormLookup): string | null {
  const btnMatch = text.match(/^\[button:([\w-]+)\]$/);
  const selMatch = text.match(/^\[select:([\w-]+):(.+)\]$/);
  if (!btnMatch && !selMatch) return null;
  // 选单按 id 往前找最近一条含它的消息（owner 可能回头答更早的表单），按钮仍认最近锚点
  if (selMatch) anchor = forms.find(selMatch[1]) ?? anchor;
  if (anchor) {
    const clicked = matchClickedRow(anchor.replyComponents, btnMatch?.[1] ?? null, selMatch?.[1] ?? null, selMatch?.[2] ?? null);
    if (clicked) {
      (anchor.replyClicks ??= {})[clicked.rowKey] = clicked.choiceValue;
      return clicked.label;
    }
    if (btnMatch) {
      // 块级组件没命中 → 试行内按钮（正文里的 [[{#id}label]]）：rowKey 前缀 `i:`，与 InlineButton 的已答态判定同键
      const inline = parseInlineButtons(`${anchor.replyText ?? ""}\n${anchor.content ?? ""}`).find((b) => b.id === btnMatch[1]);
      if (inline) {
        (anchor.replyClicks ??= {})[`i:${inline.id}`] = inline.id;
        return plainLabel(inline.label);
      }
    }
  }
  return `🔘 ${btnMatch ? btnMatch[1] : selMatch![2]}`; // 组件气泡不在本页时兜底 id
}

function userMessage(m: NeutralMessage, anchor: ChatMessage | null, opts: ShapeOpts, forms: FormLookup): ChatMessage {
  const text = m.text || "";
  // CC 写入的中断标记 / TUI 斜杠命令记录不是用户打的字 → 轻分隔线
  if (/^\[Request interrupted/.test(text)) return systemDivider(m, "已被用户中断", opts.sid);
  const cmd = text.match(/^<command-name>(\/[\w-]+)<\/command-name>/);
  if (cmd) return systemDivider(m, cmd[1], opts.sid);
  const from = isSelfSource(m.from, m.fromId, opts.selfIds ?? new Set()) ? undefined : m.from; // 本人的所有来源都不标
  // 多选表单的回投（点「提交」或输入框同步行发出）统一还原成「【标题】✓ …」，与发送时的气泡一致
  let raw = forms.restore(text) ?? resolveClick(text, anchor, forms) ?? stripMentionDirective(text); // @ 委托指令行只给 agent 看
  // 外源入站剥掉 bridge 注入的来源头（[🤝 来自 peer…] 多行方括号块）——UI 用来源 chip 展示，留着就是双份说明
  if (from) raw = raw.replace(/^\[[^\]]{0,800}\]\s*\n*/, "");
  const { content, attachments } = extractAttachments(raw);
  return { id: `h${m.seq}`, role: "user", content, ts: m.ts, from, sid: opts.sid, seqEnd: m.seq, ...(attachments ? { attachments } : {}) };
}

/** assistant 记录并进当前回合气泡（首条建组）；segments 保留叙述 / 工具 / 回复的真实交错序 */
function accumulate(group: ChatMessage | null, m: NeutralMessage, toolCalls: ToolCallView[] | undefined, sid?: string): ChatMessage {
  const replyAtts = (m.replyFiles ?? []).map((f) => attachmentFromPath(f)).filter((a): a is ChatAttachmentView => !!a);
  let g = group;
  if (!g) {
    g = { id: `h${m.seq}`, role: "assistant", content: m.text || "", toolCalls, ts: m.ts, segments: [], sid, seqEnd: m.seq };
    if (m.replyText) g.replyText = m.replyText;
    if (m.replyComponents?.length) g.replyComponents = m.replyComponents;
    if (replyAtts.length) g.attachments = replyAtts;
  } else {
    g.seqEnd = m.seq; // 气泡覆盖的原始记录区间尾（「删除」按区间隐藏）
    if (m.text) g.content = g.content ? `${g.content}\n\n${m.text}` : m.text;
    if (toolCalls) g.toolCalls = [...(g.toolCalls ?? []), ...toolCalls];
    if (m.replyText) g.replyText = g.replyText ? `${g.replyText}\n${m.replyText}` : m.replyText;
    if (m.replyComponents?.length) g.replyComponents = [...(g.replyComponents ?? []), ...m.replyComponents];
    if (replyAtts.length) g.attachments = [...(g.attachments ?? []), ...replyAtts];
  }
  if (typeof m.turnMs === "number") g.turnMs = m.turnMs;
  if (m.replyText && !g.replyTs && m.ts) g.replyTs = m.ts; // reply 的时间与开场 ts 分开记
  const segs = g.segments as AssistantSegment[];
  if (m.progress) segs.push({ kind: "text", text: m.progress, ts: m.ts, progress: true }); // 进度句自成一段，不进 content
  if (m.text) {
    const tail = segs[segs.length - 1];
    if (tail?.kind === "text" && !tail.progress) tail.text += `\n\n${m.text}`;
    else segs.push({ kind: "text", text: m.text, ts: m.ts });
  }
  if (m.replyText) segs.push({ kind: "reply", text: m.replyText, ts: m.ts }); // reply 按时间序入段，不钉底
  if (toolCalls) {
    const tail = segs[segs.length - 1];
    if (tail?.kind === "tools") tail.tools.push(...toolCalls);
    else segs.push({ kind: "tools", tools: toolCalls });
  }
  return g;
}

export function toChatMessages(items: NeutralMessage[], opts: ShapeOpts = {}): ChatMessage[] {
  const out: ChatMessage[] = [];
  let group: ChatMessage | null = null; // 当前正在累积的 assistant 回合气泡
  // 最近一条带组件（块级或行内按钮）的 assistant 气泡：后续 user 的按钮点击 payload 命中它 → 「已答」态跨刷新持久
  let anchor: ChatMessage | null = null;
  const forms = new FormLookup();

  for (const m of items) {
    // 「删除」的隐藏区间：不输出；但 user/system 仍是 assistant 分组的断点——否则隐藏一条用户消息会把两侧回合合成一泡
    if (opts.isHidden?.(m.seq)) {
      if (m.role !== "assistant") group = null;
      continue;
    }
    if (m.compactSummary) continue; // compact 生成的长摘要不是真实用户输入
    // CRLF 归一：channel 注入链路会把 \n 变 \r\n，乐观 / 历史对账精确匹配会失败 → 同一条消息双份
    if (m.text) m.text = m.text.replace(/\r\n?/g, "\n");

    if (m.role === "system") {
      group = null;
      out.push(systemDivider(m, (m.text || "上下文已压缩").replace(/^[─—\s]+|[─—\s]+$/g, ""), opts.sid));
      continue;
    }
    const toolCalls: ToolCallView[] | undefined = m.tools?.length
      ? m.tools.map((t) => ({ name: t.name, summary: t.summary, state: t.error ? ("error" as const) : ("done" as const), ts: m.ts, ...(t.detail ? { detail: t.detail } : {}) }))
      : undefined;
    if (!m.text && !toolCalls && !m.replyText && !m.progress) continue;

    if (m.role === "user") {
      group = null;
      out.push(userMessage(m, anchor, opts, forms));
      continue;
    }
    const g = accumulate(group, m, toolCalls, opts.sid);
    if (!group) out.push(g);
    group = g;
    // 行内按钮也算「可作答锚点」；必须真解析出按钮才算，纯 [[wiki]] 文本不能把带组件的老锚点顶掉
    if (g.replyComponents?.length || parseInlineButtons(`${m.replyText ?? ""}\n${m.text ?? ""}`).length > 0) anchor = g;
    forms.add(g);
  }
  // 完成标记只给「历史尾轮」：最后一条是 assistant 且回合正常收尾（turnMs 来自 turn_duration，进行中 / 被打断的没有）
  if (opts.tail !== false) {
    const tail = out[out.length - 1];
    if (tail?.role === "assistant" && typeof tail.turnMs === "number") tail.turnDone = true;
  }
  return out;
}
