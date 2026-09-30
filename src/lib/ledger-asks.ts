/**
 * 「待你处理」的库（docs 13 §4.2 §4.6）：asks 表 + ask / decision / ask_expire / ask_cancel 事件，每个写函数一个 BEGIN IMMEDIATE 事务。
 * 10-ledger §2「bridge 只读」的唯一例外：作答只能经 bridge（HTTP 的 owner 凭据 / Discord 交互），CLI 不提供 answer，
 * 所以 bridge 用自己的写连接写这张表；阶段机、items、tasks 一律不碰（那些只在 ledger-write.ts）。
 * 读函数同时给 bridge 的只读连接用：库是 v1（CLI 旧版建的、还没人建过 ask）时 hasAsksTable 为假，调用方按空处理。
 */
import type { Database } from "bun:sqlite";
import type { EventKind } from "./ledger-stages.js";
import { answerGroups, matchWire, type AskRow } from "./ask-options.js";
import { busyAsLedgerError, LedgerError } from "./ledger-store.js";

/** assigned = 指派给某个人的事项（T28 的 human 节点）：assignee 本人或 owner 作答，作答不回投任何 agent */
export type AskKind = "decide" | "authorize" | "owner_action" | "accept" | "assigned";
/** superseded = 同一个 agent 用同一个 key 开了新的一条（授权参数变了），旧按钮失效 */
type AskState = "open" | "answered" | "expired" | "cancelled" | "superseded";
/** human / system = 人或系统发起的（chat 审核、409 转人工、指派）：没有发起 agent，fromAgent 为空 */
export type AskSource = "reply" | "auq" | "permission" | "codex" | "human" | "system";
/** 运行时卡住的镜像（AUQ / 权限 / Codex 弹框）：只活在 bridge 内存里，作答走原有的按键端点，bridge 重启时撤掉重建 */
export const isRuntimeAsk = (a: { source: AskSource }): boolean => a.source === "auq" || a.source === "permission" || a.source === "codex";
/** 大总管不属于任何项目，它发的 ask 记在这个 project 下，只从跨项目的 /api/v1/asks 读 */
export const MASTER_PROJECT = "master";

const HOUR = 3600_000;
/** 默认有效期（docs 13 §4.2）；没人点 ≠ 同意，到期按未批准处理 */
export const ASK_TTL_MS: Record<AskKind, number> = { decide: 24 * HOUR, authorize: 4 * HOUR, owner_action: 24 * HOUR, accept: 7 * 24 * HOUR, assigned: 72 * HOUR };

/** 作答是从哪条路来的：卡片 / 聊天里的按钮或表单 / Discord / 运行时弹框的交互端点 / 终端里自己答了 */
export type AskVia = "web_card" | "web_chat" | "discord" | "interact" | "terminal";

export interface AskAnswer {
  /** 回投给 agent 的 wire 行：`[button:id]` / `[select:id:v1,v2]`；多行 reply 逐行点时是累积的 */
  choices: string[];
  /** choices 的人话（按钮 / 选项文字）：decision 事件、卡片、Discord 提示都用它 */
  labels: string[];
  /** owner 另外写的话（卡片文本框 / 输入框里表单同步行之外的文字） */
  text: string;
  principal: string;
  device?: string;
  via: AskVia;
  at: number;
  /** 卡片一次提交 = 这就是全部答案：不管还有没有没答的组都结案 */
  final?: boolean;
  /** 作答附带的附件引用（指派事项「完成」时的说明图等，T28a 存在 talk 附件库）：这里只原样存 */
  atts?: AskAtt[];
  /** 作答的不是 owner 本人（guest）：原话不进 decision 的 text */
  external?: boolean;
  /** 认证入口判定是 owner 本人作答（bridge/asks.ts commitAnswer）：要 owner 批准的闸只认这个正面标记，缺了不算 */
  owner?: true;
}

/** owner 本人答的：只认正面标记，旧答复 / 运行时弹框 / 来源不明的一律不算，推不出就不认 */
export const ownerAnswered = (a: AskAnswer | null | undefined): boolean => a?.owner === true && a.external !== true;

export interface AskAtt {
  kind: string;
  ref: string;
  name?: string;
  mime?: string;
}

/**
 * 授权绑定（docs 13 §4.7）：agent 执行前跑 `ledger ask-check <id> --hash <h>`，参数对不上就重新问。approve = 表示「批准」的按钮 id。
 * bypass 模式下这是产品约束，不是安全边界
 */
