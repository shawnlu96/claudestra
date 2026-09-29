/**
 * 发出去的消息被 bridge 押住了（POST messages 回 202 + heldBy：整机撞了额度，或目标停在额度菜单 / 撞墙倒计时上、没发键）：
 * 押住就没有回合——不进「正在回复」；乐观气泡标 held（view-compose 的 survivingPending 不按 30 分钟丢，周额度一押一两天），
 * 下面插一条系统说明，告诉 owner 要不要自己去窗口里处理。非全权设备 / guest 只拿到 queued、不知道原因：同样处理，说明不提额度。
 * 单测 tests/web-held-send.test.ts。
 */
import type { ChatMessage } from "../chat/type";

/** queued = bridge 押住了、没说原因（只回给全权 owner 设备的 heldBy 这里拿不到） */
export type HeldBy = "quota_wall" | "wall_menu" | "queued";

export function heldSendNotice(by: HeldBy, zh: boolean): string {
  if (by === "queued") return zh ? "对方暂时收不到，消息已排队，送达后会出现在这里" : "The agent can't take messages right now; yours is queued and will show up here once delivered";
  if (by === "wall_menu") {
    return zh
      ? "它停在额度菜单 / 自动续跑倒计时上，bridge 没有发任何键；消息押着，菜单关掉或出闸后送达。要马上处理请在它的窗口里自己操作"
      : "It is sitting on the usage-limit menu / auto-continue countdown; no key was sent. Your message is held until the menu closes or the wall lifts — handle it in its window to act now";
  }
  return zh ? "整机撞了额度（额度闸开着），消息押着，出闸后按序送达，不用重发" : "The usage limit is hit machine-wide; your message is held and delivered in order once it lifts — no need to resend";
}

export function markHeldSend(
  s: { messages: ChatMessage[]; streaming: boolean; awaitingChunk: boolean }, optimisticId: string, by: HeldBy, id: string, zh: boolean, now = new Date().toISOString(),
): void {
  s.streaming = false;
  s.awaitingChunk = false;
  const opt = s.messages.find((m) => m.id === optimisticId);
  if (opt) opt.held = true;
  s.messages.push({ id, role: "system", content: heldSendNotice(by, zh), ts: now });
}
