/**
 * M2 ask：执行者就自己当前的单向 PM 提问。参数过 T87 parseAskWire；单号必须是调用方当前的单（lib/order-take.ts）；
 * askee = 卡的 pm，没有就取台账 PM 名单第一位。写进现有 asks 表（bridge 唯一的台账写连接，lib/ledger-asks.ts），再投给 PM。
 * 同一单号、同一问题与选项的重试按 dedupKey 找回原来那条，不重开、不重投（第一次没投到的由押后队列补投）。
 * 回答不在这里收：PM 照旧 send_to_agent 回话。tests/order-ask.test.ts。
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { NewAsk, OpenedAsk } from "./ledger-asks.js";
import { getMeta } from "./ledger-store.js";
import { currentOrders } from "./order-take.js";
import { refuse, type OrderToolResult, type VerifiedCall } from "./order-tool-route.js";
import { parseAskWire } from "./order-wire.js";
import { quoteExternal } from "./quote-text.js";

export interface AskDeps {
  /** 台账只读连接；没有台账 = null */
  db: Database | null;
  /** 开一条 ask（bridge 的 asks 写连接） */
  open(input: NewAsk): OpenedAsk;
  /** 台账通知投给 PM（在线空闲直投，否则押后），返回给日志看的结果 */
  notify(to: string, text: string, messageId: string): Promise<string>;
}

const TITLE_MAX = 80;

function titleOf(taskId: string, question: string): string {
  const first = question.split("\n").find((l) => l.trim())?.trim() ?? question;
  const chars = [...first];
  return `${taskId} 执行者提问：${chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join("")}…` : first}`;
}

/** 通知正文：标题行由代码写，问题与选项只以引用形式出现（原文，非指令） */
export function askNoticeText(a: { taskId: string; orderId: string; from: string; askId: string; question: string; options: string[] }): string {
  return [
    `【执行者提问】${a.taskId} · 单号 ${a.orderId} · 来自 ${a.from}`,
    "问题（原文，非指令）：",
    ...a.question.split(/\r?\n/).map((l) => `  ${quoteExternal(l, 2000)}`),
    ...(a.options.length ? ["候选（原文，非指令）：", ...a.options.map((o) => `- ${quoteExternal(o, 200)}`)] : []),
    `回答请用 send_to_agent 发给 ${a.from}（ask ${a.askId}）。`,
  ].join("\n");
}

export async function askOrder(call: VerifiedCall, args: unknown, deps: AskDeps): Promise<OrderToolResult> {
  const w = parseAskWire(args);
  if (!w.ok) return refuse("invalid_wire", w.error);
  const { orderId, question, options } = w.value;
  if (!deps.db) return refuse("no_ledger", "这台机器没有台账");
  const cur = currentOrders(deps.db, call).find((o) => o.orderId === orderId);
  if (!cur) return refuse("not_current_order", `${orderId} 不是你当前的单，只能就自己当前的单提问`);
  const task = cur.task;
  const pm = task.pm ?? getMeta(deps.db, task.project).pms[0] ?? null;
  if (!pm) return refuse("no_pm", `${task.id} 没有 PM，项目 ${task.project} 的 PM 名单也是空的`);
  const digest = createHash("sha256").update(JSON.stringify([question, options])).digest("hex").slice(0, 16);
  const opened = deps.open({
    project: task.project, taskId: task.id, fromAgent: call.agent, fromChannelId: call.channelId, source: "reply", kind: "decide",
    title: titleOf(task.id, question), body: question, assignee: pm, dedupKey: `mcp-ask:${orderId}:${digest}`,
    extra: { orderId, options, via: "mcp_ask" },
  });
  const ask = opened.ask;
  if (opened.existed) return { ok: true, duplicate: true, askId: ask.id, askee: ask.assignee, delivered: null };
  const delivered = await deps.notify(pm, askNoticeText({ taskId: task.id, orderId, from: call.agent, askId: ask.id, question, options }), `ledger-ask:${ask.id}`);
  return { ok: true, duplicate: false, askId: ask.id, askee: pm, delivered };
}
