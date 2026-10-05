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
  /** open：这次读到的范围里还没有 tool_result（bridge lib/session-history.ts）；id = tool_use id */
  tools?: { name: string; summary: string; detail?: string; error?: boolean; id?: string; open?: boolean }[];
  /** reply() 的最终回复正文（后端从 jsonl 的 reply tool_use 提取） */
  replyText?: string;
  /** reply() 附带的按钮/选单 */
  replyComponents?: WebComponentRow[];
  /** reply() 出站附件文件名（basename） */
  replyFiles?: string[];
  /** reply() 建出的「待你处理」id（后端从 reply 的 tool_result 解析） */
  replyAskId?: string;
  /** 回合耗时 ms（正常收尾的回合才有）——历史尾轮据此渲染完成标记 */
  turnMs?: number;
  compactSummary?: boolean;
  /** 进度句（💭）：Fable 5.1 的 progress-update thinking 块 */
  progress?: string;
  /** 入站消息发送者标签（<channel> user 属性：API 凭据名 / Discord 用户名 / 来源 agent） */
  from?: string;
  /** 发送者 id（user_id）：认本人的所有来源 */
  fromId?: string;
  /** owner 对「待你处理」的作答：答的是哪条 ask（bridge 从答复第一行解析，lib/inbound-body.ts answerEcho） */
  askId?: string;
  /** 同上，owner 的原文（text 已换成选项人话；原文用来回填按钮已答态、和乐观气泡对账） */
  wire?: string;
  /** bridge 真收下的附件路径（服务端只取 channel 头属性，lib/inbound-body.ts channelAttachments）：外源的附件卡片只认它 */
  attachments?: string[];
  /** CC 忙时队列吸收、并进当前回合的入站（服务端按 queued_command 记录标）：回合切分不把它当边界 */
  midTurn?: boolean;
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
  /** 界面语言（「已清空上下文」分隔的文案）；缺省中文 */
  lang?: string;
}

/**
 * 全量页之后还能不能往上翻：本 session 没拿满一页，也要看清单里还有没有更旧的 session（翻到头会接上它，见 lib/api/history.ts 的 before 分支）。
 * 只按条数判的话，/clear 后不满 500 条的新会话会报 false，「加载更早」不出现，clear 前的记录整段接不上（CLR1）。
 */
export function fullLoadHasMore(count: number, sids: string[], sid: string): boolean {
  return count >= 500 || sids.indexOf(sid) + 1 < sids.length;
}

/** /clear 换代的分隔文案：直播（session_rotated）与历史（新会话开头 CC 记的那条 /clear）同一句，直播侧按它去重 */
export function rotationNotice(sid: string, lang: string): string {
  return lang === "zh" ? `🧹 已清空上下文，新会话 ${sid.slice(0, 8)}` : `🧹 Context cleared — new session ${sid.slice(0, 8)}`;
}

function systemDivider(m: NeutralMessage, content: string, sid?: string): ChatMessage {
  return { id: `h${m.seq}`, role: "system", content, ts: m.ts, sid, seqEnd: m.seq };
}

/** 按钮 / 选单点击的机器 payload → 组件里的人类可读 label（与 live 乐观气泡同形），并回填该气泡的 replyClicks */
function resolveClick(text: string, anchor: ChatMessage | null, forms: FormLookup): ResolvedClick | null {
  const btnMatch = text.match(/^\[button:([\w-]+)\]$/);
  const selMatch = text.match(/^\[select:([\w-]+):(.+)\]$/);
  if (!btnMatch && !selMatch) return null;
  // 选单按 id 往前找最近一条含它的消息（owner 可能回头答更早的表单），按钮仍认最近锚点
  const answer = selMatch && `${selMatch[1]}:${selMatch[2].split(",").map((v) => v.trim()).filter(Boolean).join(",")}`; // 与 matchClickedRow 存的已答值同形
  if (selMatch) anchor = forms.find(selMatch[1], answer!) ?? anchor;
  if (anchor) {
    const clicked = matchClickedRow(anchor.replyComponents, btnMatch?.[1] ?? null, selMatch?.[1] ?? null, selMatch?.[2] ?? null);
    if (clicked) {
      (anchor.replyClicks ??= {})[clicked.rowKey] = clicked.choiceValue;
      return { text: clicked.label, resolved: true };
    }
    if (btnMatch) {
      // 块级组件没命中 → 试行内按钮（正文里的 [[{#id}label]]）：rowKey 前缀 `i:`，与 InlineButton 的已答态判定同键
      const inline = parseInlineButtons(`${anchor.replyText ?? ""}\n${anchor.content ?? ""}`).find((b) => b.id === btnMatch[1]);
      if (inline) {
        (anchor.replyClicks ??= {})[`i:${inline.id}`] = inline.id;
        return { text: plainLabel(inline.label), resolved: true };
      }
    }
  }
  return { text: `🔘 ${btnMatch ? btnMatch[1] : selMatch![2]}`, resolved: false }; // 组件气泡不在本页时兜底 id
}

