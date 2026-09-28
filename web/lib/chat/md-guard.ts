/**
 * markdown 渲染的护栏（tests/web-md-guard.test.ts）：聊天消息与附件预览共用（components/domd）。
 * - mdTooHeavy：do-md 的行内解析按「段」（空行分隔）算，段内定界符一多耗时急剧上涨、还会栈溢出，与总大小关系不大。
 *   实测（headless chromium）：单段 `[` `](` 20 KB 0.56 s、50 KB 4.1 s；`*a _b ` 单段 50 KB 起栈溢出；
 *   行首 `- ` / `1. ` 约 400 层、同段裸链接约 1250 个栈溢出；表格 100 列 × 400 行 2 s（贵在列数 × 行数，3 列 3 万行只要 0.07 s）。
 *   do-md 的图片 / HTML 块正则会回溯：`![a](` 后接一串 `"`、`<a` 后接一串字母，单行 20 KB 1.4 s、60 KB 超过 30 s。
 *   真实文档单段定界符最多 1454。阈值内的最坏构造 ≤ 0.45 s。
 *   护栏只挡已知形状；漏网的由 components/domd 兜底（先试解析 + 查树深，渲染出错退回纯文本）。
 * - 链接只放行 http / https / mailto；图片分本机附件 / 内联 / 外链 / 其他，外链点了才加载（防追踪信标）。
 */

export const MD_MAX_BYTES = 200 * 1024;
export const MD_MAX_BLOCK_DELIMS = 2000;
export const MD_MAX_TOTAL_DELIMS = 16000;
export const MD_MAX_INDENT = 80;
export const MD_MAX_NEST = 50;
/** 一段 / 全文里 `|` 的个数（≈ 表格列数 × 行数） */
export const MD_MAX_TABLE_CELLS = 10000;
export const MD_MAX_TOTAL_CELLS = 20000;
/** 行首由空白、`>`、列表 / 序号 / 任务框标记连成的一串的长度（嵌套写法五花八门，按长度兜底） */
export const MD_MAX_PREFIX = 100;
/** 任意一行的长度；含 `![` 或以 `<字母` 开头的正文行（会触发 do-md 回溯的两个正则）更短 */
export const MD_MAX_LINE = 8 * 1024;
export const MD_MAX_REGEX_LINE = 4 * 1024;

