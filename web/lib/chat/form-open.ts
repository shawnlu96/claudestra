/**
 * 从消息里收集仍可作答的多选表单（form-sync 的输入框同步用）。「已答」与 openForms、签名同一口径：
 * replyClicks，没有时按旧格式 replyClickedId 推（deriveClicksFromLegacy）——签名要是只看 replyClicks，
 * 旧格式消息被答了签名不变，useOpenForms 不重算，已答的表单还会被当成可同步。单测：tests/web-form-sync-block.test.ts。
 */
import type { ChatMessage } from "@/features/chat/type";
import { deriveClicksFromLegacy, replyRowKey } from "./reply-clicks";
import { formTitles, type MultiRow, type SyncForm } from "./form-compose";

function multiRows(m: ChatMessage): { row: MultiRow; ri: number }[] {
  return (m.replyComponents ?? []).flatMap((row, ri) => (row.type === "multiselect" ? [{ row, ri }] : []));
}

const clicksOf = (m: ChatMessage): Record<string, string> => m.replyClicks ?? deriveClicksFromLegacy(m.replyClickedId, m.replyComponents);

/** 仍可作答的多选表单（带标题），新消息、同消息里靠后的行在前；标题按视图里全部多选表单算（placeholder 重名带 id） */
export function openForms(messages: ChatMessage[]): SyncForm[] {
  const titles = formTitles(messages.flatMap((m) => multiRows(m).map(({ row }) => row)));
  const out: SyncForm[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const clicks = clicksOf(m);
    // 同一条消息里也是后面的行在前：同一回合前后两段复用 id 时，最新那段先被按 id 找到（它才同步，旧的退回本地）
    for (const { row, ri } of multiRows(m).reverse()) {
      const rowKey = replyRowKey(row, ri);
      if (clicks[rowKey] == null) out.push({ row, title: titles.get(row.id) ?? row.id, messageId: m.id, rowKey, rowIndex: ri });
    }
  }
  return out;
}

/** openForms 输入的摘要：表单集合或已答（含旧格式）变了它才变——useOpenForms 的选择器只返回它 */
export function openFormsSig(messages: ChatMessage[]): string {
  return messages
    .flatMap((m) => {
      const clicks = clicksOf(m);
      return multiRows(m).map(({ row, ri }) => `${m.id}\u0001${row.id}\u0001${clicks[replyRowKey(row, ri)] ?? ""}`);
    })
    .join("\u0000");
}
