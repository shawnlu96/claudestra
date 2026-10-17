/**
 * AUTOSTARVE1 · consume results that are already in before the auto loop competes for new slots. A card whose open intent's
 * lend order is done / cancelled / released, or that has a deliver / review event newer than that intent, only needs its
 * settle (intent sync) and, when the planner's next step is a stage move, that move: both run here, ahead of mergeFirst and
 * the PRIO2 bands, never through claimSlot. New placements still go through the auto loop in its own order: a consumed card is
 * not stepped again in the same pass, its placement comes in the next pass's loop. An unknown order, an unknown intent or a merge intent keeps the current rules (not in this group).
 * Bound entries (a card's facts can change while the group awaits it, e.g. PM settles the intent): the settle step runs only when
 * the card's open intent is still the one it was picked for, checked in the same synchronous run in which Card.step reads it;
 * the stage step only when the planner still says stage. Inside either step any other plan (a placement) is refused and the
 * card is left to the loop (LeftToLoop). A pending intent is due only when its order is terminal: without one it is a placement.
 * Pace: the group has its own wall-clock budget (CONSUME_BUDGET_MS, at least one card) but obeys the auto pace's stops (zero
 * budget, maintenance, an external stop) before every card; the auto pace's first check, which the group makes, is replayed to
 * the loop, so the loop keeps its first-card grant. Past the budget the rest wait in rotation (cursor.consume). Recovery key autoConsumeFirst: off = the old
 * order exactly, observe = counted and logged, plus one recovery-observe sample per card and intent. Only with a pace (the budgeted service pass); a bare tick is unchanged.
 * One line per pass on stdout (scheduler.out), no ledger event. tests/scheduler-consume-first.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { IntentAction, IntentStatus } from "./ledger-scheduler.js";
import { getLendOrder } from "./ledger-lend.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { recoveryPolicy as filePolicy, observeDedupKey, type ObservedAction, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { autoSnapshot } from "./scheduler-auto-snapshot.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { planScheduler } from "./scheduler-plan.js";
import { poolOrderId } from "./scheduler-pool-facts.js";
import type { SnapshotOpts } from "./scheduler-snapshot.js";
import { rotateAfter, type TickPace } from "./scheduler-yield.js";

const CONSUME_KEY = "autoConsumeFirst";
/** A lend order in one of these has its result (or its withdrawal) on the ledger already. */
const TERMINAL_ORDER = ["done", "cancelled", "released"];
/** Wall-clock budget of the group per pass: one phase floor of the default 60s pass. */
const CONSUME_BUDGET_MS = 20_000;

export interface LiveIntent { id: string; status: IntentStatus; action: IntentAction; eventSeq: number }
interface Keyed { project: string; taskId: string }
interface Outcome { taskId: string; step: string; detail: string }
/** What the group drives: the auto tick's Card (structurally), built fresh for each step. */
interface ConsumeCard { readonly task: LedgerTask; readonly opts: SnapshotOpts; step(): Promise<Outcome>; plan(p: StagePlan): Promise<unknown> }
interface StagePlan { action: string; targetStage?: string }
/** A step inside the group tried to plan something it may not (a placement): the card is the loop's. */
class LeftToLoop extends Error {}

/**
 * Pure: the cards with a result waiting, in the input (rotation) order. `live` is each card's newest open intent, `orders` the
 * status of that intent's lend order (null = none), `verdictSeq` the newest deliver / review event seq of the card.
 */
export function consumeFirstOrder<C extends { taskId: string }>(cards: readonly C[], live: ReadonlyMap<string, LiveIntent | null>,
  orders: ReadonlyMap<string, string | null>, verdictSeq: ReadonlyMap<string, number | null>): C[] {
  return cards.filter(({ taskId }) => {
    const intent = live.get(taskId), order = orders.get(taskId) ?? null, seq = verdictSeq.get(taskId) ?? null;
    if (!intent || (intent.status !== "pending" && intent.status !== "submitted") || intent.action === "merge" || order === "unknown") return false;
    return (order !== null && TERMINAL_ORDER.includes(order)) || (intent.status === "submitted" && seq !== null && seq > intent.eventSeq);
  });
}

/** The pool intent's order status when it is terminal (done / cancelled / released), else null; never throws. */
export function terminalPoolOrder(db: Database | null, intentId: string): string | null {
  const status = orderStatus(db, intentId);
  return status && TERMINAL_ORDER.includes(status) ? status : null;
}

function orderStatus(db: Database | null, intentId: string): string | null {
  if (!db) return null;
  try {
    const id = poolOrderId(db, intentId);
    return id ? getLendOrder(db, id)?.status ?? null : null;
  } catch { return null; } // no lend tables / unreadable = no order: the card keeps the current rules
}

