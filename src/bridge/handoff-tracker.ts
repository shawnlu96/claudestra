/**
 * 交接记录的 bridge 侧接线（记录格式与汇总在 lib/handoff-log.ts）。
 * - 入站开始：api-routes 在 peer token 的 /messages 投递成功后调 trackInboundHandoff（id = threadId）
 * - 入站结局：订阅事件总线的 chat_message(out, api) —— deliverToApi（agent 正式 reply）和 Stop 兜底（R3，
 *   data.viaFallback）都会发这条、都带原请求的 threadId；这样不用在 bridge.ts 里加钩子
 * - 出站：http-peer 在 callId 上直接调 lib 的 handoffStart / handoffEnd
 */
import { handoffEnd, handoffStart } from "../lib/handoff-log.js";
import { subscribeEvents } from "./event-bus.js";

let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  subscribeEvents({}, (evt) => {
    if (evt.type !== "chat_message") return;
    const d = evt.data as { direction?: string; api?: boolean; threadId?: string; text?: string; viaFallback?: boolean };
    if (d.direction !== "out" || !d.api || !d.threadId) return;
    // 不是 peer 发起的 threadId 在 handoffEnd 里查不到、直接忽略
    void handoffEnd(d.threadId, d.viaFallback ? "fallback" : "reply", { chars: (d.text || "").length });
  });
}

export function trackInboundHandoff(threadId: string, peer: string, localAgent: string, chars: number): void {
  ensureSubscribed();
  void handoffStart(threadId, { dir: "in", peer, localAgent }, chars);
}
