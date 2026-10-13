/**
 * S2D2 · the unified skip gate: a card whose route is `skip` (§2.2) gets no local side effect from any scheduler path.
 * `schedulerV2SkipManager` holds a `ledger <sub>` call for a skip card before it reaches the manager; paths acting outside the
 * manager call the predicates exported here in a ≤3-line hook. Routes are re-read on every call, so a revocation is seen at the next check.
 * Which path uses which gate: scheduler-v2-skip-paths.ts. Tests: tests/shared-ledger-v2-stage2-skip*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { cardWorkerIndex } from "./agent-lifecycle-store.js";
import { CARD_PAUSE_KEY, cardPauseCheck, cardPaused, configureCardPauseObserver, pausedCardIds } from "./card-pause.js";
import { finishedLeaseSkip } from "./ledger-scheduler-lease-finished.js";
import { configureTakeoverSkip } from "./lend-pr-takeover.js";
import { intentOf, listRequests, requestRefusal, revokeOf } from "./manual-merge-queue-facts.js";
import type { AutoTickDeps } from "./scheduler-auto-tick.js";
import type { SchedulerV2Manager } from "./scheduler-v2-pass.js";
import { schedulerV2Held, schedulerV2RouteSkip, schedulerV2SkipFeature, schedulerV2SkipTask, sharedModes } from "./scheduler-v2-skip-card.js";
import { SKIP_LEDGER_COMMANDS } from "./scheduler-v2-skip-paths.js";
import type { SubmitReceipt } from "./worker-session.js";

export { schedulerV2SkipFeature, schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
export { schedulerV2Lifecycle } from "./scheduler-v2-skip-lifecycle.js";

const V2_HELD = "v2_held";

/** Nothing to hold here: no shared mode file and no paused card (UXPAUSE1: a pause holds without shared modes too). */
const nothingHeld = (db: Database): boolean => !sharedModes(db) && pausedCardIds(db).size === 0;

/** Missing table / column in an old or test ledger reads as "no such row". */
function row<T>(db: Database, sql: string, ...params: (string | number)[]): T | null {
  try { return db.query(sql).get(...params) as T | null; }
  catch (e) {
    if (/no such (table|column)/.test((e as Error).message)) return null;
    throw e;
  }
}

/** Any card the agent works for (cardWorkerIndex: registration, scheduler session or executor) is skip. */
export function schedulerV2SkipAgent(db: Database, agent: string): boolean {
  if (nothingHeld(db)) return false;
  const links = cardWorkerIndex(db).get(agent)?.links ?? [];
  return links.some((l) => !!l.taskId && schedulerV2SkipTask(db, l.taskId));
}

/** True when any of the listed cards is skip (a train carrying one is not stepped). */
export const schedulerV2SkipAny = (db: Database, cards: readonly { taskId: string }[]): boolean =>
  cards.some((c) => schedulerV2SkipTask(db, c.taskId));

/** The cards whose route is not skip. */
export const schedulerV2Unskipped = <T extends { taskId: string }>(db: Database, cards: readonly T[]): T[] =>
  cards.filter((c) => !schedulerV2SkipTask(db, c.taskId));

/** SQL that leaves skip cards out of a set-based write over `alias.id` (the finished-lease sweep before retire). */
function excludeSkipCards(db: Database, alias: string): string {
  if (nothingHeld(db)) return "";
  const ids = (db.query("SELECT DISTINCT taskId FROM scheduler_resources WHERE scope = 'card'").all() as { taskId: string }[])
    .map((r) => r.taskId).filter((id) => schedulerV2SkipTask(db, id));
  return ids.length ? `AND ${alias}.id NOT IN (${ids.map((id) => `'${id.replaceAll("'", "''")}'`).join(",")})` : "";
}

// These modules sit in this module's import closure, so they cannot import it back: their hooks are handed over on load.
configureTakeoverSkip(schedulerV2SkipTask);
finishedLeaseSkip.card = schedulerV2SkipTask;
finishedLeaseSkip.exclude = excludeSkipCards;

interface Targets { tasks: Set<string>; features: Set<string> }

/** Value of `--flag v` or `--flag=v`. */
function flag(args: readonly string[], name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1] ?? null;
    if (args[i]!.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
  }
  return null;
}

/** A JSON argument as an object. Unparsable JSON names no card: the manager parses the same argument and rejects it unwritten. */
function jsonOf(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; /* see above: an unparsable payload is refused by the manager itself */ }
  return data && typeof data === "object" ? data as Record<string, unknown> : null;
}

const str = (o: Record<string, unknown> | null, key: string): string | null => (typeof o?.[key] === "string" ? o[key] as string : null);

