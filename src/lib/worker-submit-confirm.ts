/**
 * RESTATEGO1 · delivery confirmation for author orders sent over the channel. A "done" dispatch intent is only a transport
 * receipt: the line can land in a session that never starts the turn (a draft left in the input box, a restart in between).
 * The delivery key is the first intent's id; the target session is the intent's recipient + bound session; the send time is
 * when it settled done. Confirmed = the worker took any attempt's order (ledger), or its session shows a user record carrying
 * the key followed by an assistant record (the turn started). Unconfirmed past CONFIRM_TIMEOUT_MS → one more attempt, at most
 * MAX_RESENDS, then one PM todo (a center replica, whose notes and todo S2Q holds as v2_unmapped: the same text as a PM notice).
 * An attempt is a new dispatch intent `<key>.r<n>` through the card's own formal steps (Card.plan = `ledger scheduler-plan`,
 * Card.work = claim → send), never a second submit of the done intent: on a center replica that intent's X8 journal replays
 * (nothing is sent) and the center has settled it, so only a new intent gets its own intent.create / authorization / lease /
 * route checks. Its order carries the key, so take_order and the session match find any attempt. The attempt intents are the
 * budget (planned = used, whatever its receipt), so a restart or a crash never adds one.
 * Recovery key startDeliveryConfirm: off = nothing here runs; observe = would-notes only, on their own count and escalation
 * state, never read by on. tests/worker-submit-confirm.test.ts.
 */
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { orderTakenSeq } from "./order-mark.js";
import type { PmNoticeLevel } from "./pm-notice-level.js";
import { observeDedupKey, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readRegistryAgents } from "./registry.js";
import { sessionJsonlPath } from "./session-source.js";
import { stepOfNode } from "./scheduler-work-order.js";
import { sentAsWake, type SessionRef, type WorkerObservation, type WorkerSession } from "./worker-session.js";

export const START_DELIVERY_KEY = "startDeliveryConfirm";
/** Below UNCLAIMED_ALARM_MS (10 min): the first resend goes out before PM hears that nobody took the order. */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;
export const MAX_RESENDS = 2;
/** How far back the session file is read for the key; an order older than this tail is not resent on guesswork. */
const SESSION_TAIL_BYTES = 8 * 1024 * 1024;

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
/** The session file's text, or null when it cannot be read (no registry row, a different session, no file). */
export type SessionText = (agent: string, sessionId: string) => Promise<string | null>;
/** A planner intent (scheduler-plan.ts PlannedIntent) for the attempt: the fields Card.plan writes, nothing plan-only. */
export interface ResendPlan { kind: "intent"; id: string; node: string; action: "dispatch"; recipient: string | null; resources: string[]; reason: string; observedOnly: false }
/** The tick's Card: its ledger, task, ports and the two formal steps an attempt goes through. */
export interface ConfirmCard {
  db: Database;
  task: LedgerTask;
  deps: { manager: Manager; now(): number; notifyPm(task: LedgerTask, text: string, level: PmNoticeLevel): Promise<void>;
    recoveryPolicy?: RecoveryPolicyPort; sessionText?: SessionText };
  plan(p: ResendPlan): Promise<SchedulerIntent | { code: string; error: string }>;
  work(intent: SchedulerIntent, plan: null): Promise<{ step: string; detail: string }>;
}

export interface DeliveryFacts {
  sentAt: number;
  /** times of the attempts already used, oldest first */
  resends: number[];
  confirmed: boolean;
  escalated: boolean;
}
export type ConfirmDecision =
  | { kind: "confirmed" }
  | { kind: "wait"; leftMs: number }
  | { kind: "resend"; attempt: number }
  | { kind: "escalate" }
  | { kind: "escalated" };

/** Pure: what the delivery needs now. Confirmation always wins, so a confirmed key is never resent. */
export function confirmDecision(f: DeliveryFacts, now: number, timeoutMs = CONFIRM_TIMEOUT_MS, max = MAX_RESENDS): ConfirmDecision {
  if (f.confirmed) return { kind: "confirmed" };
  const last = Math.max(f.sentAt, ...f.resends);
  if (now - last < timeoutMs) return { kind: "wait", leftMs: timeoutMs - (now - last) };
  if (f.resends.length < max) return { kind: "resend", attempt: f.resends.length + 1 };
  return f.escalated ? { kind: "escalated" } : { kind: "escalate" };
}

const ATTEMPT_RE = /^(.+)\.r(\d+)$/;
/** The delivery key of an intent: an attempt `<key>.r<n>` belongs to its first intent's key. */
export const deliveryKey = (intentId: string): string => ATTEMPT_RE.exec(intentId)?.[1] ?? intentId;
export const attemptId = (key: string, n: number): string => `${key}.r${n}`;
/** One intent row, read-only (kept off ledger-scheduler.js so the pass graph scan stays as it was). */
const intentRow = (db: Database, id: string) => db.query("SELECT * FROM scheduler_intents WHERE id = ?").get(id) as SchedulerIntent | null;