export interface AskBind {
  action: string;
  params: unknown;
  paramsHash: string;
  approve: string[];
  version?: string;
}

export interface Ask {
  id: string;
  project: string;
  itemId: string | null;
  taskId: string | null;
  /** 人 / 系统发起的为 null */
  fromAgent: string | null;
  fromChannelId: string | null;
  source: AskSource;
  kind: AskKind;
  /** null = 自动建的，不知道卡不卡活 */
  blocking: boolean | null;
  urgency: "normal" | "urgent";
  title: string;
  context: string;
  body: string;
  /** reply 的 components 行（网页 WebComponentRow 同形），运行时弹框是它自己的选项 */
  options: unknown[];
  allowText: boolean;
  kindHint: string | null;
  chatId: string;
  threadId: string | null;
  discordMessageIds: string[];
  expiresAt: number;
  state: AskState;
  answer: AskAnswer | null;
  outboxMessageId: string | null;
  extra: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  /** 指给谁（T8h 的 assignee 格式）：人是 `local:<principalId>`，本机 agent 是 agent 名；null = 没指派，按台账的门看 */
  assignee: string | null;
  /** 人 / 系统发起的：发起的 principal（或 "system:<来由>"） */
  createdBy: string | null;
  /** 取代键：同一个 agent 同一个 key 再开一条，旧的记 superseded */
  askKey: string | null;
  bind: AskBind | null;
  /** 这一条取代了哪一条 */
  supersedes: string | null;
  /** 去重键：同一个键只会有一条（T28a 的 assign:<taskId>:<round>:<attempt>），撞上时返回已有的 */
  dedupKey: string | null;
}

export type NewAsk = Pick<Ask, "project" | "source" | "kind" | "title"> &
  Partial<Pick<Ask, "fromAgent" | "fromChannelId" | "itemId" | "taskId" | "blocking" | "urgency" | "context" | "body" | "options" | "allowText" | "kindHint" |
    "chatId" | "threadId" | "expiresAt" | "extra" | "assignee" | "createdBy" | "askKey" | "bind" | "dedupKey">>;

type Row = Record<string, unknown>;

function json<T>(s: unknown, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  return JSON.parse(s) as T;
}

function toAsk(r: Row): Ask {
  return {
    ...(r as unknown as Ask),
    blocking: r.blocking === null || r.blocking === undefined ? null : r.blocking === 1,
    allowText: r.allowText === 1,
    options: json(r.options, [] as unknown[]),
    discordMessageIds: json(r.discordMessageIds, [] as string[]),
    answer: json(r.answer, null as AskAnswer | null),
    extra: json(r.extra, {} as Record<string, unknown>),
    bind: json(r.bind, null as AskBind | null),
  };
}

export function hasAsksTable(db: Database): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'asks'").get();
}

function tx<T>(db: Database, fn: () => T): T {
  return busyAsLedgerError("写 ask", () => db.transaction(fn).immediate());
}

