/**
 * 不是整段拉历史进来的按钮 / 表单回投，往前在已加载的消息里找所属表单（tests/web-delta-clicks.test.ts）。两条路：
 * - 差量（7s 对齐、唤醒补齐、浏览模式向后翻）由 toChatMessages 单独整形，只看得见差量自己的气泡：回投的是前一段的表单时，
 *   显示「🔘 id」、表单也不标已答，要刷新（整段重拉）才对。整形时没解析出来的回投留着 clickRaw，这里接上已加载的消息再解析一次；
 *   往上翻页加载出更早的表单时也再试一次。
 * - 实时流推来的他端回投（别的设备、Discord 上点的）：原来只还原多选表单，按钮 / 单选显示成原样的 `[button:id]`。
 * 两条都照整段拉历史的同一套规则（lib/chat/history-shape.ts 的 resolveUserClick），刷新前后显示一致。
 * 必须在 store 的 produce 里调用：已加载的消息是草稿，所属表单的已答（replyClicks）直接回填进去。
 */
import type { ChatMessage } from "./type";
import { FormLookup } from "@/lib/chat/form-restore";
import { hasClickTargets, resolveUserClick } from "@/lib/chat/history-shape";
import { stripMentionDirective } from "@/lib/chat/mention-directive";

type OnUser = (m: ChatMessage, anchor: ChatMessage | null, forms: FormLookup) => void;
/** 按顺序走一遍消息，维护「最近的可作答锚点」与表单索引；遇到用户消息交给 onUser（此刻只看得见它前面的表单）。返回走完时的状态 */
function walk(messages: ChatMessage[], onUser?: OnUser): { anchor: ChatMessage | null; forms: FormLookup } {
  const forms = new FormLookup();
  let anchor: ChatMessage | null = null;
  for (const m of messages) {
    if (m.role === "assistant") {
      if (hasClickTargets(m.replyText, m.content, m.replyComponents)) anchor = m;
      forms.add(m);
    } else if (m.role === "user") onUser?.(m, anchor, forms);
  }
  return { anchor, forms };
}

/**
 * 把列表里所有还带 clickRaw 的用户消息再解析一次（只看得见它前面的表单）。找到就改成可读文案并删掉 clickRaw；
 * 还找不到（表单在还没加载的更早历史里）就留着兜底文案和 clickRaw，往上翻页把表单加载进来时再试（chat-store.loadOlder）。
 */
export function resolvePendingClicks(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((m) => m.role === "user" && m.clickRaw)) return messages;
  walk(messages, (m, anchor, forms) => {
    if (!m.clickRaw) return;
    const r = resolveUserClick(m.clickRaw, anchor, forms);
    if (!r?.resolved) return;
    m.content = r.text;
    delete m.clickRaw;
  });
  return messages;
}

/** 差量接到已加载的消息后面，解析两边所有待解析的回投；返回 delta 本身（方便串在调用链里） */
export function resolveDeltaClicks(base: ChatMessage[], delta: ChatMessage[]): ChatMessage[] {
  resolvePendingClicks([...base, ...delta]);
  return delta;
}

/** 实时流推来的他端用户消息：是回投就返回可读文案（并给所属表单标已答），不是回投返回 null */
export function resolveLiveClick(text: string, messages: ChatMessage[]): string | null {
  const { anchor, forms } = walk(messages);
  return resolveUserClick(text, anchor, forms)?.text ?? null;
}

/**
 * 他端用户消息的 content：本人的先剥 @ 委托指令行（只给 agent 看，外源的末行照原样给 owner 看），再按回投还原。
 * 和原文不同时原文留在 wire：addRemoteUserMessage 与回声判定（isUserEcho）按 wire ?? content 认重放。
 */
export function liveUserText(text: string, messages: ChatMessage[], from?: string): { content: string; wire?: string } {
  const own = from ? text : stripMentionDirective(text);
  const content = resolveLiveClick(own, messages) ?? own;
  return content === text ? { content } : { content, wire: text };
}
