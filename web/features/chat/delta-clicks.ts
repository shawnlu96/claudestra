/**
 * 不是整段拉历史进来的按钮 / 表单回投，往前在已加载的消息里找所属表单（tests/web-delta-clicks.test.ts）。两条路：
 * - 差量（7s 对齐、唤醒补齐、浏览模式向后翻）由 toChatMessages 单独整形，只看得见差量自己的气泡：回投的是前一段的表单时，
 *   显示「🔘 id」、表单也不标已答，要刷新（整段重拉）才对。整形时没解析出来的回投留着 clickRaw，这里接上已加载的消息再解析一次。
 * - 实时流推来的他端回投（别的设备、Discord 上点的）：原来只还原多选表单，按钮 / 单选显示成原样的 `[button:id]`。
 * 两条都照整段拉历史的同一套规则（lib/chat/history-shape.ts 的 resolveUserClick），刷新前后显示一致。
 * 必须在 store 的 produce 里调用：已加载的消息是草稿，所属表单的已答（replyClicks）直接回填进去。
 */
import type { ChatMessage } from "./type";
import { FormLookup } from "@/lib/chat/form-restore";
import { hasClickTargets, resolveUserClick } from "@/lib/chat/history-shape";

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

/** 原地改写 delta 里带 clickRaw 的用户消息，并返回 delta 本身（方便串在调用链里） */
export function resolveDeltaClicks(base: ChatMessage[], delta: ChatMessage[]): ChatMessage[] {
  const pending = new Set(delta.filter((m) => m.role === "user" && m.clickRaw));
  if (!pending.size) return delta;
  walk([...base, ...delta], (m, anchor, forms) => {
    if (!pending.has(m)) return;
    // 还是没找到（表单比已加载的还早）就维持兜底文案；clickRaw 用过即删，下一段差量不会再带上这条
    const r = resolveUserClick(m.clickRaw!, anchor, forms);
    if (r) m.content = r.text;
    delete m.clickRaw;
  });
  return delta;
}

/** 实时流推来的他端用户消息：是回投就返回可读文案（并给所属表单标已答），不是回投返回 null */
export function resolveLiveClick(text: string, messages: ChatMessage[]): string | null {
  const { anchor, forms } = walk(messages);
  return resolveUserClick(text, anchor, forms)?.text ?? null;
}