/** The key as a whole id in the text: `…:a1` matches `…:a1` and `…:a1.r2`, never `…:a10`. */
function carriesKey(text: string, key: string): boolean {
  for (let i = text.indexOf(key); i >= 0; i = text.indexOf(key, i + 1)) {
    if (!/[\w:-]/.test(text[i + key.length] ?? "")) return true;
  }
  return false;
}

const NO_RESPONSE_RE = /^\s*No response requested\.?\s*$/;
const contentText = (c: unknown): string => typeof c === "string" ? c
  : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("") : "";

/**
 * True when a user record carrying `key` (the channel line) is followed by an assistant record that is not the restart
 * filler: the turn for this order started. A line merely typed into the input box never reaches the file.
 */
export function turnStartedFor(text: string, key: string): boolean {
  let seen = false;
  for (const line of text.split("\n")) {
    if (!seen && !line.includes(key)) continue;
    let rec: { type?: string; message?: { content?: unknown } };
    try { rec = JSON.parse(line); } catch { continue; } // a cut first line of the tail, or a partial last write
    if (!seen) { seen = rec.type === "user" && carriesKey(contentText(rec.message?.content), key); continue; }
    if (rec.type === "assistant" && !NO_RESPONSE_RE.test(contentText(rec.message?.content))) return true;
  }
  return false;
}

/** The registry's row for the agent must still name the bound session; the file tail is read as text. */
export const readSessionText: SessionText = async (agent, sessionId) => {
  const row = (await readRegistryAgents()).find((a) => a.name === agent);
  if (!row?.cwd || row.sessionId !== sessionId) return null;
  const path = sessionJsonlPath(row.runtime, row.cwd, sessionId);
  if (!path) return null;
  try {
    const size = statSync(path).size;
    return await Bun.file(path).slice(Math.max(0, size - SESSION_TAIL_BYTES), size).text();
  } catch {
    return null; // no file yet / moved away: confirmation unknown, so nothing is resent on it
  }
};

/** The attempts planned for a key, by number: rows of the ledger, so they survive a restart and count once each. */
export function attemptsOf(db: Database, taskId: string, key: string): SchedulerIntent[] {
  const prefix = `${key}.r`;
  return (db.query("SELECT * FROM scheduler_intents WHERE taskId = ? AND substr(id, 1, ?) = ?").all(taskId, prefix.length, prefix) as SchedulerIntent[])
    .filter((i) => ATTEMPT_RE.exec(i.id)?.[1] === key)
    .sort((a, b) => Number(ATTEMPT_RE.exec(a.id)![2]) - Number(ATTEMPT_RE.exec(b.id)![2]));
}

const resendKey = (key: string, n: number) => `resend:${key}:${n}`, escalateKey = (key: string) => `escalate:${key}`;
type Where = Pick<ConfirmCard, "db" | "task">;
const recorded = (c: Where, actionKey: string) =>
  getEventByDedup(c.db, observeDedupKey({ project: c.task.project, mechanism: START_DELIVERY_KEY, target: c.task.id, actionKey }));

/**
 * This process's memory per ledger, for what the ledger may not hold: on a center replica S2Q holds this mechanism's
 * notes and PM todo (v2_unmapped), so they are best-effort there and never a precondition. confirmed: keys whose turn was
 * seen starting (the session file is not read again); sentAt: attempt → this machine's send time; actions: action keys done
 * (observe notes, the escalation) even when their note was held, so a held note is not retried every pass.
 */
interface Memory { confirmed: Set<string>; sentAt: Map<string, number>; actions: Set<string> }
const memories = new WeakMap<Database, Memory>();
const memoryOf = (db: Database): Memory => memories.get(db) ?? memories.set(db, { confirmed: new Set(), sentAt: new Map(), actions: new Set() }).get(db)!;
const done = (c: Where, actionKey: string) => memoryOf(c.db).actions.has(actionKey) || !!recorded(c, actionKey);

/**
 * The delivery's facts under one mode. on: the attempt intents (each planned one counts) and the real escalation. observe:
 * its would-notes only. Neither reads the other's records, so an observe run never uses up on's attempts or stands in for its PM todo.
 */