interface ResolvedClick {
  text: string;
  /** false = 所属表单不在这段消息里，文案是兜底（或还留着 [select:…] 行），合进更早的消息后可以再解析一次 */
  resolved: boolean;
}
const LEFT_SELECT = /^\s*\[select:[\w-]+:.+\]\s*$/m;

/** 用户消息若是按钮 / 表单回投 → 可读文案并回填所属表单的已答；不是回投 → null。多选表单的整段回投还原成「【标题】✓ …」 */
export function resolveUserClick(text: string, anchor: ChatMessage | null, forms: FormLookup): ResolvedClick | null {
  const restored = forms.restore(text);
  if (restored !== null) return { text: restored, resolved: !LEFT_SELECT.test(restored) };
  return resolveClick(text, anchor, forms) ?? (LEFT_SELECT.test(text) ? { text, resolved: false } : null);
}

/** 可作答锚点：带块级组件，或正文里真解析出了行内按钮（纯 [[wiki]] 文本不能把带组件的老锚点顶掉） */
export function hasClickTargets(replyText: string | undefined, text: string | undefined, components?: WebComponentRow[]): boolean {
  return !!components?.length || parseInlineButtons(`${replyText ?? ""}\n${text ?? ""}`).length > 0;
}

/**
 * 一个气泡最多一条带按钮的 reply：两条都带就另起气泡（直播 setReplyText、整段 toChatMessages、差量 mergeContiguousAssistant 同一口径）。
 * 气泡按 replyAskId 整泡认领（use-reply-ask），两条带 ask 的 reply 并成一泡时，前一段的「批准」会带着后一条的 id 批新参数（adv3 P1）
 */
export function splitsReplyBubble(bubble: Pick<ChatMessage, "replyText" | "replyComponents">, replyText?: string, components?: WebComponentRow[]): boolean {
  return hasClickTargets(bubble.replyText, undefined, bubble.replyComponents) && hasClickTargets(replyText, undefined, components);
}

const WIRE_LINE = /^\[(?:button|select):[^\]\n]+\]$/;

/**
 * owner 对「待你处理」的作答：原文里每一行按钮 / 选单回投都回填所答气泡的已答态，正文照旧显示 bridge 给的人话。
 * 所答气泡按 replyAskId 认（卡片上答的可能是很早的一条），认不到退回最近的锚点；刷新（这里）和直播（delta-clicks）同一套
 */
export function markAnswerClicks(wire: string, anchor: ChatMessage | null, forms: FormLookup): void {
  for (const l of wire.split("\n")) if (WIRE_LINE.test(l.trim())) resolveUserClick(l.trim(), anchor, forms);
}

/** 建出这条 ask 的 reply 气泡（最近的那个）；没有 askId / 不在已加载的消息里 → null */
export function askAnchor(messages: readonly ChatMessage[], askId: string | undefined): ChatMessage | null {
  if (!askId) return null;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant" && messages[i].replyAskId === askId) return messages[i];
  return null;
}

/**
 * 用户正文 → 显示正文 + 附件卡片：认定是本人的剥掉附件行；不可信的（外源，或记录里没有来源）原文照显，卡片只按服务端给的真附件路径 verified 画
 * （stream-shape 直播同一口径）。不可信正文里的 [attachment: …] 只当文字：外人写一行 [attachment: /not-an-upload/id_rsa]，owner 会看到一张像是对方真发了文件的卡片
 */
export function foreignAware(text: string, untrusted: boolean, verified?: readonly string[]): { content: string; attachments?: ChatAttachmentView[] } {
  if (!untrusted) return extractAttachments(text);
  const atts = (verified ?? []).map((p) => attachmentFromPath(p)).filter((a): a is ChatAttachmentView => !!a);
  return { content: text.trim(), ...(atts.length ? { attachments: atts } : {}) };
}

