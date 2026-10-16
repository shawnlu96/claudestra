/**
 * RESTATEGO1 · delivery confirmation for author orders sent over the channel. A "done" dispatch intent is only a transport
 * receipt: the line can land in a session that never starts the turn (a draft left in the input box, a restart in between).
 * The delivery key is the intent id; the target session is the intent's recipient + bound session; the send time is when the
 * intent settled done, or the latest resend. Confirmed = the worker took the order (ledger), or its session shows a user
 * record carrying the key followed by an assistant record (the turn started). Unconfirmed past CONFIRM_TIMEOUT_MS → resend
 * the same order under the same key through the channel (never tmux typing), at most MAX_RESENDS times; past that one PM todo.
 * Every resend / escalation is a dedup'd ledger note written before the effect, so a crash costs one attempt, never a loop.
 * Recovery key startDeliveryConfirm: off = nothing here runs; observe = notes only. tests/worker-submit-confirm.test.ts.
 */
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import { orderTakenSeq } from "./order-mark.js";
import type { PmNoticeLevel } from "./pm-notice-level.js";
import { observeDedupKey, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { readRegistryAgents } from "./registry.js";
import { sessionJsonlPath } from "./session-source.js";
import { stepOfNode, workOrderFor } from "./scheduler-work-order.js";
import { sentAsWake, type SessionRef, type WorkerObservation, type WorkerSession } from "./worker-session.js";

export const START_DELIVERY_KEY = "startDeliveryConfirm";
/** Below UNCLAIMED_ALARM_MS (10 min): the first resend goes out before PM hears that nobody took the order. */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;
export const MAX_RESENDS = 2;
/** How far back the session file is read for the key; an order older than this tail is not resent on guesswork. */
const SESSION_TAIL_BYTES = 8 * 1024 * 1024;

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface ConfirmCard {
  db: Database;
  task: LedgerTask;
  deps: { manager: Manager; now(): number; notifyPm(task: LedgerTask, text: string, level: PmNoticeLevel): Promise<void>; recoveryPolicy?: RecoveryPolicyPort };
}
/** The session file's text, or null when it cannot be read (no registry row, a different session, no file). */
export type SessionText = (agent: string, sessionId: string) => Promise<string | null>;

export interface DeliveryFacts {
  sentAt: number;
  /** send times of the resends already recorded, oldest first */
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
    if (!seen) { seen = rec.type === "user" && contentText(rec.message?.content).includes(key); continue; }
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

const resendKey = (id: string, n: number) => `resend:${id}:${n}`, escalateKey = (id: string) => `escalate:${id}`;
type Where = Pick<ConfirmCard, "db" | "task">;
const recorded = (c: Where, actionKey: string) =>
  getEventByDedup(c.db, observeDedupKey({ project: c.task.project, mechanism: START_DELIVERY_KEY, target: c.task.id, actionKey }));

/** The delivery's ledger facts: resends and the escalation are notes keyed by the delivery key. */
export function deliveryFacts(c: Where, sent: SchedulerIntent, confirmed: boolean): DeliveryFacts {
  const resends: number[] = [];
  for (let n = 1; n <= MAX_RESENDS; n++) {
    const e = recorded(c, resendKey(sent.id, n)) ?? recorded(c, `would-${resendKey(sent.id, n)}`);
    if (!e) break;
    resends.push(typeof e.data.sentAt === "number" ? e.data.sentAt : e.ts);
  }
  return { sentAt: sent.updatedAt, resends, confirmed, escalated: !!(recorded(c, escalateKey(sent.id)) ?? recorded(c, `would-${escalateKey(sent.id)}`)) };
}

async function note(c: ConfirmCard, actionKey: string, action: string, data: Record<string, unknown>): Promise<boolean> {
  const r = await c.deps.manager("ledger", "scheduler-recovery-observe", c.task.id, "--mechanism", START_DELIVERY_KEY, "--action-key", actionKey,
    "--action", action, "--data", JSON.stringify(data));
  if (r.ok !== true) console.error(`⚠️ [scheduler] ${c.task.id} 投递确认记录没写上（下轮重试）：${String(r.error)}`);
  return r.ok === true && r.recorded !== false;
}

/** Delivery keys whose turn was seen starting, per ledger: a confirmed key stays confirmed, so its session file is not read again. */
const confirmedKeys = new WeakMap<Database, Set<string>>();
const confirmedIn = (db: Database): Set<string> => confirmedKeys.get(db) ?? confirmedKeys.set(db, new Set()).get(db)!;

/** Only author orders over the channel; a wake line or a restate carries no plan-only content, so the same order rebuilds. */
const resendable = (sent: SchedulerIntent, w: WorkerSession) => w.route === "channel" && sent.action === "dispatch"
  && (sentAsWake(sent.receipt) || stepOfNode(sent.node) === "restate");

/**
 * The tick's hook for a sent author order still in flight (Card.watch, before the unclaimed alarm). null = nothing to say,
 * the caller goes on as before; otherwise the step's outcome. Never throws for a send failure: the next pass decides again.
 */
export async function confirmStart(c: ConfirmCard, sent: SchedulerIntent, ref: SessionRef, w: WorkerSession, seen: WorkerObservation,
  read: SessionText = readSessionText): Promise<[string, string] | null> {
  const mode = (c.deps.recoveryPolicy ?? recoveryPolicy)(c.task.project, START_DELIVERY_KEY).mode;
  if (mode === "off" || !resendable(sent, w) || seen.state === "result") return null;
  if (orderTakenSeq(c.db, sent.id) !== null || confirmedIn(c.db).has(sent.id)) return null;
  // the ledger decides first: the session file (up to 8 MB) is read only when a resend / escalation is actually due
  const d = confirmDecision(deliveryFacts(c, sent, false), c.deps.now());
  if (d.kind === "confirmed" || d.kind === "wait" || d.kind === "escalated") return null; // escalated: PM has the todo, the watch goes on as before
  const text = await read(ref.agent, ref.sessionId);
  if (text === null) return null; // cannot tell whether the turn started: no resend on guesswork
  if (turnStartedFor(text, sent.id)) { confirmedIn(c.db).add(sent.id); return null; }
  const would = mode === "observe" ? "would-" : "";
  if (d.kind === "escalate") {
    const todo = `[调度引擎] ${c.task.id} 的开工单 ${sent.id} 已发给 ${ref.agent}（会话 ${ref.sessionId}），重投 ${MAX_RESENDS} 次后执行者仍没开始对应回合：` +
      "看会话是否卡在输入框 / 等确认，必要时 workflow-set --mode manual 接手";
    if (!would) { // the todo first (its own dedup key), then the note that ends the escalation: a lost note only repeats a no-op todo write
      const r = await c.deps.manager("ledger", "scheduler-pm-todo", c.task.id, "--kind", "start_delivery_unconfirmed", "--text", todo, "--dedup", `start-confirm:${sent.id}`);
      if (r.ok !== true) return ["held", `开工单未确认的 PM 待办没写上（下轮重试）：${String(r.error)}`];
    }
    if (!(await note(c, `${would}${escalateKey(sent.id)}`, `升级 PM：开工单重投 ${MAX_RESENDS} 次未确认`, { intentId: sent.id, agent: ref.agent })) && !would) {
      return ["held", "PM 待办已写，升级记录没记上（下轮补记）"];
    }
    if (would) return null; // observe: the note is the whole effect
    return ["held", `开工单 ${sent.id} 重投 ${MAX_RESENDS} 次仍未开始，已升级 PM 待办`];
  }
  const now = c.deps.now();
  if (!(await note(c, `${would}${resendKey(sent.id, d.attempt)}`, `重投开工单第 ${d.attempt} 次（${ref.agent} 未开始对应回合）`,
    { intentId: sent.id, attempt: d.attempt, agent: ref.agent, session: ref.sessionId, sentAt: now }))) return ["held", "重投记录没写上，下轮重试"];
  if (would) return null;
  const order = workOrderFor(c.task, sent, null, ref, undefined, c.db);
  if (!order) return ["held", `节点 ${sent.node} 没有任务单，不重投`];
  const delivery = sentAsWake(sent.receipt) ? { mode: "wake" as const } : { mode: "text" as const, reason: "重投复述单（同一投递键）" };
  const r = await w.submit(ref, sent.id, { ...order, delivery });
  return ["resent", `开工单 ${sent.id} 第 ${d.attempt} 次重投：${r.status === "sent" ? "已送出" : `${r.status}：${r.reason}`}`];
}

/**
 * One line on the card's start order for the audit (ledger-audit-snapshot.ts executorIdleNote): read-only, ledger facts only
 * (the session read stays with the tick). null = the order was taken, nothing to add.
 */
export function startDeliveryState(db: Database, task: LedgerTask, now: number): string | null {
  const node = task.stage === "fix" ? "fix" : "write";
  const last = db.query(`SELECT * FROM scheduler_intents WHERE taskId = ? AND node = ? AND action = 'dispatch' AND specRev = ?
    ORDER BY eventSeq DESC LIMIT 1`).get(task.id, node, task.specRev) as SchedulerIntent | null;
  if (!last) return `本 specRev 还没有 ${node} 开工单的派单记录`;
  if (last.status !== "done") return `开工单 ${last.id} 状态 ${last.status}${last.receipt ? `（${last.receipt.slice(0, 120)}）` : ""}`;
  if (orderTakenSeq(db, last.id) !== null) return null;
  const f = deliveryFacts({ db, task }, last, false), d = confirmDecision(f, now);
  return `开工单 ${last.id} 发出 ${Math.floor((now - last.updatedAt) / 60_000)} 分钟未确认，已重投 ${f.resends.length}/${MAX_RESENDS} 次` +
    (f.escalated ? "，已升级 PM 待办" : d.kind === "wait" ? "" : "，调度器下一轮处理");
}