function addIntent(db: Database, id: string | undefined, out: Targets): void {
  const intent = id ? row<{ taskId: string }>(db, "SELECT taskId FROM scheduler_intents WHERE id = ?", id) : null;
  if (intent) out.tasks.add(intent.taskId);
}

/** `scheduler-autostart <verb> …`: claim / spec-wait name a feature, post-verify / merge-pm / review-pm a card, settle / step a claim. */
function autostartTargets(db: Database, rest: readonly string[], out: Targets): void {
  const [verb, arg] = rest;
  if (!arg) return;
  if (verb === "claim" || verb === "spec-wait") out.features.add(arg);
  else if (verb === "post-verify" || verb === "merge-pm" || verb === "review-pm") out.tasks.add(arg);
  else if ((verb === "settle" || verb === "step") && /^\d+$/.test(arg)) {
    const claim = row<{ target: string; data: string }>(db, "SELECT target, data FROM events WHERE seq = ?", Number(arg));
    if (!claim) return;
    if (row(db, "SELECT 1 FROM features WHERE id = ?", claim.target)) out.features.add(claim.target);
    else out.tasks.add(claim.target);
    const data = jsonOf(claim.data), featureId = str(data, "featureId"), taskId = str(data, "taskId");
    if (featureId) out.features.add(featureId);
    if (taskId) out.tasks.add(taskId);
  }
}

