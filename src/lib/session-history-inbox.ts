/**
 * 会话历史里的 check_inbox（i28-IBX1）：agent 回合中用 check_inbox 领走的消息，在会话记录里只存在于那次的工具结果里，
 * 历史又不画工具结果——一刷新就没了。这里把那次工具结果拆成一条条入站消息，排在那次调用之后（lib/session-history.ts 调用）。
 *
 * - 同一 message_id 只出一次：没 ack 再调会原样重给同一批；租约过期后又按普通 <channel> 消息重投（message_id 不变）。
 *   先出现的那份算数，后来的由 fresh() 挡掉。
 * - 太长没进批的只给了开头（批尾的无编号预览，或已打租约后原样重给的那批里的编号预览）：显示开头、注明全文随后单独送达，
 *   同一条的预览只出一次；预览不算「已显示」，全文按普通消息到达时照常进历史。
 * - seq：拆出来的消息挂在工具结果那一行上，取 行号 + 0.01·k，网页的 h<seq> 气泡 id 不撞、差量游标照样按大小比；
 *   网页按 h<seq> 取行号的地方（差量去重、向下翻页、隐藏）和隐藏接口都认这种两位小数。
 * - 发送者只认 bridge 写的抬头（lib/inbox-batch.ts 校验条数）；拆不对就整段原文作为一条「收件箱」消息，不认任何发送者。
 */
import { answerEcho, stripChannelHeader } from "./inbound-body.js";
import { parseInboxBatch, type InboxEntry } from "./inbox-batch.js";
import type { HistoryMessage } from "./session-history.js";

const INBOX_TOOL_RE = /(?:^|__)check_inbox$/;
const INBOX_LABEL = "收件箱";

function resultText(b: any): string {
  const c = b?.content;
  if (typeof c === "string") return c;
  return Array.isArray(c) ? c.map((x: any) => (x?.type === "text" ? x.text || "" : "")).join("\n") : "";
}

/**
 * 剥 bridge 注入头，只剥确知是 bridge 加的（和 <channel> 路径同一口径，lib/inbound-body.ts）：
 * - 来源头：本机 agent（没有回程 chat_id）和 API / peer（回程 api:…）才有；Discord 的人原样投递，正文自己以「[🤖 …]」开头也是正文。
 * - 叫停抬头：批次文本里没有 interrupt_note 那样的属性，认不出是不是 bridge 加的，保守留着（只是多一段字）；
 *   卡片答复例外——它的正文第一行是 bridge 写的作答说明（asks.ts answerContent），前面出现叫停样式只能是 bridge 加的。
 */
function bareBody(e: InboxEntry): string {
  const headed = !e.replyTo || e.replyTo.startsWith("api:");
  if (e.from === "owner 的卡片答复") return stripChannelHeader(e.body, true);
  return headed ? stripChannelHeader(e.body) : e.body.trim();
}

/** 一条领走的消息 → 历史里的入站消息字段（发送者 / 正文 / 卡片答复的 askId·wire） */
function entryFields(e: InboxEntry): Pick<HistoryMessage, "text" | "from" | "fromId" | "askId" | "wire"> {
  const text = bareBody(e);
  if (e.previewOf !== undefined) {
    return { text: `${text}\n\n…（来自 ${e.from} 的长消息，共 ${e.previewOf} 字，这里只显示开头；全文随后单独送达）`, from: INBOX_LABEL };
  }
  const fromId = e.replyTo ? (e.replyTo.startsWith("api:") ? e.replyTo : undefined) : "agent"; // 和 <channel> 的 user_id 同一口径；Discord 人只给了回程频道，没有 user id
  const who = { from: e.from === "owner 的卡片答复" ? "owner" : e.from, ...(fromId ? { fromId } : {}) };
  if (e.from !== "owner 的卡片答复" || !e.replyTo) return { text, ...who };
  const { askId, wire, text: said } = answerEcho(text);
  return { text: said, ...who, ...(askId ? { askId } : {}), ...(wire ? { wire } : {}) };
}

export function inboxHistory() {
  const shown = new Set<string>(), previewed = new Set<string>();
  return {
    /** tool_result 块 → 拆出的入站消息（不是 check_inbox 的结果、报错、空收件箱 / 只 ack → []） */
    expand(card: { name: string } | undefined, b: any, seq: number, ts: string | null): HistoryMessage[] {
      if (b?.type !== "tool_result" || b.is_error === true || !card || !INBOX_TOOL_RE.test(card.name)) return [];
      const text = resultText(b);
      const parsed = parseInboxBatch(text);
      const at = (k: number) => Math.round((seq + 0.01 * (k + 1)) * 100) / 100;
      if (parsed === "malformed") return [{ seq: at(0), ts, role: "user", text: text.trim(), from: INBOX_LABEL }];
      const out: HistoryMessage[] = [];
      for (const e of parsed ?? []) {
        if (shown.has(e.messageId) || (e.previewOf !== undefined && previewed.has(e.messageId))) continue; // 预览只出一次，全文出过就不再出预览
        const f = entryFields(e);
        if (!f.text.trim()) continue;
        (e.previewOf === undefined ? shown : previewed).add(e.messageId);
        out.push({ seq: at(out.length), ts, role: "user", ...f });
      }
      return out;
    },
    /** 这条普通入站消息（message_id）还没作为领走的消息显示过 */
    fresh(messageId: string | null): boolean {
      return !messageId || !shown.has(messageId);
    },
  };
}
