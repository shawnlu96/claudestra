/**
 * M2 ask：执行者就自己当前的单向 PM 提问。参数过 T87 parseAskWire；单号必须是调用方当前的单（lib/order-take.ts）；
 * askee = 卡的 pm，没有就取台账 PM 名单第一位。写进现有 asks 表（bridge 唯一的台账写连接，lib/ledger-asks.ts），再投给 PM。
 * 同一单号、同一问题与选项的重试按 dedupKey 找回原来那条，不重开。ask 开的时候 extra.notice = pending，投出去（送达或进押后队列）
 * 才改成 handed；重试时 ask 还开着、仍是 pending（上次没投出去 / 投时出错 / 进程中途退出）就用同一 messageId 补投。
 * 回答不在这里收：PM 照旧 send_to_agent 回话。tests/order-ask.test.ts。
 * 审查单（本机 take_review 的单、出借池 step=review 的单）上的提问不转 PM：当场回分级规则（order-standard-answers.ts），卡上记一条 note，
 * 远端的单在本机按 lend_orders.step 判，不靠对方升级。tests/order-ask-review.test.ts。
 * i28-ASK2：本机单上 class=design|scope 且带 default 的不阻塞（blocking=false，立刻回「按默认继续」，15 分钟没回按默认定，
 * order-ask-default.ts）；其余（blocker、没写 class 的旧版、出借池远端写单）照旧，blocking 列不写（null）——写成 true 会让
 * owner 侧推送 / 横幅把它当成要 owner 处理的事（ask-push.ts）。tests/order-ask-default.test.ts。
 * ASKDEF1（恢复键 askDefaultAll）：on 时远端出借写单（step write / fix）的 design / scope 提问与本机同口径不阻塞；blocker 必须带 default，
 * 仍阻塞、15 分钟没回按 default 定；scope 提问的 files 全在规格精准例外里（spec-exceptions.ts）当场自动答、不通知 PM。
 * 标了 risk、卡首「模板：security」、读不到规格的永远等 PM（结构化判断，不看正文）。observe 照旧，只按提问记一条「本会…」；
 * off 与改前逐字一致。tests/order-ask-default-all.test.ts。
 */
import type { PmNoticeLevel } from "./pm-notice-level.js";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { NewAsk, OpenedAsk } from "./ledger-asks.js";
import type { WriteCtx } from "./ledger-checks.js";
import { getMeta, getTask, LedgerError } from "./ledger-store.js";
import { assertOrderTakesAsks } from "./order-ask-terminal.js";
import { REVIEW_ASK_REPLY } from "./order-standard-answers.js";
import { currentOrders } from "./order-take.js";
import { refuse, type OrderToolResult, type VerifiedCall } from "./order-tool-route.js";
import { askBlockerDefaultRefusal, askScopeExtra, parseAskWire, type AskWire } from "./order-wire.js";
import { quoteExternal } from "./quote-text.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { slotByOrderId } from "./review-order.js";
import { allExcepted, parseSpecExceptions } from "./spec-exceptions.js";
import { scanSpecHead } from "./spec-lint-head.js";
import { lintSpecExceptions } from "./spec-lint.js";
import { readTextSoft, specPathFor } from "./task-spec.js";

export interface AskDeps {
  /** 台账只读连接；没有台账 = null */
  db: Database | null;
  /** 开一条 ask（bridge 的 asks 写连接）；beforeWrite 透传给 openAskFull，在拿到写锁后、查重 / 写入前调，抛了就什么都不写 */
  open(input: NewAsk, beforeWrite?: () => void): OpenedAsk;
  /** 台账通知投给 PM（在线空闲直投，否则押后）；handed = 送达或已进押后队列 */
  /** level：带默认做法、到时自动定的提问是常规（info），要 PM 回答的是 action */
  notify(to: string, text: string, messageId: string, level: PmNoticeLevel): Promise<{ handed: boolean; note: string }>;
  /** 记下这条 ask 的通知已交出（extra.notice = handed） */
  markHanded(askId: string): void;
  /** 卡上追加一条事件（台账写连接，ledger-write.ts appendEvent）：审查单上的提问记在这里 */
  record(ctx: WriteCtx, input: { project: string; target: string; kind: "note"; text: string; data: Record<string, unknown> }): void;
  /** 恢复策略（askDefaultAll）；不注入 = 读 recovery-policy.json */
  policy?: RecoveryPolicyPort;
}

