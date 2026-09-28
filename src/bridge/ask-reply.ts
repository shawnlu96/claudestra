/**
 * agent 的 reply → 「待你处理」（docs 13 §4.3）。bridge.ts 的 ws reply 处理只调 deliverReplyWithAsk 这一个：
 * - 隐式（三期）：带选项、发给 owner 的自动建 ask（kind=decide、blocking 未知）；
 * - 显式（四期）：reply 带 `ask` 字段（lib/ask-bind.ts 校验）。声明了就建，哪怕没有按钮；kind=inform 不建 ask、这条回复不推送；
 *   authorize 带绑定（参数哈希回给 agent，执行前 ledger ask-check）；同一个 agent 同一个 key 再问，旧的 superseded。
 * `ask` 字段不合格整条 reply 退回给 agent（Delivery dropped + 原因），不猜、不静默丢。建 ask 出错不挡回复本身。
 */
import { missingApprove, paramsHash, parseReplyAsk, type ReplyAsk } from "../lib/ask-bind.js";
import { draftFromReply, type AskRow, type ReplyAskDraft } from "../lib/ask-options.js";
import { closeAsk, openAskFull, patchAsk, type Ask, type NewAsk } from "../lib/ledger-asks.js";
import { markdownToPlain } from "../lib/plain-text.js";
import { askDb, parentExtra, publishAsk, taskOf, toOwner, whoIs } from "./asks.js";
import type { Delivery, Envelope } from "./router.js";

/** 知会类回复的 threadId：推送派发器据此不推（push/init.ts 接 isQuietReply）。只记最近的，10 分钟后忘掉 */
const quiet = new Map<string, number>();
const QUIET_TTL_MS = 10 * 60_000;

export function isQuietReply(threadId: unknown): boolean {
  const at = typeof threadId === "string" ? quiet.get(threadId) : undefined;
  return at !== undefined && Date.now() - at < QUIET_TTL_MS;
}

function markQuiet(threadId: string): void {
  const now = Date.now();
  for (const [k, at] of quiet) if (now - at >= QUIET_TTL_MS) quiet.delete(k);
  quiet.set(threadId, now);
}

/** 显式 ask 没有按钮时也要有标题和背景：和隐式同一个取法（正文首行 / 其余） */
function draftOf(text: string, components: unknown, explicit: boolean): ReplyAskDraft | null {
  const d = draftFromReply(text, components);
  if (d || !explicit) return d;
  const lines = markdownToPlain(text).split("\n").map((l) => l.trim()).filter(Boolean);
  const title = Array.from(lines[0] ?? "待你处理").slice(0, 40).join("");
  return { title, context: lines.slice(1).join("\n").slice(0, 300), options: [], kindHint: null };
}

const optionIds = (rows: AskRow[]) => new Set(rows.flatMap((r) => (r.type === "buttons" ? r.buttons.map((b) => b.id) : [r.id])));

/** 显式字段 → openAsk 的那几列；授权类的 approve 按钮不在选项里 → 错误句 */
function explicitColumns(x: ReplyAsk, draft: ReplyAskDraft, now: number): Partial<NewAsk> | string {
  const cols: Partial<NewAsk> = { kind: x.kind === "inform" ? "decide" : x.kind };
  if (x.bind) {
    const missing = missingApprove(x.bind, optionIds(draft.options));
    if (missing.length) return `ask.bind.approve lists button id(s) not in this reply: ${missing.join(", ")}`;
    cols.bind = { ...x.bind, paramsHash: paramsHash(x.bind.params) };
  }
  const key = x.key ?? (x.kind === "authorize" ? x.bind?.action : undefined);
  if (key) cols.askKey = key;
  cols.blocking = x.blocking ?? (x.kind === "authorize" || x.kind === "owner_action" ? true : null);
  if (x.expiresIn) cols.expiresAt = now + x.expiresIn * 1000;
  // 三句背景（docs 13 §4.2）：agent 写了 why / ifIgnored 就用它的，否则取正文
  if (x.why || x.ifIgnored) cols.context = [x.why, x.ifIgnored ? `不处理会怎样：${x.ifIgnored}` : ""].filter(Boolean).join("\n");
  return cols;
}

type Opened = { ask: Ask | null; error?: string };

async function openAskForReply(env: Envelope, chatId: string, fromChannelId: string, raw: unknown): Promise<Opened> {
  let explicit: ReplyAsk | undefined;
  if (raw !== undefined && raw !== null) {
    const p = parseReplyAsk(raw);
    if ("error" in p) return { ask: null, error: p.error };
    explicit = p.ask;
    if (explicit.kind === "inform") {
      markQuiet(env.meta.threadId);
      return { ask: null };
    }
  }
  const draft = draftOf(env.content, env.meta.components, !!explicit);
  if (!draft || !(await toOwner(chatId))) return { ask: null };
  const who = await whoIs(fromChannelId);
  if (!who) return { ask: null };
  const now = Date.now();
  const cols = explicit ? explicitColumns(explicit, draft, now) : {};
  if (typeof cols === "string") return { ask: null, error: cols };
  const r = openAskFull(askDb(), {
    project: who.project, taskId: taskOf(who.name), fromAgent: who.name, fromChannelId, source: "reply", kind: "decide", blocking: null,
    title: draft.title, context: draft.context, body: env.content, options: draft.options, kindHint: draft.kindHint, chatId, threadId: env.meta.threadId,
    ...parentExtra(who), ...cols,
  }, now);
  for (const old of r.superseded) publishAsk(old);
  publishAsk(r.ask);
  return { ask: r.ask };
}

/**
 * 带选项（或显式 ask）、发给 owner 的先建 ask，askId / 参数哈希进 env.meta（出站事件带给网页，reply 结果回给 agent）；
 * 投递成功补记 Discord 消息 id，失败把 ask 撤掉。
 */
export async function deliverReplyWithAsk(env: Envelope, chatId: string, fromChannelId: string, send: (e: Envelope) => Promise<Delivery>, rawAsk?: unknown): Promise<Delivery> {
  let a: Ask | null = null;
  try {
    const o = await openAskForReply(env, chatId, fromChannelId, rawAsk);
    if (o.error) return { envelope: env, outcome: { kind: "dropped", reason: `invalid ask field: ${o.error}` } };
    a = o.ask;
  } catch (e) {
    console.error(`⚠️ reply 自动建 ask 失败（回复照发）: ${(e as Error).message}`);
  }
  if (a) {
    env.meta.askId = a.id;
    if (a.bind) env.meta.askHash = a.bind.paramsHash;
  }
  const d = await send(env);
  if (!a) return d;
  try {
    const files = env.meta.sentFiles?.length ? { extra: { files: env.meta.sentFiles } } : {};
    if (d.outcome.kind === "sent") patchAsk(askDb(), a.id, { discordMessageIds: d.outcome.discordMessageIds ?? [], ...files });
    else {
      const c = closeAsk(askDb(), a.id, "cancelled", "reply 没发出去");
      if (c) publishAsk(c);
    }
  } catch (e) {
    console.error(`⚠️ 补记 ask ${a.id} 的投递结果失败: ${(e as Error).message}`);
  }
  return d;
}
