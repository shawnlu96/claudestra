/**
 * 差量里的按钮 / 表单回投，往前在已加载的消息里找所属表单（tests/web-delta-clicks.test.ts）。
 *
 * 差量（7s 对齐、唤醒补齐、浏览模式向后翻）由 toChatMessages 单独整形，只看得见差量自己的气泡：回投的是前一段的表单时，
 * 实时视图显示「🔘 id」、表单也不标已答，要刷新（整段重拉）才对。整形时没解析出来的回投留着 clickRaw，
 * 这里把已加载的消息和差量按原顺序接起来，照整段拉历史的同一套规则（lib/chat/history-shape.ts 的 resolveUserClick）再解析一次。
 *
 * 必须在 store 的 produce 里调用：base 是草稿，所属表单的已答（replyClicks）直接回填进去。
 */
import type { ChatMessage } from "./type";
import { FormLookup } from "@/lib/chat/form-restore";
import { hasClickTargets, resolveUserClick } from "@/lib/chat/history-shape";

/** 原地改写 delta 里带 clickRaw 的用户消息，并返回 delta 本身（方便串在调用链里） */
export function resolveDeltaClicks(base: ChatMessage[], delta: ChatMessage[]): ChatMessage[] {
  const pending = new Set(delta.filter((m) => m.role === "user" && m.clickRaw));
  if (!pending.size) return delta;
  const forms = new FormLookup();
  let anchor: ChatMessage | null = null;
  for (const m of [...base, ...delta]) {
    if (m.role === "assistant") {
      if (hasClickTargets(m.replyText, m.content, m.replyComponents)) anchor = m;
      forms.add(m);
    } else if (pending.has(m)) {
      // 还是没找到（表单比已加载的还早）就维持兜底文案；clickRaw 用过即删，下一段差量不会再带上这条
      const r = resolveUserClick(m.clickRaw!, anchor, forms);
      if (r) m.content = r.text;
      delete m.clickRaw;
    }
  }
  return delta;
}