function userMessage(m: NeutralMessage, anchor: ChatMessage | null, opts: ShapeOpts, forms: FormLookup): ChatMessage {
  const text = m.text || "";
  const from = isSelfSource(m.from, m.fromId, opts.selfIds ?? new Set()) ? undefined : m.from; // 本人的所有来源都不标
  // CC 自己写的中断标记 / 斜杠命令记录由服务端按会话类型认成 system 条目（lib/cc-own-records.ts），网页不再按文本认：
  // Pi 裸记录里写这两种开头的是用户正文，按文本认会变成一条分隔线、正文全藏（tests/pi-foreign-attachments.test.ts）
  // 不可信 = 外源，或记录里没有来源（Pi 裸记录：Discord 用户直发 Pi 的原文，本人和外人分不出）。下面按文本的还原 / 剥除只对认定是本人的做
  const untrusted = !!from || !m.from;
  const own = untrusted ? text : stripMentionDirective(text); // @ 委托指令行只给 agent 看；只剥本人的（外源的末行照原样给 owner 看）
  // 按钮 / 选单回投只认本人：外源正文里写一行 [button:go] / [select:…]，owner 会看到「✅ 发版」、表单被标已答，agent 收到的却是原文
  // （T31，直播 delta-clicks.ts 同一道闸）。外源的回投照原文显示，不碰任何表单
  if (m.wire && !untrusted) markAnswerClicks(m.wire, anchor, forms); // 作答：正文已是人话，原文只用来回填已答态
  const click = m.wire || untrusted ? null : resolveUserClick(own, anchor, forms);
  // bridge 注入的来源头只由服务端按 channel 属性剥（lib/inbound-body.ts channelBodyText）；网页对外源正文不做任何按文本的剥除，
  // 附件行也留在正文里、卡片只是附加预览——否则外人写一行 [attachment: 任意路径]，owner 只看到一个文件名，agent 拿到的是路径
  const { content, attachments } = foreignAware(click?.text ?? own, untrusted, m.attachments);
  const pending = click && !click.resolved ? { clickRaw: own } : {}; // 存剥过指令行的：翻页补解析时不能把指令行带回气泡
  const ask = { ...(m.askId ? { askId: m.askId } : {}), ...(m.wire ? { wire: m.wire } : {}), ...(m.midTurn ? { midTurn: true } : {}) };
  return { id: `h${m.seq}`, role: "user", content, ts: m.ts, from, sid: opts.sid, seqEnd: m.seq, ...(attachments ? { attachments } : {}), ...pending, ...ask };
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
    if (m.replyAskId) g.replyAskId = m.replyAskId;
  } else {
    g.seqEnd = m.seq; // 气泡覆盖的原始记录区间尾（「删除」按区间隐藏）
    if (m.text) g.content = g.content ? `${g.content}\n\n${m.text}` : m.text;
    if (toolCalls) g.toolCalls = [...(g.toolCalls ?? []), ...toolCalls];
    if (m.replyText) g.replyText = g.replyText ? `${g.replyText}\n${m.replyText}` : m.replyText;
    if (m.replyComponents?.length) g.replyComponents = [...(g.replyComponents ?? []), ...m.replyComponents];
    if (m.replyAskId) g.replyAskId = m.replyAskId; // 带按钮的 reply 一泡只有一条（splitsReplyBubble），这里是唯一那条的
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

/**
 * 没结果的工具卡记成 running：回合中每 7s 的差量会把直播卡换成历史卡，记成 done 的话跑着的 Bash 几秒后就显示成已完成、计时也没了。
 * 带上 id，直播的 tool-state 才找得到它收尾；running 只在回合进行中的最后一张卡上显示为运行中（components/tool-rows.tsx）。
 */
function toolView(t: NonNullable<NeutralMessage["tools"]>[number], ts?: string): ToolCallView {
  const state = t.error ? "error" : t.open ? "running" : "done";
  return { name: t.name, summary: t.summary, state, ts, ...(t.detail ? { detail: t.detail } : {}), ...(t.id ? { id: t.id } : {}) };
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
      // CC 把 /clear 记在新会话开头：刷新后走历史时，两个会话的接缝处也是这句（与直播的 session_rotated 一致）
      const cleared = opts.sid && /^\/clear(\s|$)/.test(m.text ?? "");
      out.push(systemDivider(m, cleared ? rotationNotice(opts.sid!, opts.lang ?? "zh") : (m.text || "上下文已压缩").replace(/^[─—\s]+|[─—\s]+$/g, ""), opts.sid));
      continue;
    }
    const toolCalls: ToolCallView[] | undefined = m.tools?.length ? m.tools.map((t) => toolView(t, m.ts)) : undefined;
    if (!m.text && !toolCalls && !m.replyText && !m.progress) continue;

    if (m.role === "user") {
      group = null;
      out.push(userMessage(m, askAnchor(out, m.askId) ?? anchor, opts, forms));
      continue;
    }
    if (group && splitsReplyBubble(group, m.replyText, m.replyComponents)) group = null;
    const g = accumulate(group, m, toolCalls, opts.sid);
    if (!group) out.push(g);
    group = g;
    if (hasClickTargets(m.replyText, m.text, g.replyComponents)) anchor = g;
    forms.add(g);
  }
  // 完成标记只给「历史尾轮」：最后一条是 assistant 且回合正常收尾（turnMs 来自 turn_duration，进行中 / 被打断的没有）
  if (opts.tail !== false) {
    const tail = out[out.length - 1];
    if (tail?.role === "assistant" && typeof tail.turnMs === "number") tail.turnDone = true;
  }
  return out;
}
