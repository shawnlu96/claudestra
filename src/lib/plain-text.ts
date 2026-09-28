/**
 * reply 正文（Markdown + 行内微语法）→ 纯文本：推送通知、APNs 横幅这类只认纯文本的地方用。
 * owner 09-28：「通知的时候不要带着那种样式信息，你把内容先去掉样式，变成纯文本，再作为通知内容。」
 * 不追求还原排版，只求不露出 ** | [[{…}]] 这些记号：表格行按「 · 」连起来、分隔行丢掉，其余去掉标记留文字。
 * 下划线斜体只在两侧不是字母数字时才剥（file_name 这类不是格式）。tests/plain-text.test.ts
 */
import { inlineButtonsToText } from "./inline-buttons.js";

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

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
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 → alt
    .replace(/\[([^\]]+)\]\((?:[^)(]|\([^)]*\))*\)/g, "$1") // 链接 → 文字
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1") // 自动链接
    .replace(/<\/?[a-zA-Z][^>]*>/g, "") // HTML 标签
    .replace(/`([^`]*)`/g, "$1") // 行内代码
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2") // 粗体
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1") // 删除线
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2") // *斜体*
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2"); // _斜体_
}

/** Markdown + 行内按钮 / chip → 纯文本（保留换行，调用方自己决定怎么压成一行） */
export function markdownToPlain(text: string): string {
  const out: string[] = [];
  for (const line of inlineButtonsToText(text).split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) continue; // 代码块围栏丢掉，内容保留
    out.push(lineToPlain(line));
  }
  return out.join("\n");
}
