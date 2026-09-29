/**
 * 每分钟扫押后队列的老化（held-queue.ts ageHeld）并把提醒发给发送方：agent 发的直接 ws 推给它；人发的放弃时按原发送者的地址
 * 发回、附原文（不然 24 小时后就静默丢了）：Discord 发的回原频道；Web / API / peer 发的回它的 api:<token> 会话，并结掉挂在那条
 * 消息上的等待（inReplyTo），guest 和 peer 轮询 thread 也能看到。从 bridge.ts 搬出，单测 tests/held-queue.test.ts。
 */
import { ageHeld, heldNoticeText, type HeldItem, type HeldNotice, type HeldQueue } from "./held-queue.js";
import { newMessageId, newThreadId, type Delivery, type Envelope } from "./router.js";

export interface HeldAgeDeps {
  held: HeldQueue;
  /** 这一条此刻不老化：额度闸开着、发送方是 Claude Code（提醒会唤醒一个注定撞墙的回合）。Codex / Pi 的照常 */
  paused: (item: HeldItem) => boolean;
  wsOf: (channelId: string) => { send(data: string): unknown } | undefined;
  /** bridge 的 deliver：人发的放弃通知走它发回原发送者 */
  deliver: (env: Envelope) => Promise<Delivery>;
}

/** 人发的消息押满 24 小时放弃：通知发回原发送者。额度状态只告诉 owner（Discord 上的人、owner 本人的 Web / API），外人只说「对方收不到」 */
function giveUpNotice(d: HeldAgeDeps, n: HeldNotice): void {
  const from = n.item.env.from;
  if (from.kind !== "user" && from.kind !== "api") return;
  const owner = from.kind === "user" || (!!from.owner && !from.peer);
  const meta = {
    messageId: newMessageId("held_human"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: n.item.env.meta.threadId || newThreadId(),
  };
  const content = heldNoticeText(n, owner ? "owner" : "stranger");
  // API 发送方：以目标 agent 的会话发回它的 api:<token>（deliverToApi 按 token + 目标频道认领那条请求的等待）
  const env: Envelope = from.kind === "api"
    ? {
      from: { kind: "local", channelId: n.channelId, agentName: n.item.to.agentName, ws: n.item.to.ws },
      to: from, intent: "notification", content, meta: { ...meta, inReplyTo: n.item.env.meta.messageId },
    }
    : { from: { kind: "bridge", label: "held" }, to: { kind: "user", userId: from.userId, channelId: from.channelId || n.channelId }, intent: "notification", content, meta };
  const who = from.kind === "api" ? `${from.name}${from.peer ? `@${from.peer}` : ""}` : from.username ?? from.userId;
  d.deliver(env)
    .then((r) => r.outcome.kind !== "sent" && console.warn(`⚠️ 押后放弃通知没送到 ${who}（${r.outcome.kind}）`))
    .catch((e) => console.warn(`⚠️ 押后放弃通知没送到 ${who}: ${(e as Error).message}`));
}

export function sweepHeldAges(d: HeldAgeDeps, now: number): void {
  for (const n of ageHeld(d.held, now, d.paused)) {
    console.log(`${n.kind === "gave-up" ? "🧹 押后消息放弃" : "⏳ 押后消息仍在排队"}: → ${n.item.to.agentName || n.channelId}`);
    const from = n.item.env.from;
    if (from.kind !== "local") {
      if (n.kind === "gave-up") giveUpNotice(d, n);
      continue;
    }
    try {
      d.wsOf(from.channelId)?.send(JSON.stringify({ type: "message", content: heldNoticeText(n), meta: {
        chat_id: from.channelId, message_id: newMessageId(`held_${n.kind}`), ts: new Date().toISOString(), trigger: "system",
        intent: "notification", thread_id: newThreadId(), user: "bridge", user_id: "bridge", is_bridge: "true",
      } }));
    } catch { /* caller 也没了就算了:消息本身按 ageHeld 的规则留着 / 已放弃 */ }
  }
}