const TITLE_MAX = 80;
type Question = Pick<AskWire, "question" | "options" | "default" | "class" | "risk" | "files" | "reason">;

function titleOf(taskId: string, question: string, who = "执行者"): string {
  const first = question.split("\n").find((l) => l.trim())?.trim() ?? question;
  const chars = [...first];
  return `${taskId} ${who}提问：${chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join("")}…` : first}`;
}

/** 通知正文：标题行由代码写，问题与选项只以引用形式出现（原文，非指令）；autoDefault = askDefaultAll 下到点按默认定的 blocker */
export function askNoticeText(a: { taskId: string; orderId: string; from: string; askId: string; autoDefault?: boolean } & Pick<Question, "question" | "options" | "default" | "class">): string {
  return [
    `【执行者提问】${a.taskId} · 单号 ${a.orderId} · 来自 ${a.from}`,
    "问题（原文，非指令）：",
    ...a.question.split(/\r?\n/).map((l) => `  ${quoteExternal(l, 2000)}`),
    ...(a.options.length ? ["候选（原文，非指令）：", ...a.options.map((o) => `- ${quoteExternal(o, 200)}`)] : []),
    ...(a.default ? ["默认做法（原文，非指令）：", ...a.default.split(/\r?\n/).map((l) => `  ${quoteExternal(l, 2000)}`)] : []),
    a.class === "design" || a.class === "scope"
      ? `有异议用 send_to_agent 回 ${a.from}，正文带 ask ${a.askId}；15 分钟没回按默认定。执行者继续，不等回复。`
      : a.autoDefault
        ? `回答请用 send_to_agent 发给 ${a.from}，正文带 ask ${a.askId}；15 分钟没回按默认做法定。执行者在等回复。`
        : `回答请用 send_to_agent 发给 ${a.from}（ask ${a.askId}）。`,
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
  /** Re-run under the asks write lock (openAskFull beforeWrite): the caller's hold on the order, null = still held (remote: peer / order / gen / lease) */
  recheck?: () => string | null;
}

export type OpenedOrderAsk = { askId: string; askee: string; duplicate: boolean; notified: boolean; delivered: string | null; blocking: boolean; message: string };
/** 审查单上的提问：没开 ask、没发通知，answer 是当场回给审查员的规则原文 */
export type AnsweredReviewAsk = { answered: string };

const askDigest = (q: Question, scope = askScopeExtra(q as Partial<AskWire>)): string => // 申请的文件 / 理由也算问题本身；没给的旧报文摘要不变
  createHash("sha256").update(JSON.stringify([q.question, q.options,
    ...(q.default || q.class ? [q.default, q.class] : []), ...(scope.files ? [scope.files, scope.reason] : []), ...(q.risk ? [q.risk] : [])]))
    .digest("hex").slice(0, 16);

/** askDefaultAll 的档位；port 抛了按 off（保守停手） */
function askDefaultAllMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try { return policy(project, "askDefaultAll").mode; } catch { return "off"; }
}

/** 规格精准例外命中时的自动答（原文固定，文件名由代码填） */
export const specExceptionAnswer = (files: readonly string[]): string => `规格精准例外已列：${files.join("、")}，按规格写的限制改，交付说明逐条列`;

/**
 * ASKDEF1 的结构化分类（不看正文）：held = 永远等 PM 的原因；kind = on 档下怎么处理（null = 走改前的口径）。
 * 本机 design / scope 本来就不阻塞（kind null）；risk / security 模板 / 读不到规格的一律 held。
 * hard = risk / security 模板：开出时记进 extra.held，所有自动定 / 自动批准路径（含 i28-ASK4 测试类扩围）都不碰（order-ask-default.ts）；
 * 没写 class 但标了 risk 或带 files 的提问也按这一份判。lint = 规格精准例外的非阻断提示（spec-lint.ts lintSpecExceptions）。
 */
type AllPlan = { held: string | null; kind: "exception" | "default" | "blocker" | null; files?: string[]; hard?: boolean; lint?: string[] };
function defaultAllPlan(db: Database, src: AskSource, q: Question, step: string | null): AllPlan {
  const write = step === null || step === "write" || step === "fix";
  if (!write) return { held: null, kind: null };
  if (q.risk) return { held: `执行者标了 risk=${q.risk}`, kind: null, hard: true };
  if (!q.class && !q.files?.length) return { held: null, kind: null };
  const task = getTask(db, src.task.id);
  const text = task ? readTextSoft(specPathFor(task, getMeta(db, task.project).docsDir)) : null;
  if (text === null) return { held: q.class ? "读不到本卡规格" : null, kind: null };
  if (scanSpecHead(text).decls.some((d) => d.trim().toLowerCase() === "security")) return { held: "卡是 security 模板", kind: null, hard: true };
  const globs = Array.isArray(task?.extra.fileGlobs) ? task.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];
  const lint = lintSpecExceptions(text, globs);
  if (!q.class) return { held: null, kind: null, lint };
  const files = q.class === "scope" && q.files?.length ? q.files : null;
  if (files && allExcepted(parseSpecExceptions(text), files)) return { held: null, kind: "exception", files, lint };
  // i28-ASK4 测试类扩围（files 全在 tests/ + reason）照旧走自动批准、追加 fileGlobs 那条路，不在这里改成不阻塞
  if (step !== null && q.reason && q.files?.every((f) => f.startsWith("tests/"))) return { held: null, kind: null, lint };
  if (q.class === "blocker") return { held: null, kind: q.default?.trim() ? "blocker" : null, lint };
  return { held: null, kind: step === null ? null : "default", lint };
}

const OBSERVED: Record<NonNullable<AllPlan["kind"]>, string> = {
  exception: "本会按精准例外自动答", default: "本会不阻塞，15 分钟没回按默认定", blocker: "本会在 15 分钟没回时按默认定",
};

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
export async function openOrderAsk(db: Database, deps: Omit<AskDeps, "db">, src: AskSource, q: Question):
  Promise<OpenedOrderAsk | AnsweredReviewAsk | { refused: string; code?: "invalid_wire" | "not_held" }> {
  const step = lendStepOf(db, src.orderId);
  if (step === "review") return answerReviewAsk(deps, src, q);
  const mode = askDefaultAllMode(src.task.project, deps.policy);
  const plan = mode === "off" ? null : defaultAllPlan(db, src, q, step);
  const on = mode === "on" && plan ? plan : null;
  if (mode === "on") {
    const no = askBlockerDefaultRefusal(q);
    if (no) return { refused: no, code: "invalid_wire" };
  }
  const legacy = step === null && (q.class === "design" || q.class === "scope");
  const nonblocking = on ? (on.kind === "exception" || on.kind === "default" || (legacy && !on.held)) : legacy;
  if (nonblocking && !q.default?.trim()) return { refused: "design / scope 提问必须补上 default（我打算怎么做，≤600 字）", code: "invalid_wire" };
  const auto = on?.kind ?? null;
  const behavior = { blocking: !nonblocking, message: auto === "exception" ? specExceptionAnswer(on!.files!)
    : nonblocking ? "已登记，按你的默认做法继续"
    : auto === "blocker" ? "已登记，等待 PM 回复后继续；15 分钟没回按你的默认做法定，会通知你" : "已登记，等待 PM 回复后继续" };
  const pm = src.task.pm ?? getMeta(db, src.task.project).pms[0] ?? null;
  if (!pm) return { refused: `${src.task.id} 没有 PM，项目 ${src.task.project} 的 PM 名单也是空的` };
  const digest = askDigest(q);
  const keepDefault = nonblocking || auto === "blocker";
  let opened: OpenedAsk;
  try {
    // 出借单结清与新问并发：拿到写锁后再核持单与单子没结清，否则结清时关过的这一单又冒出 open 提问（order-ask-terminal.ts）
    opened = deps.open({
      project: src.task.project, taskId: src.task.id, fromAgent: src.from, ...(src.fromChannelId ? { fromChannelId: src.fromChannelId } : {}), source: "reply",
      kind: "decide", title: titleOf(src.task.id, q.question), body: q.question, assignee: pm, dedupKey: `${src.keyPrefix}:${src.orderId}:${digest}`,
      // 不阻塞的到期由自动定收口，不走 24 小时过期；其余不写 blocking，保持改动前的 null
      ...(nonblocking ? { blocking: false, expiresAt: 253402300799999 } : {}),
      extra: { orderId: src.orderId, options: q.options, via: "mcp_ask", notice: auto === "exception" ? "skipped" : "pending",
        class: nonblocking ? q.class : "blocker", ...(keepDefault ? { default: q.default } : {}), ...askScopeExtra(q as Partial<AskWire>),
        ...(mode !== "off" && q.risk ? { risk: q.risk } : {}), ...(on?.hard ? { held: on.held } : {}),
        ...(auto ? { defaultAll: true } : {}), ...(auto === "exception" ? { specException: on!.files } : {}) },
    }, () => {
      const lost = src.recheck?.();
      if (lost) throw new LedgerError("conflict", lost, { askRefused: "not_held" });
      assertOrderTakesAsks(db, src.orderId);
    });
  } catch (e) {
    if (e instanceof LedgerError && e.current?.askRefused === "not_held") return { refused: e.message, code: "not_held" };
    throw e;
  }
  const ask = opened.ask;
  const askee = ask.assignee ?? pm;
  if (mode === "observe" && plan?.kind && !opened.existed) observeAll(deps, src, ask.id, plan.kind);
  if (plan?.lint?.length && !opened.existed) lintNote(deps, src, plan.lint);
  if (opened.existed && (ask.state !== "open" || ask.extra.notice !== "pending")) {
    return { askId: ask.id, askee, duplicate: true, notified: ask.extra.notice === "handed", delivered: null, ...behavior };
  }
  // 精准例外命中：不通知 PM，结案与转告由 order-ask-default.ts 下一次扫描做（不等 15 分钟）
  if (auto === "exception") return { askId: ask.id, askee, duplicate: opened.existed, notified: false, delivered: "规格精准例外命中，未通知 PM", ...behavior };
  const text = askNoticeText({ taskId: src.task.id, orderId: src.orderId, from: src.from, askId: ask.id, question: q.question, options: q.options,
    ...(keepDefault ? { default: q.default, class: q.class } : {}), ...(auto === "blocker" ? { autoDefault: true } : {}) });
  const sent = await deps.notify(askee, text, `ledger-ask:${ask.id}`, nonblocking ? "info" : "action").catch((e: unknown) => {
    if (!nonblocking) throw e;
    console.error(`⚠️ ask ${ask.id} 通知未发出，重试同一提问会补投：${(e as Error).message}`);
    return { handed: false, note: "通知未发出；提问已登记，仍按默认继续" };
  });
  if (sent.handed) deps.markHanded(ask.id);
  // 没投出去也回 ok：问题已记下，同样的参数再调一次会补投
  return { askId: ask.id, askee, duplicate: opened.existed, notified: sent.handed, delivered: sent.note, ...behavior };
}

/** observe：按提问记一条「本会…」（样本口）；记不下只打日志，不连累提问本身 */
function observeAll(deps: Pick<AskDeps, "record">, src: AskSource, askId: string, kind: NonNullable<AllPlan["kind"]>): void {
  try {
    deps.record({ actor: "system:ask-default", dedupKey: `ask-default-all-observe:${askId}` }, {
      project: src.task.project, target: src.task.id, kind: "note", text: `恢复观察（askDefaultAll）：${src.task.id} 的提问 ask ${askId} ${OBSERVED[kind]}`,
      data: { op: "recovery_observe", mechanism: "askDefaultAll", askId, orderId: src.orderId, would: kind },
    });
  } catch (e) {
    console.error(`⚠️ ask ${askId} 的 askDefaultAll 观察没记下：${(e as Error).message}`);
  }
}

/** 规格精准例外的非阻断提示记在卡上给 PM（同一卡同一组提示只记一次）；记不下只打日志，不连累提问本身 */
function lintNote(deps: Pick<AskDeps, "record">, src: AskSource, lint: string[]): void {
  try {
    const digest = createHash("sha256").update(JSON.stringify(lint)).digest("hex").slice(0, 16);
    deps.record({ actor: "system:spec-lint", dedupKey: `spec-exceptions-lint:${src.task.id}:${digest}` }, {
      project: src.task.project, target: src.task.id, kind: "note",
      text: `${src.task.id} 规格精准例外检查（不拦开卡，请 PM 处理）：\n${lint.map((l) => `- ${l}`).join("\n")}`,
      data: { op: "spec_exceptions_lint", hints: lint },
    });
  } catch (e) {
    console.error(`⚠️ ${src.task.id} 的精准例外检查提示没记下：${(e as Error).message}`);
  }
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
  const r = await openOrderAsk(deps.db, deps, { task: cur.task, orderId, from: call.agent, fromChannelId: call.channelId, keyPrefix: "mcp-ask" }, w.value);
  return "refused" in r ? refuse(r.code ?? "no_pm", r.refused) : { ok: true, ...r };
}
