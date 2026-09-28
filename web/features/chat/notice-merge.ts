/**
 * 直播里的 API 错误（撞额度 / 网络 / 5xx）画成一行系统提示，和上一条相同就并成「×N」，不当 agent 气泡。
 * 历史一侧同一规则在 src/lib/api-error-rows.ts（web 与 src 互不 import）；历史重组时直播的系统行被历史版本替换。
 * 单测 tests/web-notice-merge.test.ts。
 */
import type { ChatMessage } from "./type";

const REPEAT_RE = /\s×(\d+)$/;

/** 把一条提示放进消息列表：尾条是同文的系统行就改成 ×N，否则追加 */
export function pushNotice(messages: ChatMessage[], raw: string, id: string, ts: string): void {
  const text = `⛔ ${raw.trim().split("\n")[0].slice(0, 200)}`;
  const last = messages[messages.length - 1];
  if (last?.role === "system" && last.content.replace(REPEAT_RE, "") === text) {
    last.content = `${text} ×${Number(REPEAT_RE.exec(last.content)?.[1] ?? 1) + 1}`;
    last.ts = ts;
    return;
  }
  messages.push({ id, role: "system", content: text, ts });
}
