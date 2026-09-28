/**
 * markdown 渲染的护栏（tests/web-md-guard.test.ts）：聊天消息与附件预览共用（components/domd）。
 * - mdTooHeavy：do-md 的行内解析按「段」（空行分隔）算，段内定界符一多耗时急剧上涨、还会栈溢出，与总大小关系不大。
 *   实测（headless chromium）：单段 `[` `](` 20 KB 0.56 s、50 KB 4.1 s；`*a _b ` 单段 50 KB 起栈溢出；
 *   行首 `- ` / `1. ` 约 400 层、同段裸链接约 1250 个栈溢出；表格 100 列 × 400 行 2 s（贵在列数 × 行数，3 列 3 万行只要 0.07 s）。
 *   真实文档单段定界符最多 1454。阈值内的最坏构造 ≤ 0.45 s。
 * - 链接只放行 http / https / mailto；图片分本机附件 / 内联 / 外链 / 其他，外链点了才加载（防追踪信标）。
 */

export const MD_MAX_BYTES = 200 * 1024;
export const MD_MAX_BLOCK_DELIMS = 2000;
export const MD_MAX_TOTAL_DELIMS = 16000;
export const MD_MAX_INDENT = 80;
export const MD_MAX_NEST = 50;
/** 一段里 `|` 的个数（≈ 表格列数 × 行数） */
export const MD_MAX_TABLE_CELLS = 10000;

const DELIM = /[[\]()*_`~<!=\\]/g;
/** 裸链接（do-md 自动识别成链接）：一个比一个定界符贵得多，按 LINK_WEIGHT 个计 */
const AUTOLINK = /https?:\/\/|ftp:\/\/|www\./gi;
const LINK_WEIGHT = 8;
/** 行首连续的引用 / 列表标记（`> - 1. x`）：每个是一层嵌套 */
const NEST_MARK = /[ \t]*(?:>|[-*+](?=[ \t]|$)|\d{1,9}[.)](?=[ \t]|$))/y;

function utf8Over(s: string, limit: number): boolean {
  if (s.length > limit) return true; // 每个 UTF-16 单元至少 1 字节
  if (s.length * 3 <= limit) return false;
  return new TextEncoder().encode(s).length > limit;
}

/** 行首缩进的列数（tab 按 4 列） */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

/** 行首连续嵌套标记的个数（数到超限就停：`- ` 重复几万次的一行不能数成平方） */
function nestOf(line: string): number {
  let n = 0;
  NEST_MARK.lastIndex = 0;
  while (n <= MD_MAX_NEST && NEST_MARK.test(line)) n++;
  return n;
}

/**
 * 去掉 do-md 当成代码块、不做行内解析的部分（换成空行，块边界不变）。规则照抄 do-md 0.11.2：
 * 第 0 列（或上一个代码块刚结束处）的 ``` 开始，到下一个任意位置的 ``` 结束——同一行、行中间都算；没闭合就吞到文末；
 * `~~~` 和缩进的 ``` 它不认，这里也不认（按正文计数）。判宽了会漏掉炸弹，所以宁可少去（tests/web-md-guard.test.ts）。
 */
function proseOnly(md: string): string {
  let out = "";
  let i = 0;
  while (i < md.length) {
    if (md.startsWith("```", i)) {
      const end = md.indexOf("```", i + 3);
      if (end < 0) break;
      out += "\n\n";
      i = end + 3;
      continue;
    }
    const nl = md.indexOf("\n", i);
    const stop = nl < 0 ? md.length : nl + 1;
    out += md.slice(i, stop);
    i = stop;
  }
  return out;
}

/** 交给 do-md 会卡住或栈溢出 → 调用方按纯文本显示 */
export function mdTooHeavy(md: string): boolean {
  if (utf8Over(md, MD_MAX_BYTES)) return true;
  let block = 0;
  let total = 0;
  let cells = 0;
  for (const line of proseOnly(md).split("\n")) {
    if (!line.trim()) {
      block = cells = 0;
      continue;
    }
    cells += line.split("|").length - 1;
    if (cells > MD_MAX_TABLE_CELLS) return true;
    if (indentOf(line) > MD_MAX_INDENT || nestOf(line) > MD_MAX_NEST) return true;
    const n = (line.match(DELIM)?.length ?? 0) + (line.match(AUTOLINK)?.length ?? 0) * LINK_WEIGHT;
    block += n;
    total += n;
    if (block > MD_MAX_BLOCK_DELIMS || total > MD_MAX_TOTAL_DELIMS) return true;
  }
  return false;
}

/** 链接只放行这三种协议；javascript: / data: / file: / 相对路径都按纯文本显示 */
export function safeLinkHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const h = href.trim();
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

export type ImageSrcKind = "attachment" | "inline" | "external" | "blocked";

/** 本机附件：只认单段文件名（可带 ?d=日期），和 attachmentUrl 拼出来的一致 */
const ATTACHMENT_SRC = /^\/api\/v1\/attachments\/([^/?#\\]+)(?:\?d=\d{4}-\d{2}-\d{2})?$/;

/** 解码后仍是单个普通文件名：`..` / `%2e%2e`（浏览器照样当上一级）/ 编码的分隔符都不行，否则会带凭据 GET 别的接口 */
function isAttachmentSrc(s: string): boolean {
  const m = ATTACHMENT_SRC.exec(s);
  if (!m) return false;
  let name: string;
  try {
    name = decodeURIComponent(m[1]);
  } catch {
    return false; // 编码不合法：不是 attachmentUrl 拼出来的，按其他地址处理
  }
  return !name.startsWith(".") && !/[/\\\u0000-\u001f]/.test(name);
}

/** 本机附件（带凭据取）/ data: blob:（照常显示）/ http(s) 外链（点了才加载）/ 其他（只显示 alt，含不合规的附件路径） */
export function imageSrcKind(src: unknown): ImageSrcKind {
  if (typeof src !== "string") return "blocked";
  const s = src.trim();
  if (isAttachmentSrc(s)) return "attachment";
  if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return "inline";
  if (/^https?:\/\//i.test(s)) return "external";
  return "blocked";
}

/** 占位上显示的来源域名；解析不了给空串 */
export function imageHost(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return ""; // imageSrcKind 已判过是 http(s)，这里失败只是地址本身不合法：占位不显示域名
  }
}
