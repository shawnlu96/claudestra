/**
 * 历史里 API 错误条目（CC 的 isApiErrorMessage：撞额度 / 网络 / 5xx；Codex 的额度条目不带它、带 error，直播里也按 ⛔ 画）
 * 画成一行系统提示，不当 agent 气泡；
 * 连续相同的并成一条「×N」（09-28 撞墙时一个频道铺出一串一模一样的报错）。规则在 notice-repeat.ts（与 web/lib/chat/notice-repeat.ts
 * 是 twin，直播一侧 web/features/chat/notice-merge.ts 用同一份）。单测 tests/api-error-rows.test.ts。
 */
import { bumpRepeat, noticeText, sameNotice } from "./notice-repeat.js";
import { isLimitHitText } from "./quota-wall-text.js";

interface Row {
  seq: number;
  ts: string | null;
  role: "user" | "assistant" | "system";
  text: string;
}

/** 错误原文 → 一行提示（取首行，截 200 字）。 */
export const apiErrorNotice = noticeText;

/**
 * rec 是 API 错误条目就按规则放进 rows 并返回 true（调用方 continue）；不是返回 false。
 * 合并时 seq / ts 取最新那条：网页的增量游标按 seq 往后取，停在旧 seq 上会把后面几次再取一遍。
 */
export function pushApiErrorRow(
  rows: Row[], rec: { isApiErrorMessage?: unknown; error?: unknown; message?: { content?: unknown } }, seq: number, ts: string | null,
): boolean {
  const blocks = Array.isArray(rec.message?.content) ? (rec.message!.content as { type?: string; text?: string }[]) : [];
  const raw = blocks.find((b) => b?.type === "text")?.text;
  if (rec.isApiErrorMessage !== true && !(rec.error != null && raw && isLimitHitText(raw))) return false;
  const text = apiErrorNotice(raw ?? "API Error");
  const prev = rows[rows.length - 1];
  if (prev?.role === "system" && sameNotice(prev.text, text)) {
    Object.assign(prev, { seq, ts, text: bumpRepeat(prev.text) });
  } else {
    rows.push({ seq, ts, role: "system", text });
  }
  return true;
}