function addEvent(db: Database, a: Ask, kind: EventKind, actor: string, text: string, data: Record<string, unknown>, now: number): void {
  db.prepare("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(now, actor, a.project, a.taskId ?? "", kind, text, JSON.stringify({ askId: a.id, ...data }));
}

function newAskId(): string {
  return `ask_${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function getAsk(db: Database, id: string): Ask | null {
  const r = db.query("SELECT * FROM asks WHERE id = ?").get(id) as Row | null;
  return r ? toAsk(r) : null;
}

/** openAsk 的完整结果：existed = 撞了去重键、返回的是已有那条（没写库）；superseded = 被这条取代的旧 ask */
export interface OpenedAsk {
  ask: Ask;
  existed: boolean;
  superseded: Ask[];
}

/**
 * 开一条 ask，同一事务里追加 ask 事件（actor = 发起 agent，人 / 系统发起的记 createdBy）。
 * 带 dedupKey 且撞上已有的：返回那条、不写库（T28a 的指派按轮次去重，重复触发无害）。
 * 带 askKey 且有发起 agent：它同 key 还开着的旧 ask 记 superseded（supersedeIn），新的 supersedes 指向最近那条。
 * deferSupersede：先只记指向、不动旧的——reply 路径投递成功后才调 supersedeOlder，发失败时旧的仍然有效（不会两条都失效）
 */
export function openAskFull(db: Database, input: NewAsk, now = Date.now(), opts: { deferSupersede?: boolean } = {}): OpenedAsk {
  const id = newAskId();
  return tx(db, (): OpenedAsk => {
    if (input.dedupKey) {
      const hit = db.query("SELECT * FROM asks WHERE dedupKey = ?").get(input.dedupKey) as Row | null;
      if (hit) return { ask: toAsk(hit), existed: true, superseded: [] };
    }
    const old = input.askKey && input.fromAgent
      ? listAsks(db, { fromAgent: input.fromAgent, states: ["open"] }).filter((x) => x.askKey === input.askKey)
      : [];
    db.prepare(`INSERT INTO asks (id, project, itemId, taskId, fromAgent, fromChannelId, source, kind, blocking, urgency, title, context, body,
      options, allowText, kindHint, chatId, threadId, expiresAt, state, extra, createdAt, updatedAt, assignee, createdBy, askKey, bind, supersedes, dedupKey)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.project, input.itemId ?? null, input.taskId ?? null, input.fromAgent ?? null, input.fromChannelId ?? null, input.source, input.kind,
      input.blocking === undefined || input.blocking === null ? null : input.blocking ? 1 : 0, input.urgency ?? "normal",
      input.title, input.context ?? "", input.body ?? "", JSON.stringify(input.options ?? []), input.allowText === false ? 0 : 1,
      input.kindHint ?? null, input.chatId ?? "", input.threadId ?? null, input.expiresAt ?? now + ASK_TTL_MS[input.kind],
      JSON.stringify(input.extra ?? {}), now, now, input.assignee ?? null, input.createdBy ?? null, input.askKey ?? null,
      input.bind ? JSON.stringify(input.bind) : null, old.at(-1)?.id ?? null, input.dedupKey ?? null,
    );
    const a = getAsk(db, id) as Ask;
    const superseded = opts.deferSupersede ? [] : supersedeIn(db, a, now);
    const data = { source: a.source, kind: a.kind, blocking: a.blocking, ...(a.assignee ? { assignee: a.assignee } : {}), ...(a.dedupKey ? { dedupKey: a.dedupKey } : {}) };
    addEvent(db, a, "ask", askActor(a), a.title, data, now);
    return { ask: a, existed: false, superseded };
  });
}

/** a 同一个 agent、同一个 key、比它早还开着的 → superseded（ask_cancel 事件，data.supersededBy） */
function supersedeIn(db: Database, a: Ask, now: number): Ask[] {
  if (!a.askKey || !a.fromAgent) return [];
  const old = listAsks(db, { fromAgent: a.fromAgent, states: ["open"] }).filter((x) => x.askKey === a.askKey && x.id !== a.id && x.createdAt <= a.createdAt);
  return old.map((o) => {
    const out = setState(db, o.id, "superseded", now);
    addEvent(db, out, "ask_cancel", askActor(out), o.title, { reason: "superseded", supersededBy: a.id }, now);
    return out;
  });
}

export function supersedeOlder(db: Database, a: Ask, now = Date.now()): Ask[] {
  return tx(db, () => supersedeIn(db, a, now));
}

export function openAsk(db: Database, input: NewAsk, now = Date.now()): Ask {
  return openAskFull(db, input, now).ask;
}

/** 事件的 actor：发起 agent；人 / 系统发起的记 createdBy */
const askActor = (a: Ask): string => a.fromAgent ?? a.createdBy ?? "system";

/** 已结案 → conflict，current 带上库里的状态与答案（调用方据此回「已处理」） */
function closedError(a: Ask): LedgerError {
  const word = a.state === "answered" ? "处理" : a.state === "expired" ? "过期" : a.state === "superseded" ? "被新版本取代" : "撤销";
  return new LedgerError("conflict", `ask ${a.id} 已${word}`, { state: a.state, answer: a.answer });
}

function setState(db: Database, id: string, state: AskState, now: number, answer?: AskAnswer): Ask {
  db.prepare("UPDATE asks SET state = ?, answer = COALESCE(?, answer), updatedAt = ? WHERE id = ?").run(state, answer ? JSON.stringify(answer) : null, now, id);
  return getAsk(db, id) as Ask;
}

function expireRow(db: Database, a: Ask, now: number): Ask {
  const out = setState(db, a.id, "expired", now);
  addEvent(db, out, "ask_expire", "bridge", a.title, {}, now);
  return out;
}

