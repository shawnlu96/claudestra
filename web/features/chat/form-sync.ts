/**
 * 多选表单 ↔ 输入框的接线（T10）。纯变换在 lib/chat/form-compose.ts；这里只管：
 * - 输入框文字的广播：composer 是非受控 textarea（见 composer.tsx 开头 #185 的说明），
 *   表单要读它、改它，就经这个小总线，不把 composer 的 state 往上提。
 * - 从 store 的消息里收集仍可作答的表单、算标题、发送前转换并标已答。
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChatMessage } from "./type";
import type { ChatStore } from "./chat-store";
import { useChatStore } from "./chat-store";
import { deriveClicksFromLegacy, replyRowKey } from "@/lib/chat/reply-clicks";
import { composeFormSend, formTitles, type MultiRow, type OpenForm } from "@/lib/chat/form-compose";

// ── 输入框文字总线：同一时刻只有一个 composer ──
let text = "";
let editor: ((fn: (prev: string) => string) => void) | null = null;
const subs = new Set<() => void>();

function publishComposerText(next: string): void {
  if (next === text) return;
  text = next;
  subs.forEach((f) => f());
}

/** composer 挂载时注册自己的 setText（程序化写入要走它：同时写 DOM 与状态、避开 IME 组合期） */
function registerComposerEditor(fn: (update: (prev: string) => string) => void): () => void {
  editor = fn;
  return () => {
    if (editor !== fn) return;
    editor = null;
    publishComposerText(""); // 卸载后别拿旧草稿推勾选
  };
}

/** 没有 composer（分享模式换成了 ShareDock）时改总线自己的文字：勾选和「提交」照常可用 */
export function editComposer(update: (prev: string) => string): void {
  if (editor) editor(update);
  else publishComposerText(update(text));
}

/** composer 用：广播当前文字、注册程序化写入口 */
export function useComposerBus(current: string, setText: (update: (prev: string) => string) => void): void {
  useEffect(() => publishComposerText(current), [current]);
  useEffect(() => registerComposerEditor(setText), [setText]);
}

export function useComposerText(): string {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => text,
    () => "",
  );
}

// ── 表单收集 ──
function multiRows(m: ChatMessage): { row: MultiRow; ri: number }[] {
  return (m.replyComponents ?? []).flatMap((row, ri) => (row.type === "multiselect" ? [{ row, ri }] : []));
}

/** 视图里所有多选表单的标题（placeholder 重名才带 id）。选择器返回字符串签名，消息无关变化不触发重渲。 */
export function useFormTitles(): Map<string, string> {
  const sig = useChatStore((s) =>
    s.state.messages
      .flatMap((m) => multiRows(m).map(({ row }) => `${row.id}\u0001${row.placeholder ?? ""}`))
      .join("\u0000"),
  );
  return useMemo(() => titlesFromSig(sig), [sig]);
}

function titlesFromSig(sig: string): Map<string, string> {
  if (!sig) return new Map();
  const rows = sig.split("\u0000").map((p) => {
    const [id, placeholder] = p.split("\u0001");
    return { type: "multiselect", id, placeholder: placeholder || undefined, options: [] } as MultiRow;
  });
  return formTitles(rows);
}

/** 仍可作答的多选表单，新消息在前（同一 id 复用时对应最新未答的那条） */
export function openForms(messages: ChatMessage[]): OpenForm[] {
  const out: OpenForm[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const clicks = m.replyClicks ?? deriveClicksFromLegacy(m.replyClickedId, m.replyComponents);
    for (const { row, ri } of multiRows(m)) {
      const rowKey = replyRowKey(row, ri);
      if (clicks[rowKey] == null) out.push({ messageId: m.id, rowKey, row });
    }
  }
  return out;
}

/** 同一 id 被多条消息复用时只有最新一条未作答的跟输入框同步，与发送时的对应一致（旧的那条不跟着打勾） */
export function useSyncsWithComposer(messageId: string, rowId: string): boolean {
  return useChatStore((s) => openForms(s.state.messages).find((f) => f.row.id === rowId)?.messageId === messageId);
}

/**
 * composer 发送：输入框里有表单同步行就原位换成 [select:…] 作 wire（气泡仍显示原文），
 * 并把这些表单标已答；没有就是普通发送。
 */
export function sendComposed(store: ChatStore, cur: string, files?: File[]): void {
  const messages = store.state.messages;
  const rows = messages.flatMap((m) => multiRows(m).map(({ row }) => row));
  const { wire, answered } = composeFormSend(cur, openForms(messages), formTitles(rows));
  if (!answered.length) {
    void store.send(cur, files);
    return;
  }
  answered.forEach((a) => store.markReplyAnswered(a.messageId, a.rowKey, a.choiceValue));
  void store.send(cur, files, wire, true);
}
