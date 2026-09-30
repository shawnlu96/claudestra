/** 本地 Channel 头的来源字段由 Envelope 构造，避免迁移押后路径另造一套身份。 */
import type { Envelope } from "./router.js";
export function inboundMeta(env: Envelope, replyBackChannel: string): Record<string, string> {
  const meta: Record<string, string> = {
    chat_id: replyBackChannel,
    message_id: env.meta.messageId,
    ts: env.meta.ts,
    trigger: env.meta.triggerKind,
    intent: env.intent,
    thread_id: env.meta.threadId,
  };
  if (env.from.kind === "user") {
    meta.user = env.from.username ?? "";
    meta.user_id = env.from.userId;
  } else if (env.from.kind === "local") {
    meta.user = env.from.agentName ?? "agent";
    meta.user_id = "agent";
    meta.is_agent = "true";
    meta.from_channel_id = env.from.channelId;
  } else if (env.from.kind === "bridge") {
    meta.user = `bridge${env.from.label ? `:${env.from.label}` : ""}`;
    meta.user_id = "bridge";
    meta.is_bridge = "true";
  } else if (env.from.kind === "api") {
    meta.user = env.from.name;
    meta.user_id = `api:${env.from.tokenId}`;
    meta.api = "true";
  }
  if (env.meta.attachments && env.meta.attachments.length > 0) {
    meta.attachment_count = String(env.meta.attachments.length);
    meta.attachments = env.meta.attachments.join(";");
  }
  return meta;
}