/** Ledger reads behind consumeFirstOrder, one card at a time. */
function readFacts(db: Database, cards: readonly Keyed[]) {
  const live = new Map<string, LiveIntent | null>(), orders = new Map<string, string | null>(), verdictSeq = new Map<string, number | null>();
  const open = db.query(`SELECT id, status, action, eventSeq FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown')
    ORDER BY eventSeq DESC LIMIT 1`);
  const verdict = db.query("SELECT MAX(seq) AS seq FROM events WHERE target = ? AND project = ? AND kind IN ('deliver','review')");
  for (const { project, taskId } of cards) {
    const intent = open.get(taskId) as LiveIntent | null;
    live.set(taskId, intent);
    orders.set(taskId, intent ? orderStatus(db, intent.id) : null);
    verdictSeq.set(taskId, (verdict.get(taskId, project) as { seq: number | null } | null)?.seq ?? null);
  }
  return { live, orders, verdictSeq };
}

/** Still due as picked: the same open intent in the same status, and still a result waiting. */
function stillDue(db: Database, c: Keyed, bound: LiveIntent): boolean {
  const f = readFacts(db, [c]), now = f.live.get(c.taskId);
  return now?.id === bound.id && now.status === bound.status && consumeFirstOrder([c], f.live, f.orders, f.verdictSeq).length > 0;
}

/** After the settle: no open intent left and the planner's next step is a stage move (no slot, no placement); its target, else null. */
function stageNext(db: Database, task: LedgerTask, opts: SnapshotOpts): string | null {
  if (db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(task.id)) return null;
  const plan = planScheduler(autoSnapshot(db, task, opts));
  return plan.kind === "intent" && plan.action === "stage" ? plan.targetStage ?? null : null;
}

/** The card with its plan bound: only `allow` may be planned; anything else throws LeftToLoop before it reaches the ledger. */
function bound(card: ConsumeCard, allow: (p: StagePlan) => boolean): ConsumeCard {
  const plan = card.plan.bind(card);
  card.plan = (p) => allow(p) ? plan(p) : Promise.reject(new LeftToLoop(`${p.action} 留给 auto 段`));
  return card;
}

/**
 * The group's stop check on the auto pace: a yield that is not the budget's (zero budget, maintenance, an external stop) stops
 * the group; the budget's does not (the group has its own). `loop` is the pace for the auto loop: the first check, made here,
 * is replayed to the loop's first check, so the group never spends the loop's first-card grant.
 */
function gate(pace: TickPace) {
  let first: { y: boolean; ended: boolean } | undefined, replay: "no" | "next" | "done" = "no";
  return {
    stop(): boolean {
      const y = pace.yieldNow(), ended = pace.budgetEnded?.() ?? false;
      if (!first) { first = { y, ended }; replay = "next"; }
      return y && !ended;
    },
    loop(): TickPace {
      if (!first) return pace;
      const was = first;
      return { ...pace,
        yieldNow: () => { if (replay === "next") { replay = "done"; return was.y; } replay = "no"; return pace.yieldNow(); },
        ...(pace.budgetEnded ? { budgetEnded: () => replay === "done" ? was.ended : pace.budgetEnded!() } : {}) };
    },
  };
}

export interface ConsumeDeps<C> {
  /** observe samples go out as `ledger scheduler-recovery-observe` through the pass manager (the auto tick wires it). */
  observe(a: ObservedAction): Promise<Record<string, unknown>>;
  card(c: C, task: LedgerTask): Promise<ConsumeCard | { deferred: true; reason: string }>;
  recoveryPolicy?: RecoveryPolicyPort;
  pace?: TickPace;
  failed: { taskId: string; error: string }[];
}
/** `taken`: cards the group stepped; the auto loop skips them this pass, so their next placement comes next pass in its order. */
/** `pace`: the pace the auto loop goes on with (see gate). */
export interface ConsumePass { active: boolean; due: number; handled: number; outcomes: Outcome[]; taken: Set<string>; pace?: TickPace }

const keyOf = (c: Keyed) => `${c.project}/${c.taskId}`;

