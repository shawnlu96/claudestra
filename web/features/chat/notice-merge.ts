/**
 * 直播里的 API 错误（撞额度 / 网络 / 5xx）画成一行系统提示，和上一条相同就并成「×N」，不当 agent 气泡。
 * 规则本身在 lib/chat/notice-repeat.ts（与 src/lib/notice-repeat.ts 是 twin，历史一侧 src/lib/api-error-rows.ts 用同一份）；
 * 历史重组时直播的系统行被历史版本替换。单测 tests/web-notice-merge.test.ts。
 */
import { bumpRepeat, noticeText, sameNotice } from "@/lib/chat/notice-repeat";
import type { ChatMessage } from "./type";

/** 把一条提示放进消息列表：尾条是同文的系统行就改成 ×N，否则追加 */
export function pushNotice(messages: ChatMessage[], raw: string, id: string, ts: string): void {
  const text = noticeText(raw);
  const last = messages[messages.length - 1];
  if (last?.role === "system" && sameNotice(last.content, text)) {
    last.content = bumpRepeat(last.content);
    last.ts = ts;
    return;
  }
  messages.push({ id, role: "system", content: text, ts });
}
