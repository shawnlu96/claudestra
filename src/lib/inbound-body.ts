/**
 * 入站消息正文的规整（历史解析、Pi 记录还原、API 入口共用）：剥 bridge 注入头、把附件路径落成 `[attachment: 路径]` 行。
 *
 * 附件为什么要进正文：web 的历史与直播都只认正文里的 `[attachment: …]`（web/lib/chat/attachments.ts 的 extractAttachments），
 * Pi 扩展也只注入正文。Discord 入口一直这么写；API 入口以前只放 channel 属性，纯附件消息的正文就只剩注入头，
 * 历史把头当成正文显示、图没了（tests/inbound-body.test.ts）。
 */

/** bridge 注入头（renderContentForLocal 写的 🌐 Web/API、🤖 本地 agent、🤝 peer，另有 📢/📣 广播）；普通以 [ 开头的文本不算 */
const INBOUND_HEAD_START_RE = /^\s*\[(🌐|🤖|🤝|📢|📣)/;

/**
 * 头块的结束边界：「]」后跟空行，或「]」就是全文结尾（正文为空的纯附件消息，trim 之后空行没了）。
 * 头里可能有「]」（如 [DIRECT]），所以不用第一个「]」；单个换行也不算边界（正文里会出现「]\n」）。
 */
const HEAD_END_RE = /](?:\r?\n\r?\n|\s*$)/;

/** 剥掉开头的 bridge 注入头；没有已知头或找不到边界就原样返回（去首尾空白） */
export function stripChannelHeader(body: string): string {
  const s = body.trim();
  if (!INBOUND_HEAD_START_RE.test(s)) return s;
  const m = HEAD_END_RE.exec(s);
  if (!m) return s;
  return s.slice(m.index + m[0].length).trim();
}

/** 已知的 bridge 注入头 + 边界齐全（Pi 裸记录据此判断能否还原成 <channel> 形状） */
export function hasInboundHeader(text: string): boolean {
  return INBOUND_HEAD_START_RE.test(text) && HEAD_END_RE.test(text.trim());
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
  const t = withoutAttachmentLines(text);
  return t || (attachmentCount > 0 ? `📎 ${attachmentCount} 个附件` : "");
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

/** channel 包装的属性串 + 内文 → 历史里显示的正文（剥头 + 补附件行）；空串表示没有可显示内容 */
export function channelBodyText(attrs: string, body: string): string {
  return withAttachmentLines(stripChannelHeader(body), channelAttachmentPaths(attrs)).trim();
}