export function deliveryFacts(c: Where, first: SchedulerIntent, confirmed: boolean, mode: Exclude<RecoveryMode, "off"> = "on"): DeliveryFacts {
  const resends: number[] = [], mem = memoryOf(c.db);
  if (mode === "on") for (const a of attemptsOf(c.db, c.task.id, first.id)) {
    // this machine's send time (memory, else the attempt's note); a projected intent's updatedAt is the center's clock
    const at = mem.sentAt.get(a.id) ?? recorded(c, resendKey(first.id, Number(ATTEMPT_RE.exec(a.id)![2])))?.data.sentAt;
    resends.push(typeof at === "number" ? Math.max(at, a.updatedAt) : a.updatedAt);
  } else for (let n = 1; n <= MAX_RESENDS; n++) {
    const k = `would-${resendKey(first.id, n)}`, e = recorded(c, k);
    if (!e && !mem.actions.has(k)) break;
    const at = e?.data.sentAt ?? mem.sentAt.get(k);
    resends.push(typeof at === "number" ? at : e?.ts ?? first.updatedAt);
  }
  return { sentAt: first.updatedAt, resends, confirmed, escalated: done(c, `${mode === "on" ? "" : "would-"}${escalateKey(first.id)}`) };
}

/** One recovery note (a replay of the same key is ok); false = not recorded (held on a center replica, or a ledger error). */
async function note(c: ConfirmCard, actionKey: string, action: string, data: Record<string, unknown>): Promise<boolean> {
  const r = await c.deps.manager("ledger", "scheduler-recovery-observe", c.task.id, "--mechanism", START_DELIVERY_KEY, "--action-key", actionKey,
    "--action", action, "--data", JSON.stringify(data));
  if (r.ok !== true && r.code !== "v2_unmapped") console.error(`⚠️ [scheduler] ${c.task.id} 投递确认记录没写上：${String(r.error ?? r.code)}`);
  return r.ok === true;
}

/** Only author orders over the channel; a wake line or a restate carries no plan-only content, so the same order rebuilds. */
const resendable = (first: SchedulerIntent, w: WorkerSession) => w.route === "channel" && first.action === "dispatch"
  && (sentAsWake(first.receipt) || stepOfNode(first.node) === "restate");
const taken = (db: Database, ids: readonly string[]) => ids.some((id) => orderTakenSeq(db, id) !== null);
const attemptList = (key: string, attempts: readonly SchedulerIntent[]) =>
  attempts.map((a) => `${a.id.slice(key.length + 1)} ${a.status}`).join("、");

/** The PM todo; on a center replica (held: v2_unmapped) the same text goes to PM as a notice instead. */
async function escalate(c: ConfirmCard, key: string, todo: string): Promise<string | null> {
  const r = await c.deps.manager("ledger", "scheduler-pm-todo", c.task.id, "--kind", "start_delivery_unconfirmed", "--text", todo, "--dedup", `start-confirm:${key}`);
  if (r.ok === true) return null;
  if (r.code !== "v2_unmapped") return `开工单未确认的 PM 待办没写上（下轮重试）：${String(r.error ?? r.code)}`;
  try { await c.deps.notifyPm(c.task, todo, "action"); } // 开工单重投后仍未开始：要 PM 看会话
  catch (e) { return `中心副本卡写不了台账待办，PM 通知也没发出去（下轮重试）：${String((e as Error)?.message ?? e)}`; }
  return null;
}

/**
 * The tick's hook for a sent author order still in flight (Card.watch, before the unclaimed alarm). `sent` is the latest done
 * dispatch: the first intent or one of its attempts. null = nothing to say, the caller goes on as before; otherwise the step's
 * outcome. Never throws for a send failure: the next pass decides again.
 */
