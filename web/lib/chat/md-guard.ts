/**
 * markdown 渲染的护栏（tests/web-md-guard.test.ts）：聊天消息与附件预览共用（components/domd）。
 * - mdTooHeavy：do-md 的行内解析按「段」（空行分隔）算，段内定界符一多耗时急剧上涨、还会栈溢出，与总大小关系不大。
 *   实测（headless chromium）：单段 `[` `](` 20 KB 0.56 s、50 KB 4.1 s；`*a _b ` 单段 50 KB 起栈溢出；
 *   行首 `- ` / `1. ` 约 400 层、同段裸链接约 1250 个栈溢出；表格 100 列 × 400 行 2 s（贵在列数 × 行数，3 列 3 万行只要 0.07 s）。
 *   do-md 的图片 / HTML 块正则会回溯：`![a](` 后接一串 `"`、`<a` 后接一串字母，单行 20 KB 1.4 s、60 KB 超过 30 s。
 *   真实文档单段定界符最多 1454。阈值内的最坏构造 ≤ 0.45 s。
 *   护栏只挡已知形状，却是短消息和 Worker 用不了时唯一的防线；长消息、附件另有 Worker 试解析的时间预算兜底，
 *   栈溢出 / 树太深由试解析接住（components/domd/use-plain-reason.ts）。渲染慢（嵌套总量、表格）只能靠这里。
 * - 链接只放行 http / https / mailto；图片分本机附件 / 内联 / 外链 / 其他，外链点了才加载（防追踪信标）。
 */

export const MD_MAX_BYTES = 200 * 1024;
export const MD_MAX_BLOCK_DELIMS = 2000;
export const MD_MAX_TOTAL_DELIMS = 16000;
export const MD_MAX_INDENT = 80;
export const MD_MAX_NEST = 50;
/** 全文 `|` 的个数（≈ 表格格数）：贵在 React 渲染，Worker 兜不住；1 万格 0.4–1.2 s，真实文档最多 2235 */
export const MD_MAX_TABLE_CELLS = 5000;
/** 行首由空白、`>`、列表 / 序号 / 任务框标记连成的一串的长度（嵌套写法五花八门，按长度兜底） */
export const MD_MAX_PREFIX = 100;
/** 任意一行的长度；含 `![` 或以 `<字母` 开头的正文行（会触发 do-md 回溯的两个正则）更短 */
export const MD_MAX_LINE = 8 * 1024;
export const MD_MAX_REGEX_LINE = 4 * 1024;
/** 去掉行首前缀后以 `<字母` 开头的行，全文累计长度（HTML 块正则的回溯随整篇超线性增长，单行限长挡不住多行；真实文档最多 449） */
export const MD_MAX_HTML_TOTAL = 4 * 1024;
/** `](` 到 `)` 之间的连续空白（图片 / 链接正则在这里是三次方级：1 KB 空白 2.7 s） */
export const MD_MAX_SRC_SPACE = 64;
/** 全文各行嵌套层数之和（每行都不超限、行数一多，React 渲染和排版照样卡：`- `×50 × 400 行 1–2 s） */
export const MD_MAX_NEST_TOTAL = 2000;

const DELIM = /[[\]()*_`~<!=\\]/g;
/** 裸链接（do-md 自动识别成链接）：一个比一个定界符贵得多，按 LINK_WEIGHT 个计 */
const AUTOLINK = /https?:\/\/|ftp:\/\/|www\./gi;
const LINK_WEIGHT = 8;
/** 行首连续的引用 / 列表标记（`> - 1. - [ ] x`）：每个是一层嵌套。和 do-md 一样按 `\s` 认空白（含 nbsp、全角空格、\f） */
const NEST_MARK = /\s*(?:>|[-*+](?=\s|$)|\d+[.)](?=\s|$))(?:\s+\[[ xX]\](?=\s|$))?/y;
const PREFIX = /^(?:\s|>|(?:[-*+]|\d+[.)]|\[[ xX]\])(?=\s|$))*/;
const HTML_START = /^<[a-zA-Z]/;

export function utf8Over(s: string, limit: number): boolean {
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

/** `](` 到下一个 `)`（没有就到行尾）之间最长的一串空白；逐字扫一遍，线性 */
function srcSpaceRun(line: string): number {
  let max = 0;
  for (let i = line.indexOf("]("); i >= 0; i = line.indexOf("](", i)) {
    let run = 0;
    for (i += 2; i < line.length && line[i] !== ")"; i++) {
      run = /\s/.test(line[i]) ? run + 1 : 0;
      if (run > max) max = run;
    }
  }
  return max;
}

/** 这一行本身就会让 do-md 卡住 / 栈溢出：太长、会回溯、行首嵌套太深。body = 去掉行首空白 / 列表 / 引用前缀后的部分 */
function lineTooHeavy(line: string, prefix: number): boolean {
  if (line.length > MD_MAX_LINE) return true;
  if (prefix > MD_MAX_PREFIX || indentOf(line) > MD_MAX_INDENT || nestOf(line) > MD_MAX_NEST) return true;
  const regexLine = line.includes("![") || HTML_START.test(line.slice(prefix));
  if (regexLine && line.length > MD_MAX_REGEX_LINE) return true;
  return line.includes("](") && srcSpaceRun(line) > MD_MAX_SRC_SPACE;
}

/** 交给 do-md 会卡住或栈溢出 → 调用方按纯文本显示 */
export function mdTooHeavy(md: string): boolean {
  if (utf8Over(md, MD_MAX_BYTES)) return true;
  if (md.split("\n").some((l) => l.length > MD_MAX_LINE)) return true; // 代码块里的超长行也算（Prism 上色同样吃不消）
  let block = 0;
  let total = 0;
  let cells = 0;
  let html = 0;
  let nest = 0;
  for (const line of proseOnly(md).split("\n")) {
    if (line === "") {
      block = 0; // 只认真正的空行：只含空白的行、CRLF 空行（"\r"）do-md 都不分段
      continue;
    }
    const prefix = PREFIX.exec(line)?.[0].length ?? 0;
    if (lineTooHeavy(line, prefix)) return true;
    if (HTML_START.test(line.slice(prefix)) && (html += line.length - prefix) > MD_MAX_HTML_TOTAL) return true;
    if ((nest += nestOf(line)) > MD_MAX_NEST_TOTAL) return true;
    if ((cells += line.split("|").length - 1) > MD_MAX_TABLE_CELLS) return true;
    const n = (line.match(DELIM)?.length ?? 0) + (line.match(AUTOLINK)?.length ?? 0) * LINK_WEIGHT;
    block += n;
    total += n;
    if (block > MD_MAX_BLOCK_DELIMS || total > MD_MAX_TOTAL_DELIMS) return true;
  }
  return false;
}

/** 去掉 src 末尾的 `"title"` / `'title'`：用 lastIndexOf 不用正则（`\s+"…"\s*$` 遇到长空白是平方级） */
function stripTitle(raw: string): string {
  const s = raw.trimEnd();
  const q = s[s.length - 1];
  if (q !== '"' && q !== "'") return s.trim();
  const open = s.lastIndexOf(q, s.length - 2);
  return open > 0 && /\s/.test(s[open - 1]) ? s.slice(0, open).trim() : s.trim();
}

/** do-md 图片节点的 src 原样带着 title、尖括号（`x.png "t"`、`<x y.png>`）：取出真正的地址 */
export function imageSrcOf(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = stripTitle(raw);
  return s.length > 1 && s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1).trim() : s;
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
