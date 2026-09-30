/**
 * bridge 把人发的消息押在对方这一轮之后（chat_held → user-in 带 held，src/bridge/held-web.ts）：那条气泡下标「排队中」，
 * 真送达（不带 held 的回声）/ 押后作罢时摘掉。不标的话押着的消息和已送达的看起来一样，对方这一轮的工具调用还在往下长，像没人理。
 * chat-store addRemoteUserMessage 的对账去重走这里；纯函数，单测 tests/held-web.test.ts。
 */
import type { ChatMessage } from "./type";
import { echoKeyOf, isUserEcho } from "./view-compose";

export type HeldState = "queued" | "dropped";

/**
 * 他端发言 / 押后事件落在视图尾部 15 条里的哪条气泡上（view-compose isUserEcho 判回声）；没有 → undefined。
 * 同一句话发了两遍时：押着找最新的一条（刚发出的乐观气泡），送达 / 作罢先找还标着排队的，都没有就取最早的一条（原有口径）
 */
export function findEchoTarget(
  messages: readonly ChatMessage[], text: string, attachments?: ChatMessage["attachments"], from?: string, held?: HeldState,
): ChatMessage | undefined {
  const hits = messages.slice(-15).filter((m) => isUserEcho(m, text, attachments, from));
  if (held === "queued") return hits[hits.length - 1];
  return hits.find((m) => m.queued) ?? hits[0];
}

/** 回声认领这条气泡：本端乐观气泡记下指纹（同名附件不再被吞）；押着 → 标排队，送达 / 作罢 → 摘掉排队和额度闸的「押着」 */
export function claimEcho(m: ChatMessage, text: string, attachments?: ChatMessage["attachments"], held?: HeldState): void {
  if (m.local && m.echoKey === undefined) m.echoKey = echoKeyOf(text, attachments);
  if (held === "queued") m.queued = true;
  else if (m.queued || m.held) m.queued = m.held = undefined;
}