/** The group, run before the auto loop's card order; its outcomes go first in the pass's cards. */
export async function consumeFirst<C extends Keyed>(db: Database, turn: readonly C[], deps: ConsumeDeps<C>): Promise<ConsumePass> {
  const pass: ConsumePass = { active: false, due: 0, handled: 0, outcomes: [], taken: new Set(), pace: deps.pace };
  if (!deps.pace) return pass;
  const modes = new Map<string, RecoveryMode>();
  const mode = (project: string) => modes.get(project) ?? modes.set(project, (deps.recoveryPolicy ?? filePolicy)(project, CONSUME_KEY).mode).get(project)!;
  const cards = turn.filter((c) => mode(c.project) !== "off");
  if (!cards.length) return pass;
  pass.active = true;
  let f: ReturnType<typeof readFacts>;
  try { f = readFacts(db, cards); } catch (e) { // unreadable facts: no group this pass, the loop below runs as before
    deps.failed.push({ taskId: "consume-first", error: String((e as Error).message).slice(0, 560) });
    return pass;
  }
  const due = consumeFirstOrder(cards, f.live, f.orders, f.verdictSeq), start = Date.now(), cursor = deps.pace.cursor, g = gate(deps.pace);
  pass.due = due.length;
  if (!due.length) return pass;
  const stopped = g.stop();
  pass.pace = g.loop();
  if (stopped) return pass; // zero budget / maintenance / an external stop: nothing written, the loop sees the same stop
  for (const c of due.filter((x) => mode(x.project) === "observe")) {
    await observe(db, c, f.live.get(c.taskId)!, deps).catch((e) => { if (e instanceof SchedulerStopped) throw e; console.error(`⚠️ [scheduler] ${c.taskId} 观察没记上：${String(e)}`); });
  }
  const todo = rotateAfter(due.filter((c) => mode(c.project) === "on"), keyOf, cursor.consume);
  for (const [i, c] of todo.entries()) {
    if (i > 0 && (Date.now() - start >= CONSUME_BUDGET_MS || g.stop())) break; // cursor.consume: the last card started
    cursor.consume = keyOf(c);
    try { if (await consumeOne(db, c, f.live.get(c.taskId)!, deps, pass.outcomes)) { pass.handled++; pass.taken.add(c.taskId); } } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      pass.handled++; pass.taken.add(c.taskId);
      deps.failed.push({ taskId: c.taskId, error: String((e as Error).message).replace(/\s+/g, " ").slice(0, 560) });
    }
    if (i === todo.length - 1) cursor.consume = undefined;
  }
  return pass;
}

/** observe: the settle this group would run ahead of the loop, once per card and intent (the CLI dedups too). */
async function observe(db: Database, c: Keyed, intent: LiveIntent, deps: Pick<ConsumeDeps<Keyed>, "observe">): Promise<void> {
  const a: ObservedAction = { project: c.project, mechanism: CONSUME_KEY, target: c.taskId, actionKey: `consume:${intent.id}`,
    action: `本来会在 auto 段之前先结算 ${intent.id}（${intent.action}，结果已到）` };
  if (getEventByDedup(db, observeDedupKey(a))) return;
  const r = await deps.observe(a);
  if (r.ok !== true) console.error(`⚠️ [scheduler] ${c.taskId} ${CONSUME_KEY} 观察没记上，下轮重试：${String(r.error)}`);
}

/** True when the group took the card (the loop skips it this pass); false leaves it to the loop's own order. */
async function consumeOne<C extends Keyed>(db: Database, c: C, intent: LiveIntent, deps: ConsumeDeps<C>, out: Outcome[]): Promise<boolean> {
  const task = getTask(db, c.taskId);
  if (!task || deps.pace?.skipTask?.(c.taskId)) return false;
  const first = await deps.card(c, task);
  if ("deferred" in first) { out.push({ taskId: c.taskId, step: "held", detail: first.reason }); return true; }
  // No await between this check and step()'s own read of the open intent: the step settles exactly the intent picked.
  if (!stillDue(db, c, intent)) return false;
  try { out.push(await bound(first, () => false).step()); } catch (e) { if (e instanceof LeftToLoop) return false; throw e; }
  const moved = getTask(db, c.taskId), target = moved && stageNext(db, moved, first.opts);
  if (!moved || !target) return true;
  const again = await deps.card(c, moved);
  if ("deferred" in again) return true;
  const now = getTask(db, c.taskId); // re-checked after the await; inside the step only this very stage move may be planned
  if (!now || stageNext(db, now, again.opts) !== target) return true;
  try { out.push(await bound(again, (p) => p.action === "stage" && p.targetStage === target).step()); } catch (e) {
    if (!(e instanceof LeftToLoop)) throw e;
    out.push({ taskId: c.taskId, step: "held", detail: `先消费组只推进到 ${target}，${e.message}（下轮）` });
  }
  return true;
}

/** The pass's trace line (scheduler.out): group size, cards it handled, auto-loop cards, and the fair anchor of a budget cut. */
export function logConsumeFirst(pass: ConsumePass, cards: number, pace?: TickPace): void {
  if (!pass.active) return;
  console.log(`[consume-first] 待消费=${pass.due} 已处理=${pass.handled} auto段=${cards - pass.outcomes.length} 锚点=${pace?.cursor.autoBudget ?? "-"}`);
}
