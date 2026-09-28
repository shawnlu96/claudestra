/**
 * 用户消息里的 `[select:…]` 行 → 输入框同步行的可读写法，并回填所属表单的已答（form-compose 的反向）。
 * 历史还原（history-shape）和他端实时推来的用户消息（chat-store.addRemoteUserMessage）共用，
 * 两边显示才会跟本端发送时的气泡一致。
 */
import type { ChatMessage } from "@/features/chat/type";
import { replyRowKey } from "./reply-clicks";
import { formTitles, wireToDisplay, type MultiRow } from "./form-compose";
import type { WebComponentRow } from "./events";

/** 该 id 的选单在这条消息里的最后一行（同一回合前后两段复用 id 时认最新那段，与 matchClickedRow / openForms 一致） */
function lastRowOf(rows: WebComponentRow[], id: string, multiOnly: boolean): number {
  for (let ri = rows.length - 1; ri >= 0; ri--) {
    const r = rows[ri];
    if (r.type !== "buttons" && r.id === id && (!multiOnly || r.type === "multiselect")) return ri;
  }
  return -1;
}

/** 带组件的 assistant 气泡（按出现顺序），给选单回投按 id 找所属消息 */
export class FormLookup {
  private anchors: ChatMessage[] = [];
  add(g: ChatMessage) {
    if (g.replyComponents?.length && this.anchors[this.anchors.length - 1] !== g) this.anchors.push(g);
  }
  /** 含该 id 的最近一条，优先还没作答的（同一 id 被多条消息复用时对应最新未答的那条） */
  find(id: string): ChatMessage | null {
    let fallback: ChatMessage | null = null;
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      const g = this.anchors[i];
      const ri = lastRowOf(g.replyComponents!, id, false);
      if (ri < 0) continue;
      if (!g.replyClicks?.[replyRowKey(g.replyComponents![ri], ri)]) return g;
      fallback ??= g;
    }
    return fallback;
  }
  /** 多选表单的 select 行还原成「【标题】✓ …」并（commit 时）回填已答；没有可还原的行 → null（交给按钮 / 单选的老路径） */
  restore(text: string, commit = true): string | null {
    if (!text.includes("[select:")) return null;
    const rows = this.anchors.flatMap((g) => g.replyComponents!.filter((r): r is MultiRow => r.type === "multiselect"));
    const titles = formTitles(rows);
    return wireToDisplay(text, (id) => {
      const g = this.find(id);
      const ri = g ? lastRowOf(g.replyComponents!, id, true) : -1;
      if (!g || ri < 0) return null;
      const row = g.replyComponents![ri] as MultiRow;
      const mark = (values: string[]) => void (commit && ((g.replyClicks ??= {})[replyRowKey(row, ri)] = `${id}:${values.join(",")}`));
      return { row, title: titles.get(id) ?? id, commit: mark };
    });
  }
}

/**
 * 实时路径：在当前消息列表上还原。commit=true 时 messages 须是 produce 里的草稿（回填直接落进去）；
 * 本端发送算乐观气泡的显示用 commit=false——与刷新后历史还原同一写法，对账才对得上。
 */
export function restoreFormReply(text: string, messages: ChatMessage[], commit = true): string | null {
  const lookup = new FormLookup();
  messages.forEach((m) => lookup.add(m));
  return lookup.restore(text, commit);
}
