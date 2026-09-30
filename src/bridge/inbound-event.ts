/**
 * 入站消息镜像成 chat_message(in) 事件的 data（bridge.ts 投递给本地 agent 成功后 emit）。
 * srcKind（user = Discord 人类 / api = Web 用户 / local = agent·bridge）让网页把他端用户发言实时画成气泡、排除 agent/bridge 注入；
 * fromId（user_id）让网页认出本人的其它来源。attachments 是 bridge 真收下的附件路径（和 channel 头属性同一份）：
 * 网页给外源消息画附件卡片只认它，不认正文里的 [attachment: …] 行（tests/inbound-event.test.ts）。
 */
import type { Envelope } from "./router.js";

export function inboundEventData(env: Envelope, meta: Record<string, string>): Record<string, unknown> {
  const atts = env.meta.attachments?.filter(Boolean) ?? [];
  return {
    direction: "in", from: meta.user || "?", fromId: meta.user_id, srcKind: env.from.kind, text: env.content, threadId: env.meta.threadId,
    ...env.meta.askEcho,
    ...(atts.length ? { attachments: atts } : {}),
  };
}