type AnswerOutcome = { ask: Ask; err?: "closed" | "expired_now" | "dup" };

/** reply 类（和人 / 系统发起、带按钮行的）逐行作答：并进已有的部分答案；这组答过了 → dup；所有组都答完（或卡片一次提交 / 只写了话）才算结案 */
function mergeAnswer(a: Ask, next: AskAnswer): { merged: AskAnswer; done: boolean } | null {
  if (a.source === "auq" || a.source === "permission" || a.source === "codex") return { merged: next, done: true };
  const rows = a.options as AskRow[];
  const groupOf = (w: string) => matchWire(rows, w)?.group ?? w;
  const prev = a.answer;
  const had = new Set((prev?.choices ?? []).map(groupOf));
  if (next.choices.some((w) => had.has(groupOf(w)))) return null;
  const merged: AskAnswer = {
    ...next,
    choices: [...(prev?.choices ?? []), ...next.choices],
    labels: [...(prev?.labels ?? []), ...next.labels],
    text: [prev?.text, next.text].filter(Boolean).join("\n"),
  };
  const got = new Set(merged.choices.map(groupOf));
  return { merged, done: !!next.final || next.choices.length === 0 || answerGroups(rows).every((g) => got.has(g)) };
}

/**
 * 作答，同一事务里追加 decision 事件（actor = 作答的凭据 / Discord 用户，取不到记 unknown；data 带原话与所选）。多行 reply 逐行点时先记部分答案、仍 open，都答完才 answered。
 * 已结案 / 这组答过（current.dup）→ conflict；到点还没扫成 expired 的先记 expired（事务照常提交，在事务里抛错会回滚）再报 conflict（current.expiredNow，调用方补发过期通知）。
 * within：结案那一笔同一事务里顺带写的（T28a 指派写交付），抛错整笔回滚、答案不落库。
 * 指派事项、或作答的不是 owner 本人（answer.external）：decision 的 text 只写选了哪项，原话只在 data.ownerWords、标 external。
 */
export function answerAsk(db: Database, id: string, answer: AskAnswer, within?: () => void): Ask {
  const r = tx(db, (): AnswerOutcome => {
    const a = getAsk(db, id);
    if (!a) throw new LedgerError("not_found", `ask ${id} 不存在`);
    if (a.state === "open" && a.expiresAt <= answer.at) return { ask: expireRow(db, a, answer.at), err: "expired_now" };
    if (a.state !== "open") return { ask: a, err: "closed" };
    const m = mergeAnswer(a, answer);
    if (!m) return { ask: a, err: "dup" };
    const out = setState(db, id, m.done ? "answered" : "open", answer.at, m.merged);
    const external = a.kind === "assigned" || answer.external === true;
    const said = [answer.labels.join("；"), answer.text && !external ? `「${answer.text}」` : ""].filter(Boolean).join(" ");
    const data = { via: answer.via, choices: answer.choices, labels: answer.labels, ownerWords: answer.text, principal: answer.principal, partial: !m.done, ...(external ? { external } : {}) };
    addEvent(db, out, "decision", answer.principal || "unknown", said || out.title, data, answer.at);
    if (m.done) within?.();
    return { ask: out };
  });
  if (r.err === "dup") throw new LedgerError("conflict", `ask ${id} 这一项已经答过了`, { state: r.ask.state, answer: r.ask.answer, dup: true });
  if (r.err === "expired_now") throw new LedgerError("conflict", `ask ${id} 已过期`, { state: "expired", answer: r.ask.answer, expiredNow: true });
  if (r.err) throw closedError(r.ask);
  return r.ask;
}

/**
 * open → expired / cancelled；已不是 open 的返回 null（重复触发无害）。extra 与撤销同一事务并进 ask 的 extra（owner 删卡记 dismissed：
 * 分两笔写的话中间崩了，重启后这条就认不出是删过的，又冒出来），也记进 ask_cancel 事件
 */
export function closeAsk(db: Database, id: string, state: "expired" | "cancelled", reason = "", now = Date.now(), extra?: Record<string, unknown>): Ask | null {
  return tx(db, () => {
    const a = getAsk(db, id);
    if (!a || a.state !== "open") return null;
    if (state === "expired") return expireRow(db, a, now);
    if (extra) db.prepare("UPDATE asks SET extra = ? WHERE id = ?").run(JSON.stringify({ ...a.extra, ...extra }), id);
    const out = setState(db, id, "cancelled", now);
    addEvent(db, out, "ask_cancel", "bridge", reason || a.title, { reason, ...(extra ? { extra } : {}) }, now);
    return out;
  });
}

