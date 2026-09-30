/**
 * 人发的消息进了押后队列 / 押后作罢 → chat_held 事件：网页在那条气泡下标「排队中」，作罢时摘掉（web/features/chat/held-echo.ts）。
 * 送达不另发：deliverToLocal 投出后的 chat_message(in) 就是送达信号，网页按同一套回声对账摘标记。
 * 负载沿用入站镜像（inboundEventData）：网页的乐观气泡没有 bridge 的 messageId，只能按正文 / wire 对账。
 * 不复用 chat_message：api-error-resume、push、asks 等订阅者把它当 agent 活动 / 已读 / owner 在场。agent / bridge 消息不发。
 * 单测 tests/held-web.test.ts。
 */
import { emitEvent } from "./event-bus.js";
import { inboundEventData } from "./inbound-event.js";
import type { Envelope } from "./router.js";

export type HeldWebState = "queued" | "dropped";

/** chat_held 的负载；不是人发的（agent / bridge）→ null */
export function heldEventData(env: Envelope, state: HeldWebState): Record<string, unknown> | null {
  const f = env.from;
  if (f.kind !== "api" && f.kind !== "user") return null;
  const who = f.kind === "api" ? { user: f.name, user_id: `api:${f.tokenId}` } : { user: f.username ?? "", user_id: f.userId };
  return { ...inboundEventData(env, who), state };
}

export function emitHeldToWeb(env: Envelope, state: HeldWebState): void {
  const to = env.to;
  if (to.kind !== "local") return;
  // 事件按 agent 名过滤；大总管的信封可能不带名字（router.ts LocalEndpoint），认不出名字的挂不到网页会话上就不发
  const agent = to.agentName || (to.channelId === process.env.CONTROL_CHANNEL_ID ? "master" : "");
  const data = agent ? heldEventData(env, state) : null;
  if (data) emitEvent({ agent, chatId: to.channelId, type: "chat_held", data });
}
