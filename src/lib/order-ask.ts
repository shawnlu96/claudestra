/**
 * M2 ask：执行者就自己当前的单向 PM 提问。参数过 T87 parseAskWire；单号必须是调用方当前的单（lib/order-take.ts）；
 * askee = 卡的 pm，没有就取台账 PM 名单第一位。写进现有 asks 表（bridge 唯一的台账写连接，lib/ledger-asks.ts），再投给 PM。
 * 同一单号、同一问题与选项的重试按 dedupKey 找回原来那条，不重开。ask 开的时候 extra.notice = pending，投出去（送达或进押后队列）
 * 才改成 handed；重试时 ask 还开着、仍是 pending（上次没投出去 / 投时出错 / 进程中途退出）就用同一 messageId 补投。
 * 回答不在这里收：PM 照旧 send_to_agent 回话。tests/order-ask.test.ts。
 * 审查单（本机 take_review 的单、出借池 step=review 的单）上的提问不转 PM：当场回分级规则（order-standard-answers.ts），卡上记一条 note，
 * 远端的单在本机按 lend_orders.step 判，不靠对方升级。tests/order-ask-review.test.ts。
 */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { NewAsk, OpenedAsk } from "./ledger-asks.js";
import type { WriteCtx } from "./ledger-checks.js";
import { getMeta } from "./ledger-store.js";
import { REVIEW_ASK_REPLY } from "./order-standard-answers.js";
import { currentOrders } from "./order-take.js";
import { refuse, type OrderToolResult, type VerifiedCall } from "./order-tool-route.js";
import { parseAskWire } from "./order-wire.js";
import { quoteExternal } from "./quote-text.js";
import { slotByOrderId } from "./review-order.js";

export interface AskDeps {
  /** 台账只读连接；没有台账 = null */
  db: Database | null;
  /** 开一条 ask（bridge 的 asks 写连接） */
  open(input: NewAsk): OpenedAsk;
  /** 台账通知投给 PM（在线空闲直投，否则押后）；handed = 送达或已进押后队列 */
  notify(to: string, text: string, messageId: string): Promise<{ handed: boolean; note: string }>;
  /** 记下这条 ask 的通知已交出（extra.notice = handed） */
  markHanded(askId: string): void;
  /** 卡上追加一条事件（台账写连接，ledger-write.ts appendEvent）：审查单上的提问记在这里 */
  record(ctx: WriteCtx, input: { project: string; target: string; kind: "note"; text: string; data: Record<string, unknown> }): void;
}

const TITLE_MAX = 80;

