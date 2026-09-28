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
 * 剥掉开头的 bridge 注入头；没有已知头或找不到边界就原样返回（去首尾空白）。
 * headerOnly：确知这条是 bridge 注入的（见 INJECTED_ATTR_RE），没有空行边界但以「]」结尾 = 正文为空的纯附件消息，
 * 整段都是头。不确知时不能这么判：用户自己打的「[🌐 其实] 普通 [话]」会被整段吃掉。
 */
export function stripChannelHeader(body: string, headerOnly = false): string {
  const s = body.trimStart(); // 尾部空行先别削：正文为空时它就是头的边界
  if (!INBOUND_HEAD_START_RE.test(s)) return s.trim();
  const m = HEAD_END_RE.exec(s);
  if (m) return s.slice(m.index + m[0].length).trim();
  return headerOnly && isSingleBlock(s) ? "" : s.trim();
}

/** 整段是一个方括号块：以「]」结尾且中间没有「]」+ 换行（5 月的旧通知是好几行 [🤖 …]\n[💡 …] 叠在一起，那是正文） */
function isSingleBlock(s: string): boolean {
  const x = s.trim();
  return x.endsWith("]") && !/]\r?\n/.test(x);
}

/** Pi 裸记录是否 bridge 注入的入站（据此还原成 <channel> 形状）：已知头 + 空行边界，或整段就是头（纯附件消息） */
export function hasInboundHeader(text: string): boolean {
  return INBOUND_HEAD_START_RE.test(text) && (HEAD_END_RE.test(text) || isSingleBlock(text));
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
 * 正文里已有附件行（Discord 入口、新 API 入口）就不再按属性补：属性按 ; 拆，文件名带分号会拆出假路径。
 */
export function channelBodyText(attrs: string, body: string): string {
  const text = stripChannelHeader(body, INJECTED_ATTR_RE.test(attrs));
  return (text.includes("[attachment: ") ? text : withAttachmentLines(text, channelAttachmentPaths(attrs))).trim();
}
