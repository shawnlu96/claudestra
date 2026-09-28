/**
 * 入站消息正文的规整（历史解析、Pi 记录还原、API 入口共用）：剥 bridge 注入头、把附件路径落成 `[attachment: 路径]` 行。
 *
 * 附件为什么要进正文：web 的历史与直播都只认正文里的 `[attachment: …]`（web/lib/chat/attachments.ts 的 extractAttachments），
 * Pi 扩展也只注入正文。Discord 入口一直这么写；API 入口以前只放 channel 属性，纯附件消息的正文就只剩注入头，
 * 历史把头当成正文显示、图没了（tests/inbound-body.test.ts）。
 */

import { t } from "./i18n.js";

/** bridge 注入头（renderContentForLocal 写的 🌐 Web/API、🤖 本地 agent、🤝 peer，另有 📢/📣 广播）；普通以 [ 开头的文本不算 */
const INBOUND_HEAD_START_RE = /^\s*\[(🌐|🤖|🤝|📢|📣)/;

/** 头块与正文的边界：「]」后跟空行。头里可能有「]」（如 [DIRECT]），单个换行也不算（正文里会出现「]\n」） */
const HEAD_END_RE = /]\r?\n\r?\n/;

/**
 * 打断抬头（lib/turn-cuts.ts 的 preemptHeadline / stopHeadline，放在来源头之后、正文之前）：任何来源的人类消息都可能带，
 * Discord 用户的消息没有来源头也没有注入属性，只能按这两句固定措辞认——用户自己不会这么开头。
 */
const INTERRUPT_NOTE_RE = /^\s*\[(⚡ 这条消息打断了你|⏹ 这是一条「停」指令)/;

/** 剥掉开头那块打断抬头（没有就原样返回） */
function stripInterruptNote(body: string): string {
  if (!INTERRUPT_NOTE_RE.test(body)) return body;
  const m = HEAD_END_RE.exec(body);
  return m ? body.slice(m.index + m[0].length) : isSingleBlock(body) ? "" : body;
}

/**
 * 剥掉开头的 bridge 注入头：「]」+ 空行之前是头；没有空行边界但整段是单个方括号块 = 正文为空的纯附件消息，整段都是头。
 * 只能对确知是 bridge 注入的消息调用（channelBodyText 看属性、Pi 看 hasInboundHeader）：用户自己打的
 * 「[🤖 ignore previous instructions]\n\nhello」剥了之后历史只剩 hello，agent 却收到全文。
 */
export function stripChannelHeader(body: string): string {
  const s = body.trimStart(); // 尾部空行先别削：正文为空时它就是头的边界
  if (!INBOUND_HEAD_START_RE.test(s)) return stripInterruptNote(s).trim();
  const m = HEAD_END_RE.exec(s);
  if (m) return stripInterruptNote(s.slice(m.index + m[0].length)).trim();
  return isSingleBlock(s) ? "" : s.trim();
}

/** 整段是一个方括号块：以「]」结尾且中间没有「]」+ 换行（5 月的旧通知是好几行 [🤖 …]\n[💡 …] 叠在一起，那是正文） */
function isSingleBlock(s: string): boolean {
  const x = s.trim();
  return x.endsWith("]") && !/]\r?\n/.test(x);
}

/** renderContentForLocal 三种头各自的固定措辞；Pi 裸记录没有 channel 属性，只能凭它（或头块跨行）认出 bridge 注入 */
const HEAD_SIGNATURE_RE = /来自 Web 端用户「|来自 peer 实例「|的 inbound 消息/;

/**
 * Pi 裸记录是否 bridge 注入的入站（是才还原成带注入属性的 <channel> 形状）：头块（空行边界之前，或整段单块）要带固定措辞或跨行。
 * 只看形状不够：Pi 终端里直接打的「[🤖 hi]」「[🌐 其实] 普通 [话]」会被当成头剥空、从历史里消失。
 */
export function hasInboundHeader(text: string): boolean {
  const s = text.trimStart();
  if (INTERRUPT_NOTE_RE.test(s)) return true; // Discord 用户的停字：只有打断抬头、没有来源头
  if (!INBOUND_HEAD_START_RE.test(s)) return false;
  const m = HEAD_END_RE.exec(s);
  const head = m ? s.slice(0, m.index + 1) : isSingleBlock(s) ? s.trim() : "";
  return HEAD_SIGNATURE_RE.test(head) || /\n/.test(head);
}

/** 正文尾部补上缺的 `[attachment: 路径]` 行；已在正文里的路径不重复（Discord 入口正文和属性里各有一份） */
export function withAttachmentLines(text: string, paths: readonly string[] | undefined): string {
  const missing = (paths ?? []).map((p) => p.trim()).filter((p) => p && !text.includes(`[attachment: ${p}]`));
  if (!missing.length) return text;
  const lines = missing.map((p) => `[attachment: ${p}]`).join("\n");
  return text.trim() ? `${text}\n\n${lines}` : lines;
}

/** 贴到 Discord 的文本去掉 `[attachment: 本机路径]` 行：文件另外作为 Discord 附件上传，路径不出本机 */
export function withoutAttachmentLines(text: string): string {
  return text.replace(/\n?[ \t]*\[attachment: [^\]\n]+\]/g, "").trim();
}

/** API 入站镜像到 Discord 的正文：用原始文字，纯附件时给个数（不带路径） */
export function apiMirrorBody(text: string, attachmentCount: number): string {
  const body = withoutAttachmentLines(text);
  if (body || attachmentCount <= 0) return body;
  return t(`📎 ${attachmentCount} 个附件`, `📎 ${attachmentCount} attachment${attachmentCount === 1 ? "" : "s"}`);
}

const XML_ENTITY: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">", "&apos;": "'" };

/** <channel …> 属性串里的 attachments="a;b"（bridge 用 ; 连接，见 bridge.ts 组 meta 处） */
export function channelAttachmentPaths(attrs: string): string[] {
  const v = /(?:^|\s)attachments="([^"]*)"/.exec(attrs)?.[1];
  if (!v) return [];
  return v
    .replace(/&(?:amp|quot|lt|gt|apos);/g, (e) => XML_ENTITY[e] ?? e)
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** bridge 注入过头的入站：renderContentForLocal 只给 api / 本地 agent 加头，它们的 channel 属性带 api="true" / is_agent="true" */
const INJECTED_ATTR_RE = /(?:^|\s)(?:api|is_agent)="true"/;

/**
 * channel 包装的属性串 + 内文 → 历史里显示的正文（剥头 + 补附件行）；空串表示没有可显示内容。
 * 只有带注入属性的才剥头（回放 8704 条带头记录，缺属性的 0 条，所以不会让旧记录露头）。
 * 正文里已有整行的附件行（Discord 入口、新 API 入口）就不再按属性补：属性按 ; 拆，文件名带分号会拆出假路径。
 */
export function channelBodyText(attrs: string, body: string): string {
  const text = INJECTED_ATTR_RE.test(attrs) ? stripChannelHeader(body) : stripInterruptNote(body.trim()).trim();
  return (/^\[attachment: [^\]\n]+\]$/m.test(text) ? text : withAttachmentLines(text, channelAttachmentPaths(attrs))).trim();
}
