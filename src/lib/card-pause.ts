/**
 * UXPAUSE1 · card-level pause: while a card is paused the scheduler sends it no new action; resume picks up exactly where it was.
 * State = the card's last `card_pause` / `card_resume` decision event (no table, no `extra.frozen`). This file is the read side the
 * S2D2 skip gates ask (scheduler-v2-skip-card.ts / -pass.ts / -skip.ts), so it holds no write: the transactions are card-pause-write.ts.
 * Switch: recovery key `cardPause` — off / observe (default: the event is recorded but nothing is held; each would-be-held action is
 * one observe note per card + pause event + action) / on (held). tests/card-pause*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import { observeDedupKey, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";

export const CARD_PAUSE_KEY = "cardPause";
export const CARD_PAUSE_OP = "card_pause", CARD_RESUME_OP = "card_resume";
/** Stages a card may be paused in; merge and later are the merge queue's (PM pulls a card out of it instead). */
export const PAUSABLE_STAGES: readonly string[] = ["spec", "restate", "build", "review", "fix"];

export interface CardPauseState { paused: boolean; seq: number; actor: string; at: number; reason: string }

let policyPort: RecoveryPolicyPort = recoveryPolicy;
/** Tests inject a fake policy; null restores the file-backed one. */
export function configureCardPausePolicy(port: RecoveryPolicyPort | null): void { policyPort = port ?? recoveryPolicy; }

export const cardPauseMode = (project: string): RecoveryMode => policyPort(project, CARD_PAUSE_KEY).mode;

/** Missing table / column in an old or test ledger reads as "never paused". */
export function safe<T>(read: () => T, none: T): T {
  try { return read(); }
  catch (e) {
    if (/no such (table|column)/.test((e as Error).message)) return none;
    throw e;
  }
}

/** The card's last pause / resume decision (indexed on project + target), or null when it was never paused. */
export function cardPauseState(db: Database, taskId: string): CardPauseState | null {
  const row = safe(() => db.query(`SELECT e.seq, e.ts, e.actor, e.text, json_extract(e.data, '$.op') AS op FROM events AS e
    WHERE e.project = (SELECT project FROM tasks WHERE id = ?) AND e.target = ? AND e.kind = 'decision'
    AND json_extract(e.data, '$.op') IN ('${CARD_PAUSE_OP}', '${CARD_RESUME_OP}') ORDER BY e.seq DESC LIMIT 1`)
    .get(taskId, taskId) as { seq: number; ts: number; actor: string; text: string; op: string } | null, null);
  return row && { paused: row.op === CARD_PAUSE_OP, seq: row.seq, actor: row.actor, at: row.ts, reason: row.text };
}

/** Per connection: currently paused cards, read incrementally by event seq (events are append-only; a lower top = rolled back, re-read). */
const index = new WeakMap<Database, { seq: number; paused: Set<string> }>();

/** Cards whose last pause / resume decision is a pause, whatever the switch: a cheap "is anything paused at all" for the set-wide gates. */
export function pausedCardIds(db: Database): ReadonlySet<string> {
  return safe(() => {
    const top = (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number | null }).s ?? 0;
    let c = index.get(db);
    if (!c || top < c.seq) c = { seq: 0, paused: new Set() };
    if (top > c.seq) {
      const rows = db.query(`SELECT target, json_extract(data, '$.op') AS op FROM events WHERE seq > ? AND seq <= ? AND kind = 'decision'
        AND json_extract(data, '$.op') IN ('${CARD_PAUSE_OP}', '${CARD_RESUME_OP}') ORDER BY seq`).all(c.seq, top) as { target: string; op: string }[];
      for (const r of rows) { if (r.op === CARD_PAUSE_OP) c.paused.add(r.target); else c.paused.delete(r.target); }
      c.seq = top;
    }
    index.set(db, c);
    return c.paused;
  }, new Set<string>());
}

/** Observe mode's writer: the gate that holds a manager (scheduler-v2-skip.ts) hands it over; null = nothing records. */
export type CardPauseObserver = (taskId: string, actionKey: string, action: string, data: Record<string, unknown>) => Promise<Record<string, unknown>>;
let observer: CardPauseObserver | null = null;
const inFlight = new Set<string>();
export function configureCardPauseObserver(next: CardPauseObserver | null): void { observer = next; }

/**
 * One note per card + pause event + action: the ledger's dedup survives restarts, the in-process set keeps a note in flight from re-sending.
 * Resolves once the note is written (or skipped); a failed note is logged, never thrown.
 */
function observe(db: Database, task: { id: string; project: string }, state: CardPauseState, action: string): Promise<void> {
  const actionKey = `pause.${state.seq}.${action}`.replace(/[^\w.:@/-]/g, "_").slice(0, 120);
  const key = `${task.id}\n${actionKey}`;
  if (!observer || inFlight.has(key)) return Promise.resolve();
  if (getEventByDedup(db, observeDedupKey({ project: task.project, mechanism: CARD_PAUSE_KEY, target: task.id, actionKey }))) return Promise.resolve();
  inFlight.add(key);
  const forget = (why: string) => { console.error(`⚠️ [card-pause] ${task.id} 观察（${action}）没记上，下次再记：${why}`); };
  return observer(task.id, actionKey, `挡住 ${action}（卡已暂停：${state.reason}）`, { pauseSeq: state.seq, gate: action })
    .then((r) => { if (r.ok !== true) forget(String(r.error ?? r.code)); })
    .catch((e: Error) => forget(e.message))
    .finally(() => inFlight.delete(key)); // written: the ledger's dedup answers from now on
}

/** The card's pause under the switch: `on` holds; `observe` gives the note to write (once per action kind); null = not paused / off. */
function pauseVerdict(db: Database, taskId: string): { mode: "on" } | { mode: "observe"; note: (action: string) => Promise<void> } | null {
  const state = cardPauseState(db, taskId);
  if (!state?.paused) return null;
  const task = safe(() => db.query("SELECT id, project FROM tasks WHERE id = ?").get(taskId) as { id: string; project: string } | null, null);
  if (!task) return null;
  const mode = cardPauseMode(task.project);
  if (mode === "on") return { mode };
  return mode === "observe" ? { mode, note: (action) => observe(db, task, state, action) } : null;
}

/**
 * For a gate that must not write ahead of the call it guards (the auto tick's ledger writes: a note landing between scheduler-plan's
 * seq read and its write would stale the plan). held = hold the call now; otherwise `after` writes the observe note (if any) and is
 * awaited once the call has run.
 */
export function cardPauseCheck(db: Database | null, taskId: string, action: string): { held: boolean; after: () => Promise<void> } {
  const v = db ? pauseVerdict(db, taskId) : null;
  return { held: v?.mode === "on", after: v?.mode === "observe" ? () => v.note(action) : () => Promise.resolve() };
}

/**
 * The skip gates' predicate: true only under `on` while the card's last decision is a pause. Under observe the would-be hold is
 * recorded (once per `action` kind) and false is returned, so scheduling runs as before; off holds and records nothing.
 */
export function cardPaused(db: Database | null, taskId: string, action: string): boolean {
  const v = db ? pauseVerdict(db, taskId) : null;
  if (v?.mode === "observe") void v.note(action);
  return v?.mode === "on";
}