export async function confirmStart(c: ConfirmCard, sent: SchedulerIntent, ref: SessionRef, w: WorkerSession, seen: WorkerObservation): Promise<[string, string] | null> {
  const mode = (c.deps.recoveryPolicy ?? recoveryPolicy)(c.task.project, START_DELIVERY_KEY).mode;
  if (mode === "off" || seen.state === "result") return null;
  const first = intentRow(c.db, deliveryKey(sent.id));
  if (!first || first.taskId !== c.task.id || !resendable(first, w)) return null;
  const key = first.id, attempts = attemptsOf(c.db, c.task.id, key), mem = memoryOf(c.db);
  if (taken(c.db, [key, ...attempts.map((a) => a.id)]) || mem.confirmed.has(key)) return null;
  // the ledger decides first: the session file (up to 8 MB) is read only when a resend / escalation is actually due
  const d = confirmDecision(deliveryFacts(c, first, false, mode), c.deps.now());
  if (d.kind === "confirmed" || d.kind === "wait" || d.kind === "escalated") return null; // escalated: PM has the todo, the watch goes on as before
  const text = await (c.deps.sessionText ?? readSessionText)(ref.agent, ref.sessionId);
  if (text === null) return null; // cannot tell whether the turn started: no resend on guesswork
  if (turnStartedFor(text, key)) { mem.confirmed.add(key); return null; }
  const now = c.deps.now(), where = { intentId: key, agent: ref.agent, session: ref.sessionId, sentAt: now };
  if (mode === "observe") { // the note is the whole effect, under its own key and count
    const [actionKey, action] = d.kind === "escalate" ? [`would-${escalateKey(key)}`, `升级 PM：开工单重投 ${MAX_RESENDS} 次未确认`]
      : [`would-${resendKey(key, d.attempt)}`, `重投开工单第 ${d.attempt} 次（${ref.agent} 未开始对应回合）`];
    mem.actions.add(actionKey);
    mem.sentAt.set(actionKey, now);
    await note(c, actionKey, action, { ...where, ...(d.kind === "resend" ? { attempt: d.attempt } : {}) });
    return null;
  }
  if (d.kind === "escalate") {
    const todo = `[调度引擎] ${c.task.id} 的开工单 ${key} 已发给 ${ref.agent}（会话 ${ref.sessionId}），重投 ${attempts.length} 次` +
      `（${attemptList(key, attempts)}）后执行者仍没开始对应回合：看会话是否卡在输入框 / 等确认，必要时 workflow-set --mode manual 接手`;
    // the todo first (its own dedup key), then the note that ends the escalation: a lost note only repeats a no-op todo write
    const failed = await escalate(c, key, todo);
    if (failed) return ["held", failed];
    mem.actions.add(escalateKey(key));
    await note(c, escalateKey(key), `升级 PM：开工单重投 ${attempts.length} 次未确认`, where);
    return ["held", `开工单 ${key} 重投 ${attempts.length} 次（${attemptList(key, attempts)}）仍未开始，已升级 PM 待办`];
  }
  // The attempt intent is the durable record, written before any effect (planIntent dedups its id): a crash after it costs this
  // attempt, never a second one. The note only adds target session and send time for the audit.
  const id = attemptId(key, d.attempt), resources = getEventByDedup(c.db, `scheduler:${key}`)?.data.resources;
  const planned = await c.plan({ kind: "intent", observedOnly: false, id, node: first.node, action: "dispatch", recipient: first.recipient,
    resources: Array.isArray(resources) ? resources.map(String) : [],
    reason: `重投开工单第 ${d.attempt} 次（投递键 ${key}；${ref.agent} 未开始对应回合）` });
  if ("code" in planned) { // nothing planned = no attempt used; the watch goes on (the unclaimed alarm still tells PM)
    console.warn(`⚠️ [scheduler] ${c.task.id} 开工单 ${key} 第 ${d.attempt} 次重投没进台账（下轮再试）：[${planned.code}] ${planned.error}`);
    return null;
  }
  mem.sentAt.set(id, now);
  await note(c, resendKey(key, d.attempt), `重投开工单第 ${d.attempt} 次（${ref.agent} 未开始对应回合）`, { ...where, attempt: d.attempt, attemptIntent: id });
  const out = await c.work(planned, null);
  return [out.step === "sent" ? "resent" : out.step, `开工单 ${key} 第 ${d.attempt} 次重投（${id}）：${out.step === "sent" ? "已送出" : out.detail || out.step}`];
}

/**
 * One line on the card's start order for the audit (ledger-audit-snapshot.ts executorIdleNote): read-only, ledger facts only
 * (the session read stays with the tick), the attempts as on counts them. null = the order was taken, nothing to add.
 */
export function startDeliveryState(db: Database, task: LedgerTask, now: number): string | null {
  const node = task.stage === "fix" ? "fix" : "write";
  const last = db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND node = ? AND action = 'dispatch' AND specRev = ?
    ORDER BY eventSeq DESC LIMIT 1`).get(task.id, node, task.specRev) as SchedulerIntent | null;
  if (!last) return `本 specRev 还没有 ${node} 开工单的派单记录`;
  const first = intentRow(db, deliveryKey(last.id)) ?? last;
  if (first.status !== "done") return `开工单 ${first.id} 状态 ${first.status}${first.receipt ? `（${first.receipt.slice(0, 120)}）` : ""}`;
  const attempts = attemptsOf(db, task.id, first.id);
  if (taken(db, [first.id, ...attempts.map((a) => a.id)])) return null;
  const f = deliveryFacts({ db, task }, first, false), d = confirmDecision(f, now);
  return `开工单 ${first.id} 发出 ${Math.floor((now - first.updatedAt) / 60_000)} 分钟未确认，已重投 ${f.resends.length}/${MAX_RESENDS} 次` +
    (attempts.length ? `（${attemptList(first.id, attempts)}）` : "") + (f.escalated ? "，已升级 PM 待办" : d.kind === "wait" ? "" : "，调度器下一轮处理");
}
