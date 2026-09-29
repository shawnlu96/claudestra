/**
 * edit_message 的两道闸（tests/edit-guard.test.ts）：
 * 1. 只准改调用方自己经 reply 发出的消息：reply 发成功时按 Discord 消息 id 记下发送方频道，edit 时核对；
 *    查不到记录（别的 agent 发的、bridge 自己贴的卡片 / 通知、bridge 重启前发的）一律拒。
 * 2. 带保留按钮（lib/reserved-buttons.ts）的消息一律不许改：不带 components 的 edit 会保留原按钮，
 *    改掉正文就能让 owner 以为自己点的是别的东西（班子确认卡、权限弹窗）。
 * 记录只在内存里，按插入顺序最多留 MAX_TRACKED 条；丢了只会让 edit 被拒（让 agent 再 reply 一条），不会放宽。
 */
import { isReservedButtonId } from "../lib/reserved-buttons.js";

const MAX_TRACKED = 5000;
const senders = new Map<string, string>();

/** reply 发出去的 Discord 消息 id 记在发送方频道名下；原样返回 ids，方便调用处一行接上 */
export function noteReplySent(ids: string[], fromChannelId: string): string[] {
  for (const id of ids) {
    senders.delete(id);
    senders.set(id, fromChannelId);
  }
  while (senders.size > MAX_TRACKED) senders.delete(senders.keys().next().value as string);
  return ids;
}

/** 调用方能不能改这条消息；返回拒绝原因，null = 可以 */
export function editOwnerRefusal(messageId: string, callerChannelId: string): string | null {
  const owner = senders.get(messageId);
  if (!callerChannelId) return "edit_message 认不出调用方（连接没注册），已拒绝";
  if (owner === undefined) return "edit_message 只能改你自己经 reply 发出的消息（这条查不到你的发送记录，可能是别人发的、bridge 贴的，或 bridge 重启前发的）；要更正就再 reply 一条";
  return owner === callerChannelId ? null : "edit_message 只能改你自己经 reply 发出的消息，这条是别的 agent 发的";
}

/** discord.js Message.components（ActionRow → components[].customId）里所有按钮 / 选单 id；也认扁平的 {id} / {customId} */
export function messageComponentIds(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  const out: string[] = [];
  for (const c of components) {
    if (!c || typeof c !== "object") continue;
    const o = c as { id?: unknown; customId?: unknown; components?: unknown };
    for (const v of [o.customId, o.id]) if (typeof v === "string") out.push(v);
    out.push(...messageComponentIds(o.components));
  }
  return out;
}

/** 消息带保留按钮就返回拒绝原因 */
export function reservedEditRefusal(components: unknown): string | null {
  const hit = messageComponentIds(components).find(isReservedButtonId);
  return hit ? `这条消息带 bridge 的管理按钮（${hit}），不许编辑` : null;
}