/**
 * 答复没送到（押着等目标空闲时收件的 agent 被 kill 了）：已答 / 答了一部分 → 回到 open、清掉答案，owner 再答一次时重新找收件方。
 * 到期时间至少再给 REOPEN_MS，否则过期扫描会马上把它结掉。没答过的、已结成别的状态的返回 null。
 */
export function reopenAsk(db: Database, id: string, reason: string, now = Date.now()): Ask | null {
  return tx(db, () => {
    const a = getAsk(db, id);
    if (!a || !a.answer || (a.state !== "answered" && a.state !== "open")) return null;
    db.prepare("UPDATE asks SET state = 'open', answer = NULL, outboxMessageId = NULL, expiresAt = MAX(expiresAt, ?), updatedAt = ? WHERE id = ?")
      .run(now + REOPEN_MS, now, id);
    const out = getAsk(db, id) as Ask;
    addEvent(db, out, "ask_reopen", "bridge", reason, { reason }, now);
    return out;
  });
}
const REOPEN_MS = 24 * 3_600_000;

/** 投递信息补记（Discord 消息 id、答复消息 id、改投记录）：不改状态、不记事件 */
export function patchAsk(db: Database, id: string, p: { discordMessageIds?: string[]; outboxMessageId?: string; extra?: Record<string, unknown> }, now = Date.now()): void {
  tx(db, () => {
    const a = getAsk(db, id);
    if (!a) return;
    db.prepare("UPDATE asks SET discordMessageIds = ?, outboxMessageId = ?, extra = ?, updatedAt = ? WHERE id = ?").run(
      JSON.stringify(p.discordMessageIds ?? a.discordMessageIds), p.outboxMessageId ?? a.outboxMessageId,
      JSON.stringify({ ...a.extra, ...p.extra }), now, id,
    );
  });
}

export interface AskQuery {
  project?: string;
  states?: AskState[];
  fromAgent?: string;
  source?: AskSource;
  /** 给数组 = 其中任一（合并过设备的人名下有多个 person id） */
  assignee?: string | readonly string[];
  /** 已结案的只要 updatedAt 晚于它的（「最近处理过」） */
  closedSince?: number;
  limit?: number;
}

/** open 的按 createdAt 升序（等得最久的在前），其余按 updatedAt 降序 */
export function listAsks(db: Database, q: AskQuery = {}): Ask[] {
  const conds: string[] = [];
  const args: (string | number)[] = [];
  const add = (sql: string, ...v: (string | number)[]) => {
    conds.push(sql);
    args.push(...v);
  };
  if (q.project !== undefined) add("project = ?", q.project);
  if (q.fromAgent !== undefined) add("fromAgent = ?", q.fromAgent);
  if (q.source !== undefined) add("source = ?", q.source);
  if (q.assignee !== undefined) {
    const who = typeof q.assignee === "string" ? [q.assignee] : q.assignee;
    add(`assignee IN (${who.map(() => "?").join(",") || "NULL"})`, ...who);
  }
  if (q.states?.length) add(`state IN (${q.states.map(() => "?").join(",")})`, ...q.states);
  if (q.closedSince !== undefined) add("(state = 'open' OR updatedAt > ?)", q.closedSince);
  const sql = `SELECT * FROM asks${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}
    ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, CASE state WHEN 'open' THEN createdAt ELSE -updatedAt END${q.limit ? " LIMIT ?" : ""}`;
  if (q.limit) args.push(q.limit);
  return (db.query(sql).all(...args) as Row[]).map(toAsk);
}

/** Discord 交互按原消息 id 找 ask（一条 reply 分块发成多条消息时，任何一条都认） */
export function findAskByDiscordMessage(db: Database, messageId: string): Ask | null {
  const r = db.query("SELECT a.* FROM asks a, json_each(a.discordMessageIds) j WHERE j.value = ? ORDER BY a.createdAt DESC LIMIT 1").get(messageId) as Row | null;
  return r ? toAsk(r) : null;
}

/** 到期还开着的（每分钟扫一次） */
export function dueAsks(db: Database, now = Date.now()): Ask[] {
  return (db.query("SELECT * FROM asks WHERE state = 'open' AND expiresAt <= ?").all(now) as Row[]).map(toAsk);
}
