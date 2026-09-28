/**
 * 历史里 API 错误条目（CC 的 isApiErrorMessage：撞额度 / 网络 / 5xx）画成一行系统提示，不当 agent 气泡；
 * 连续相同的并成一条「×N」（09-28 撞墙时一个频道铺出一串一模一样的报错）。直播一侧的同一规则在
 * web/features/chat/notice-merge.ts（web 与 src 互不 import，两边各自很短）。单测 tests/api-error-rows.test.ts。
 */
interface Row {
  seq: number;
  ts: string | null;
  role: "user" | "assistant" | "system";
  text: string;
}

/** 次数放在最前：手机上系统行一行放不下会截断尾部，放末尾就看不见了 */
const REPEAT_RE = /^⛔ ×(\d+) /;

/** 错误原文 → 一行提示（取首行，截 200 字）。 */
export function apiErrorNotice(text: string): string {
  const line = text.trim().split("\n")[0].slice(0, 200);
  return `⛔ ${line}`;
}

/**
 * rec 是 API 错误条目就按规则放进 rows 并返回 true（调用方 continue）；不是返回 false。
 * 合并时 seq / ts 取最新那条：网页的增量游标按 seq 往后取，停在旧 seq 上会把后面几次再取一遍。
 */
export function pushApiErrorRow(rows: Row[], rec: { isApiErrorMessage?: unknown; message?: { content?: unknown } }, seq: number, ts: string | null): boolean {
  if (rec.isApiErrorMessage !== true) return false;
  const blocks = Array.isArray(rec.message?.content) ? (rec.message!.content as { type?: string; text?: string }[]) : [];
  const text = apiErrorNotice(blocks.find((b) => b?.type === "text")?.text ?? "API Error");
  const prev = rows[rows.length - 1];
  if (prev?.role === "system" && prev.text.replace(REPEAT_RE, "⛔ ") === text) {
    const n = Number(REPEAT_RE.exec(prev.text)?.[1] ?? 1) + 1;
    Object.assign(prev, { seq, ts, text: text.replace(/^⛔ /, `⛔ ×${n} `) });
  } else {
    rows.push({ seq, ts, role: "system", text });
  }
  return true;
}