/** The queue head a manual claim would take (manualTurn's `queued` request): no intent, no revoke, no refusal. */
function manualClaimTarget(db: Database, project: string | undefined, out: Targets): void {
  if (!project || !row(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_intents'")) return;
  const now = Date.now(), head = listRequests(db, project).find((r) => !intentOf(db, r) && !revokeOf(db, r) && !requestRefusal(db, r, now));
  if (head) out.tasks.add(head.taskId);
}

/** The cards and features a `ledger <sub> …` call is about, read from the command's target argument only (SKIP_LEDGER_COMMANDS). */
function schedulerV2LedgerTargets(db: Database, args: readonly string[]): Targets {
  const out: Targets = { tasks: new Set(), features: new Set() };
  const [sub = "", ...rest] = args;
  const first = rest[0];
  const kind = Object.hasOwn(SKIP_LEDGER_COMMANDS, sub) ? SKIP_LEDGER_COMMANDS[sub] : "unregistered";
  if ((kind === "task" || kind === "task-or-none") && first && first !== "-") out.tasks.add(first);
  else if (kind === "intent") addIntent(db, first, out);
  else if (kind === "autostart") autostartTargets(db, rest, out);
  else if (kind === "lend-order" && first) {
    const order = row<{ taskId: string }>(db, "SELECT taskId FROM lend_orders WHERE orderId = ?", first);
    if (order) out.tasks.add(order.taskId);
  } else if (kind === "manual-claim") manualClaimTarget(db, first, out);
  else if (kind === "supervise" || kind === "worker-retire") {
    const id = kind === "supervise" ? str(jsonOf(flag(rest, "--data")), "target") : str(jsonOf(flag(rest, "--wire")), "taskId");
    if (id) out.tasks.add(id);
  } else if (kind === "unregistered" && first) {
    // S2Q's rule for a command it has no row for: the first argument is the card, or an intent of it.
    out.tasks.add(first);
    addIntent(db, first, out);
  }
  return out;
}

/** The skip card or feature a ledger call would write for (paused cards first: UXPAUSE1), or null when it may run. */
function schedulerV2HeldTarget(db: Database, args: readonly string[]): { id: string; paused: boolean } | null {
  const t = schedulerV2LedgerTargets(db, args);
  for (const id of t.tasks) if (cardPaused(db, id, `ledger.${args[0] ?? ""}`)) return { id, paused: true };
  for (const id of t.tasks) if (schedulerV2RouteSkip(db, id)) return { id, paused: false };
  for (const id of t.features) if (schedulerV2SkipFeature(db, id)) return { id, paused: false };
  return null;
}

/**
 * The pass manager's skip gate (outside S2D's `schedulerV2PassManager`, inside the maintenance guard). Only `ledger` calls are
 * judged; a held call reaches neither S2Q nor the real manager. No ledger = nothing to judge: the manager is returned as is.
 */
export function schedulerV2SkipManager(db: Database | null, manager: SchedulerV2Manager): SchedulerV2Manager {
  if (!db) return manager;
  // UXPAUSE1 observe: a paused card's would-be holds are recorded through this (ungated) manager, once per card + pause + action
  configureCardPauseObserver((taskId, actionKey, action, data) => manager("ledger", "scheduler-recovery-observe", taskId, "--mechanism", CARD_PAUSE_KEY,
    "--action-key", actionKey, "--action", action, "--data", JSON.stringify(data)));
  return async (...args) => {
    if (args[0] === "ledger" && !nothingHeld(db)) {
      const held = schedulerV2HeldTarget(db, args.slice(1));
      if (held !== null) {
        schedulerV2Held(`ledger ${args[1] ?? ""}`, held.id);
        return { ok: false, code: V2_HELD, held: true,
          error: held.paused ? `card paused: ${held.id} held, nothing written` : `v2 route skip: ${held.id} held, nothing written` };
      }
    }
    return manager(...args);
  };
}

/**
 * Evidence that an action started before the pause finished (UXPAUSE1: submitted / done intents are kept, so their results land):
 * settling an intent to anything but `submitted` (a claim is a new action) and binding the session a submitted ensure created.
 */
function completionEvidence(db: Database, args: readonly string[]): boolean {
  const [sub, first] = args;
  if (sub === "scheduler-settle") return flag(args, "--to") !== "submitted";
  if (sub !== "scheduler-session-bind" || !first) return false;
  const intent = row<{ status: string }>(db, "SELECT status FROM scheduler_intents WHERE id = ? AND taskId = ?", flag(args, "--intent") ?? "", first);
  return intent?.status === "submitted";
}

/** Run `call` unless the paused card holds it (`on`); under observe the note for `action` is written after the call, never before. */
async function pauseGated<R>(db: Database, taskId: string, action: string, held: () => R | Promise<R>, call: () => Promise<R>): Promise<R> {
  const check = cardPauseCheck(db, taskId, action);
  if (check.held) { schedulerV2Held(action, taskId); return held(); }
  const r = await call();
  await check.after();
  return r;
}

/**
 * UXPAUSE1 · the auto tick's own ports: autoTickDeps builds its manager, PM notice and external effects apart from the pass manager
 * above, and MAN2, the refused-plan notice retry and a card's steps after an await all go through them, so each re-checks the pause
 * right before it acts. A paused card's ledger write is held as that card's refusal (`conflict`, so MAN2 goes on to the next card),
 * except the completion evidence of an action started before the pause; ensure / pinReview / submit start nothing (wait / manual /
 * a submit's claim settled cancelled here, not as undelivered, so the planner redoes it right after resume with no resend backoff);
 * a PM notice is thrown, so a retried notice stays pending and goes out after resume. Under observe nothing is held and each action kind (`ledger.<sub>`, ensure,
 * pinReview, submit, notifyPm) is noted once, after the call it guards.
 */
export function schedulerV2SkipAutoDeps(db: Database | null, deps: AutoTickDeps): AutoTickDeps {
  if (!db) return deps;
  const target = (args: readonly string[]): string | undefined => args[0] !== "ledger" || pausedCardIds(db).size === 0
    || completionEvidence(db, args.slice(1)) ? undefined : [...schedulerV2LedgerTargets(db, args.slice(1)).tasks].find((id) => pausedCardIds(db).has(id));
  const pausedText = (id: string) => `card paused: ${id} held, nothing written`;
  return {
    ...deps,
    manager: async (...args) => {
      const id = target(args);
      if (id === undefined) return deps.manager(...args);
      return pauseGated(db, id, `ledger.${args[1] ?? ""}`, () => ({ ok: false, code: "conflict", held: true, error: pausedText(id) }), () => deps.manager(...args));
    },
    ensure: (task, role, family) => pauseGated(db, task.id, "ensure", () => ({ kind: "wait" as const, reason: `卡已暂停，未建 ${role} session` }),
      () => deps.ensure(task, role, family)),
    pinReview: (task, ref, head) => pauseGated(db, task.id, "pinReview", () => ({ manual: `卡已暂停，未固定审查目录（${pausedText(task.id)}）` }),
      () => deps.pinReview(task, ref, head)),
    worker: (ref) => {
      const w = deps.worker(ref);
      if ("manual" in w) return w;
      const held = async (intentId: string) => { // settled here so the receipt is not an undelivered one (no resend backoff after resume)
        await deps.manager("ledger", "scheduler-settle", intentId, "--from", "submitted", "--to", "cancelled", "--receipt", "卡已暂停，没发出；继续后重新派");
        return { status: "rejected" as const, route: w.route, reason: "卡已暂停，没发出" };
      };
      return { ...w, submit: (r, intentId, order) => pauseGated<SubmitReceipt>(db, ref.taskId, "submit", () => held(intentId), () => w.submit(r, intentId, order)) };
    },
    notifyPm: (task, text) => pauseGated(db, task.id, "notifyPm", () => { throw new Error(`卡 ${task.id} 已暂停，提醒留到继续后再发`); },
      () => deps.notifyPm(task, text)),
  };
}