function titleOf(taskId: string, question: string, who = "执行者"): string {
  const first = question.split("\n").find((l) => l.trim())?.trim() ?? question;
  const chars = [...first];
  return `${taskId} ${who}提问：${chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join("")}…` : first}`;
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

/** Who asks about which card; the caller resolved all of it (local: the verified agent's current order; remote: the lend order row). */
export interface AskSource {
  task: { id: string; project: string; pm: string | null };
  orderId: string;
  /** the asker as the PM should answer it: a local agent name, or worker@peer */
  from: string;
  fromChannelId?: string;
  /** dedupKey prefix: retries of the same question on the same order find the same ask */
  keyPrefix: string;
}

export type OpenedOrderAsk = { askId: string; askee: string; duplicate: boolean; notified: boolean; delivered: string | null };
/** 审查单上的提问：没开 ask、没发通知，answer 是当场回给审查员的规则原文 */
export type AnsweredReviewAsk = { answered: string };

const askDigest = (q: { question: string; options: string[] }): string =>
  createHash("sha256").update(JSON.stringify([q.question, q.options])).digest("hex").slice(0, 16);

/** 出借池里这一单的步骤；本机的单（调度器 intent / 手动单号）不在 lend_orders 里 = null */
function lendStepOf(db: Database, orderId: string): string | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lend_orders'").get()) return null;
  return (db.query("SELECT step FROM lend_orders WHERE orderId = ?").get(orderId) as { step: string } | null)?.step ?? null;
}

/** 审查单上的提问：卡上记一条 note（问题原文在 data 里；同一单同一问题重试按 dedupKey 只记一次），回规则原文 */
function answerReviewAsk(deps: Pick<AskDeps, "record">, src: AskSource, q: { question: string; options: string[] }): AnsweredReviewAsk {
  deps.record({ actor: src.from, dedupKey: `review-ask:${src.orderId}:${askDigest(q)}` }, {
    project: src.task.project, target: src.task.id, kind: "note", text: `${titleOf(src.task.id, q.question, "审查员")}（系统按分级规则当场回答，未转 PM）`,
    data: { op: "review_ask", orderId: src.orderId, from: src.from, question: q.question, options: q.options },
  });
  return { answered: REVIEW_ASK_REPLY };
}

/**
 * Open (or find again) the ask on the card's PM and hand the notice over; shared by the local ask tool and a remote worker's
 * lend/ask (lib/ledger-lend-peers.ts RemoteCaller). The notice quotes the question; nothing else of the card goes in it.
 */
export async function openOrderAsk(db: Database, deps: Omit<AskDeps, "db">, src: AskSource, q: { question: string; options: string[] }):
  Promise<OpenedOrderAsk | AnsweredReviewAsk | { refused: string }> {
  if (lendStepOf(db, src.orderId) === "review") return answerReviewAsk(deps, src, q);
  const pm = src.task.pm ?? getMeta(db, src.task.project).pms[0] ?? null;
  if (!pm) return { refused: `${src.task.id} 没有 PM，项目 ${src.task.project} 的 PM 名单也是空的` };
  const digest = askDigest(q);
  const opened = deps.open({
    project: src.task.project, taskId: src.task.id, fromAgent: src.from, ...(src.fromChannelId ? { fromChannelId: src.fromChannelId } : {}), source: "reply",
    kind: "decide", title: titleOf(src.task.id, q.question), body: q.question, assignee: pm, dedupKey: `${src.keyPrefix}:${src.orderId}:${digest}`,
    extra: { orderId: src.orderId, options: q.options, via: "mcp_ask", notice: "pending" },
  });
  const ask = opened.ask;
  const askee = ask.assignee ?? pm;
  if (opened.existed && (ask.state !== "open" || ask.extra.notice !== "pending")) {
    return { askId: ask.id, askee, duplicate: true, notified: ask.extra.notice === "handed", delivered: null };
  }
  const text = askNoticeText({ taskId: src.task.id, orderId: src.orderId, from: src.from, askId: ask.id, question: q.question, options: q.options });
  const sent = await deps.notify(askee, text, `ledger-ask:${ask.id}`);
  if (sent.handed) deps.markHanded(ask.id);
  // 没投出去也回 ok：问题已记下，同样的参数再调一次会补投
  return { askId: ask.id, askee, duplicate: opened.existed, notified: sent.handed, delivered: sent.note };
}

export async function askOrder(call: VerifiedCall, args: unknown, deps: AskDeps): Promise<OrderToolResult> {
  const w = parseAskWire(args);
  if (!w.ok) return refuse("invalid_wire", w.error);
  const { orderId, question, options } = w.value;
  if (!deps.db) return refuse("no_ledger", "这台机器没有台账");
  const cur = currentOrders(deps.db, call).find((o) => o.orderId === orderId);
  if (!cur) {
    const review = slotByOrderId(deps.db, orderId, call);
    if (review) return { ok: true, ...answerReviewAsk(deps, { task: review.task, orderId, from: call.agent, keyPrefix: "review-ask" }, { question, options }) };
    return refuse("not_current_order", `${orderId} 不是你当前的单，只能就自己当前的单提问`);
  }
  const r = await openOrderAsk(deps.db, deps, { task: cur.task, orderId, from: call.agent, fromChannelId: call.channelId, keyPrefix: "mcp-ask" }, { question, options });
  return "refused" in r ? refuse("no_pm", r.refused) : { ok: true, ...r };
}
