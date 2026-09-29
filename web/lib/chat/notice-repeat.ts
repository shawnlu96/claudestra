/**
 * ⛔ API 错误系统行的规则（src / web 各一份，登记成 twin：scripts/guard/config.ts TWINS，去注释后逐行一致，改一边另一边跟着改）：
 * 历史（src/lib/api-error-rows.ts）、直播（web/features/chat/notice-merge.ts）、网页差量拼接（web/features/chat/live-merge.ts）都用它。
 */

/** 次数放在最前：手机上系统行一行放不下会截断尾部，放末尾就看不见了 */
const REPEAT_RE = /^⛔ ×(\d+) /;

/** 错误原文 → 一行提示（取首行，截 200 字） */
export function noticeText(raw: string): string {
  return `⛔ ${raw.trim().split("\n")[0].slice(0, 200)}`;
}

/** 去掉「×N」之后是不是同一条提示 */
export function sameNotice(a: string, b: string): boolean {
  return a.startsWith("⛔ ") && a.replace(REPEAT_RE, "⛔ ") === b.replace(REPEAT_RE, "⛔ ");
}

/** 已有的一行（可能带 ×N）再来一次同样的：次数 +1 后的文本 */
export function bumpRepeat(prev: string): string {
  const n = Number(REPEAT_RE.exec(prev)?.[1] ?? 1) + 1;
  return prev.replace(REPEAT_RE, "⛔ ").replace(/^⛔ /, `⛔ ×${n} `);
}
