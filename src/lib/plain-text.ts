/**
 * reply 正文（Markdown + 行内微语法）→ 纯文本：推送通知、APNs 横幅这类只认纯文本的地方用。
 * owner 09-28：「通知的时候不要带着那种样式信息，你把内容先去掉样式，变成纯文本，再作为通知内容。」
 * 不追求还原排版，只求不露出 ** | [[{…}]] 这些记号：表格行按「 · 」连起来、分隔行丢掉，其余去掉标记留文字。
 * 代码（行内代码、代码块）与反斜杠转义先挖出来占位、最后原样放回——里面的 <T>、__init__、*.ts 都不是样式。
 * HTML 只剥已知标签名，`kill <name>`、`x<y`、Discord 时间戳 <t:…> 原样保留。强调记号只在词边界生效（2**10、foo__bar 不动）。
 * 输入先截到 MAX_INPUT：通知只显示一两百字，别让超长 reply 在 bridge 里跑平方级正则（审查员实测过病态输入）。
 * tests/plain-text.test.ts
 */
import { inlineButtonsToText } from "./inline-buttons.js";

const MAX_INPUT = 4000;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HTML_TAGS = "a|abbr|b|big|blockquote|br|center|code|del|details|div|em|font|h[1-6]|hr|i|img|ins|kbd|li|mark|ol|p|pre|q|s|small|span|strike|strong|sub|summary|sup|table|tbody|td|th|thead|tr|u|ul";
const HTML_TAG_RE = new RegExp(`<\\/?(?:${HTML_TAGS})(?:\\s[^<>]*)?\\/?>`, "gi");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
/** 占位符用私有区字符：正文里不会自然出现，也不会被下面任何一条规则吃掉 */
const HOLE = (i: number) => `${i}`;

function lineToPlain(line: string): string {
  if (TABLE_SEPARATOR.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return ""; // 表格分隔行、分割线
  let s = line
    .replace(/^\s{0,3}#{1,6}\s+/, "") // 标题
    .replace(/^\s*(>\s?)+/, "") // 引用
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ""); // 列表、任务列表
  if (/^\s*\|.*\|\s*$/.test(s)) {
    s = s.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · "); // 表格行
  }
  return s
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1") // 图片 → alt
    .replace(/\[([^\]\n]+)\]\((?:[^)(\n]|\([^)\n]*\))*\)/g, "$1") // 链接 → 文字
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1") // 自动链接
    .replace(HTML_TAG_RE, "") // 已知 HTML 标签
    .replace(/(^|[^\w*])(\*\*|__)(?=\S)(.*?\S)\2(?![\w*])/g, "$1$3") // 粗体（词边界）
    .replace(/(^|[^\w~])~~(?=\S)(.*?\S)~~(?![\w~])/g, "$1$2") // 删除线
    .replace(/(^|[^\w=])==(?=\S)(.*?\S)==(?![\w=])/g, "$1$2") // 高亮
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2") // *斜体*
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2") // _斜体_
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e] ?? _); // 常见实体
}

/** Markdown + 行内按钮 / chip → 纯文本（保留换行，调用方自己决定怎么压成一行） */
export function markdownToPlain(input: string): string {
  const holes: string[] = [];
  const keep = (s: string) => HOLE(holes.push(s) - 1);
  const out: string[] = [];
  let inFence = false;
  for (const raw of inlineButtonsToText(input.slice(0, MAX_INPUT)).split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence; // 围栏行丢掉
      continue;
    }
    if (inFence) {
      out.push(keep(raw)); // 代码块内容原样
      continue;
    }
    const guarded = raw
      .replace(/`+([^`\n]*?)`+/g, (_, code: string) => keep(code)) // 行内代码：去反引号、内容原样
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~=])/g, (_, ch: string) => keep(ch)); // 反斜杠转义 → 字面字符
    out.push(lineToPlain(guarded));
  }
  return out.join("\n").replace(/(\d+)/g, (_, i: string) => holes[Number(i)] ?? "");
}