const DELIM = /[[\]()*_`~<!=\\]/g;
/** 裸链接（do-md 自动识别成链接）：一个比一个定界符贵得多，按 LINK_WEIGHT 个计 */
const AUTOLINK = /https?:\/\/|ftp:\/\/|www\./gi;
const LINK_WEIGHT = 8;
/** 行首连续的引用 / 列表标记（`> - 1. - [ ] x`）：每个是一层嵌套。和 do-md 一样按 `\s` 认空白（含 nbsp、全角空格、\f） */
const NEST_MARK = /\s*(?:>|[-*+](?=\s|$)|\d+[.)](?=\s|$))(?:\s+\[[ xX]\](?=\s|$))?/y;
const PREFIX = /^(?:\s|>|(?:[-*+]|\d+[.)]|\[[ xX]\])(?=\s|$))*/;
/** do-md 图片正则 / HTML 块正则会回溯的行 */
const REGEX_LINE = /!\[|^\s*<[a-zA-Z]/;

function utf8Over(s: string, limit: number): boolean {
  if (s.length > limit) return true; // 每个 UTF-16 单元至少 1 字节
  if (s.length * 3 <= limit) return false;
  return new TextEncoder().encode(s).length > limit;
}

/** 行首缩进的列数（tab 按 4 列，其他空白按 1 列） */
function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === "\t") n += 4;
    else if (/\s/.test(ch)) n++;
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
 * - 第 0 列（或上一个代码块刚结束处）的 ``` 开始，到下一个任意位置的 ``` 结束（同一行、行中间都算），没闭合就吞到文末；
 * - 紧跟非空行时（段落 / HTML / `\` 开头…）它在段内解析，段在下一个 `\n\n` 就断了：取两者中较早的；
 * - `~~~` 和缩进的 ``` 它不认，这里也不认。判宽了会漏掉炸弹，拿不准的一律少去（tests/web-md-guard.test.ts）。
 */
function proseOnly(md: string): string {
  let out = "";
  let i = 0;
  let afterEmpty = true; // 文首或紧跟空行（只认真正的空行 ""：do-md 只在 \n\n 处分段）
  while (i < md.length) {
    if (md.startsWith("```", i)) {
      const close = md.indexOf("```", i + 3);
      const cut = afterEmpty ? -1 : md.indexOf("\n\n", i);
      out += "\n\n";
      if (cut >= 0 && (close < 0 || cut < close)) {
        i = cut + 2;
        afterEmpty = true;
        continue;
      }
      if (close < 0) break;
      i = close + 3;
      afterEmpty = false;
      continue;
    }
    const nl = md.indexOf("\n", i);
    const stop = nl < 0 ? md.length : nl + 1;
    out += md.slice(i, stop);
    afterEmpty = md[i] === "\n";
    i = stop;
  }
  return out;
}

/** 这一行本身就会让 do-md 卡住 / 栈溢出：太长、会回溯、行首嵌套太深 */
function lineTooHeavy(line: string): boolean {
  if (line.length > MD_MAX_LINE) return true;
  if (line.length > MD_MAX_REGEX_LINE && REGEX_LINE.test(line)) return true;
  if (indentOf(line) > MD_MAX_INDENT || nestOf(line) > MD_MAX_NEST) return true;
  return (PREFIX.exec(line)?.[0].length ?? 0) > MD_MAX_PREFIX;
}

/** 交给 do-md 会卡住或栈溢出 → 调用方按纯文本显示 */
export function mdTooHeavy(md: string): boolean {
  if (utf8Over(md, MD_MAX_BYTES)) return true;
  if (md.split("\n").some((l) => l.length > MD_MAX_LINE)) return true; // 代码块里的超长行也算（Prism 上色同样吃不消）
  let block = 0;
  let total = 0;
  let cells = 0;
  let allCells = 0;
  for (const line of proseOnly(md).split("\n")) {
    if (!line.trim()) {
      block = cells = 0;
      continue;
    }
    if (lineTooHeavy(line)) return true;
    const pipes = line.split("|").length - 1;
    cells += pipes;
    allCells += pipes;
    if (cells > MD_MAX_TABLE_CELLS || allCells > MD_MAX_TOTAL_CELLS) return true;
    const n = (line.match(DELIM)?.length ?? 0) + (line.match(AUTOLINK)?.length ?? 0) * LINK_WEIGHT;
    block += n;
    total += n;
    if (block > MD_MAX_BLOCK_DELIMS || total > MD_MAX_TOTAL_DELIMS) return true;
  }
  return false;
}

/** alt / src 都不跨过下一个 `[` / `(`：每次尝试最多扫到下一处 `![`，`![` 连一行也是线性的 */
const IMAGE_MD = /!\[([^[\]\n]{0,500})\]\(([^()\n]{0,2048})\)/g;

/** `![alt](src)` 里的 alt，按 src 查（do-md 的 Img 节点只带 src，拦下的图片要显示 alt 得回原文找）；同一 src 取第一个 */
export function imageAlts(md: string): Map<string, string> {
  const alts = new Map<string, string>();
  for (const m of md.matchAll(IMAGE_MD)) {
    const src = m[2].replace(/\s+"[^"]*"\s*$/, "").trim();
    if (!alts.has(src)) alts.set(src, m[1]);
  }
  return alts;
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
  return !name.startsWith(".") && !/[/\\\u0000-\u001f\u007f]/.test(name); // 和服务端 safeAttachmentName 同一套
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
