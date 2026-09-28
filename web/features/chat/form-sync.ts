/**
 * 多选表单 ↔ 输入框的接线（T10）。纯变换在 lib/chat/form-compose.ts；这里只管：
 * - 输入框文字的广播：composer 是非受控 textarea（见 composer.tsx 开头 #185 的说明），
 *   表单要读它、改它，就经这个小总线，不把 composer 的 state 往上提。
 * - 从 store 的消息里收集仍可作答的表单、算标题、发送前转换并标已答。
 */
import { useEffect, useMemo, useSyncExternalStore, type RefObject } from "react";
import type { ChatMessage } from "./type";
import type { ChatStore } from "./chat-store";
import { useChatStore, useChatStoreApi } from "./chat-store";
import { createEditQueue, type EditQueue } from "./ime-queue";
import { deriveClicksFromLegacy, replyRowKey } from "@/lib/chat/reply-clicks";
import { composeFormSend, formTitles, type MultiRow, type SyncForm } from "@/lib/chat/form-compose";
import { restoreFormReply } from "@/lib/chat/form-restore";

type Update = (prev: string) => string;

// ── 输入框文字总线：同一时刻只有一个 composer；没挂 composer（分享模式换成 ShareDock）时表单走本地勾选 ──
let raw = "";
let active: EditQueue | null = null;
let snap = { text: "", present: false };
const subs = new Set<() => void>();

/** 对外的 text = 输入框文字 + 输入法组合期还在排队的改写（见 ime-queue） */
function refresh(present = snap.present): void {
  const text = active ? active.preview(raw) : raw;
  if (text === snap.text && present === snap.present) return;
  snap = { text, present };
  subs.forEach((f) => f());
}

export function editComposer(update: Update): void {
  if (!active) return;
  active.edit(update);
  refresh();
}

/** composer 用：广播当前文字、注册程序化写入口。返回的队列：onCompositionEnd 下一帧 flush，发送前 drain */
export function useComposerBus(
  current: string,
  setText: (fn: Update) => void,
  composingRef: RefObject<boolean>,
  taRef: RefObject<HTMLTextAreaElement | null>,
): EditQueue {
  const queue = useMemo(() => createEditQueue(setText, composingRef, taRef), [setText, composingRef, taRef]);
  useEffect(() => {
    raw = current;
    refresh();
  }, [current]);
  useEffect(() => {
    active = queue;
    refresh(true);
    return () => {
      if (active !== queue) return;
      active = null;
      raw = ""; // 卸载后别拿旧草稿推勾选
      refresh(false);
    };
  }, [queue]);
  return queue;
}

export function useComposerSnap(): { text: string; present: boolean } {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => snap,
    () => snap,
  );
}

// ── 表单收集 ──
function multiRows(m: ChatMessage): { row: MultiRow; ri: number }[] {
  return (m.replyComponents ?? []).flatMap((row, ri) => (row.type === "multiselect" ? [{ row, ri }] : []));
}

/** 仍可作答的多选表单（带标题），新消息在前；标题按视图里全部多选表单算（placeholder 重名带 id） */
export function openForms(messages: ChatMessage[]): SyncForm[] {
  const titles = formTitles(messages.flatMap((m) => multiRows(m).map(({ row }) => row)));
  const out: SyncForm[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const clicks = m.replyClicks ?? deriveClicksFromLegacy(m.replyClickedId, m.replyComponents);
    for (const { row, ri } of multiRows(m)) {
      const rowKey = replyRowKey(row, ri);
      if (clicks[rowKey] == null) out.push({ row, title: titles.get(row.id) ?? row.id, messageId: m.id, rowKey });
    }
  }
  return out;
}

/** 组件用：选择器只返回签名字符串（表单集合与已答没变就不重算、不重渲） */
export function useOpenForms(): SyncForm[] {
  const store = useChatStoreApi();
  const sig = useChatStore((s) =>
    s.state.messages
      .flatMap((m) => multiRows(m).map(({ row, ri }) => `${m.id}\u0001${row.id}\u0001${m.replyClicks?.[replyRowKey(row, ri)] ?? ""}`))
      .join("\u0000"),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sig 就是 messages 里表单相关部分的摘要
  return useMemo(() => openForms(store.state.messages), [sig, store]);
}

/** 输入框里有表单同步行就原位换成 [select:…] 作 wire（气泡仍显示原文）并标已答；没有就是普通发送 */
export function sendComposed(store: ChatStore, cur: string, files?: File[]): void {
  const { wire, answered } = composeFormSend(cur, openForms(store.state.messages));
  if (!answered.length) {
    void store.send(cur, files);
    return;
  }
  // 乐观气泡的显示按 wire 还原（与刷新后历史还原同一写法）：写法不同对账认不出，刷新后会多出一条
  const display = restoreFormReply(wire, store.state.messages, false) ?? cur;
  answered.forEach((a) => store.markReplyAnswered(a.messageId, a.rowKey, a.choiceValue));
  void store.send(display, files, wire, true);
}
