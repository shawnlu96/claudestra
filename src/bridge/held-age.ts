/**
 * 每分钟扫押后队列的老化（held-queue.ts ageHeld）并把提醒发给发送方：agent 发的直接 ws 推给它；人发的（Discord / Web）没有 ws
 * 可推，放弃时发到目标频道告诉那个人、附原文（不然 24 小时后就静默丢了）。从 bridge.ts 搬出，单测 tests/held-queue.test.ts。
 */
import { ageHeld, heldNoticeText, type HeldItem, type HeldQueue } from "./held-queue.js";
import { newMessageId, newThreadId } from "./router.js";

export interface HeldAgeDeps {
  held: HeldQueue;
  /** 这一条此刻不老化：额度闸开着、发送方是 Claude Code（提醒会唤醒一个注定撞墙的回合）。Codex / Pi 的照常 */
  paused: (item: HeldItem) => boolean;
  wsOf: (channelId: string) => { send(data: string): unknown } | undefined;
  /** 发到目标频道给人看（UI 类通知，不进 agent） */
  notifyHuman: (channelId: string, text: string) => void;
}

export function sweepHeldAges(d: HeldAgeDeps, now: number): void {
  for (const n of ageHeld(d.held, now, d.paused)) {
    console.log(`${n.kind === "gave-up" ? "🧹 押后消息放弃" : "⏳ 押后消息仍在排队"}: → ${n.item.to.agentName || n.channelId}`);
    const from = n.item.env.from;
    if (from.kind !== "local") {
      if (n.kind === "gave-up" && (from.kind === "user" || from.kind === "api")) d.notifyHuman(n.channelId, heldNoticeText(n, true));
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
