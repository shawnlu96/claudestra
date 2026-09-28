/**
 * 多选表单 ↔ 输入框的接线（T10）。纯变换在 lib/chat/form-compose.ts；这里只管：
 * - 输入框文字的广播：composer 是非受控 textarea（见 composer.tsx 开头 #185 的说明），
 *   表单要读它、改它，就经这个小总线，不把 composer 的 state 往上提。
 * - 把 store 里仍可作答的表单（lib/chat/form-open.ts 收集）接给组件、发送前转换并标已答。
 */
import { useEffect, useMemo, useSyncExternalStore, type RefObject } from "react";
import type { ChatStore } from "./chat-store";
import { useChatStore, useChatStoreApi } from "./chat-store";
import { createEditQueue, type EditQueue } from "./ime-queue";
import { composeFormSend, lineScan, syncBlock, type LineOwner, type MultiRow, type SyncBlock, type SyncForm } from "@/lib/chat/form-compose";
import { openForms, openFormsSig } from "@/lib/chat/form-open";
import { restoreFormReply } from "@/lib/chat/form-restore";
import { withMentionDirective, type MentionTarget } from "@/lib/chat/mention-directive";
import { getLang } from "@/lib/i18n";
import { postClientLog } from "@/lib/client-log";

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

/** 勾选退回本地时记一行 client.log（只带表单 id 与原因码，不带选项内容）；同一表单同一原因每次页面加载只记一次 */
const loggedBlocks = new Set<string>();
export function logLocalTick(rowId: string, reason: string): void {
  const id = /^[\w-]{1,64}$/.test(rowId) ? rowId : "?";
  if (loggedBlocks.has(`${id}\u0000${reason}`)) return;
  loggedBlocks.add(`${id}\u0000${reason}`);
  postClientLog(`[form] 本地勾选 id=${id} reason=${reason}`);
}

// ── 表单收集（纯逻辑在 lib/chat/form-open.ts） ──
/** 组件用：选择器只返回签名字符串（表单集合与已答没变就不重算、不重渲） */
export function useOpenForms(): SyncForm[] {
  const store = useChatStoreApi();
  const sig = useChatStore((s) => openFormsSig(s.state.messages));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sig 就是 messages 里表单相关部分的摘要
  return useMemo(() => openForms(store.state.messages), [sig, store]);
}

/**
 * 输入框里有表单同步行就原位换成 [select:…] 作 wire（气泡仍显示原文）并标已答；没有就是普通发送。
 * mention = 已复核的 @ 目标（use-mention.ts）：wire 末尾加委托指令行，气泡仍显示原文。keepQuote 恒为 true——引用块照常前置到两边。
 */
export function sendComposed(store: ChatStore, cur: string, files?: File[], mention?: MentionTarget): void {
  const { wire, answered } = composeFormSend(cur, openForms(store.state.messages));
  const tagged = (w: string) => (mention ? withMentionDirective(w, mention, getLang()) : undefined);
  if (!answered.length) {
    void store.send(cur, files, tagged(cur), true);
    return;
  }
  // 乐观气泡的显示按 wire 还原（与刷新后历史还原同一写法）：写法不同对账认不出，刷新后会多出一条
  const display = restoreFormReply(wire, store.state.messages, false) ?? cur;
  answered.forEach((a) => store.markReplyAnswered(a.messageId, a.rowKey, a.choiceValue));
  void store.send(display, files, tagged(wire) ?? wire, true);
}

/**
 * MultiSelectRow 用：这一行表单是否走输入框同步（block = null），不走就给原因码；以及输入框里认给它的那一行。
 * 按「消息 id + 行下标」定位——同一回合前后两段复用 id 时两行 rowKey 相同，只按 id 找会拿到别的那行。
 */
export function useFormRowSync(messageId: string, rowIndex: number, row: MultiRow): {
  form: SyncForm | undefined;
  forms: SyncForm[];
  block: SyncBlock | "ambiguous" | null;
  owner: LineOwner | null;
} {
  const composer = useComposerSnap();
  const forms = useOpenForms();
  const form = forms.find((f) => f.messageId === messageId && f.rowIndex === rowIndex);
  const pre = syncBlock(row, form, forms, composer.present);
  const scan = pre ? null : lineScan(composer.text, forms);
  // 输入框里有歧义行（别的表单也能认领）时也退回本地勾选：往输入框写只会每点一次多一行
  const block = pre ?? (scan?.ambiguous.has(row.id) ? "ambiguous" : null);
  return { form, forms, block, owner: scan?.owners.get(row.id) ?? null };
}
