/** ACP 宿主无法证明流式条目全部被 bridge 收到时，在 agent 频道留下明确的失败说明。 */
import { type Envelope, newMessageId, newThreadId } from "./router.js";

export const ACP_DELIVERY_LOSS_TEXT = "⚠️ ACP 这轮可能丢了流式条目，已按失败收尾。请查看宿主日志，必要时重发消息。";

export async function notifyAcpDeliveryLoss(channelId: string, deliver: (env: Envelope) => Promise<unknown>): Promise<void> {
  await deliver({
    from: { kind: "bridge", label: "acp-delivery-loss" }, to: { kind: "user", userId: "", channelId },
    intent: "notification", content: ACP_DELIVERY_LOSS_TEXT,
    meta: { messageId: newMessageId("acp-loss"), triggerKind: "bridge_synth", ts: new Date().toISOString(), threadId: newThreadId() },
  });
}
