/**
 * S2D2 · the unified skip gate. A card whose route is `skip` (§2.2: its feature is `migrating`, or execution without an
 * effective `on` and a port) gets no local side effect from any scheduler path, not only from S2D's five candidate loops.
 * Common exit first: `schedulerV2SkipManager` wraps the pass manager (scheduler-pass.ts), finds the card each ledger
 * subcommand is about (scheduler-v2-skip-paths.ts) and answers `{ ok:false, code:"v2_held" }` without calling the manager.
 * Paths that act before or outside the manager use the predicates below in a ≤3-line hook. Routes are re-read on every call
 * (the mode file read is cached by file identity, scheduler-v2-skip-mode.ts), so a revocation is seen at the next check.
 * A new feature card is never opened here while its feature is migrating or execution, whatever the switch (PM, auto.start).
 * Tests: tests/shared-ledger-v2-stage2-skip*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { configureTakeoverSkip } from "./lend-pr-takeover.js";
import { intentOf, listRequests, requestRefusal, revokeOf } from "./manual-merge-queue-facts.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { schedulerV2Route, type SchedulerV2Manager } from "./scheduler-v2-pass.js";
import { readSharedLedgerModeCached, schedulerV2Diagnostic } from "./scheduler-v2-skip-mode.js";
import { SKIP_LEDGER_COMMANDS } from "./scheduler-v2-skip-paths.js";

const V2_HELD = "v2_held";

/** Missing table / column in an old or test ledger reads as "no such row". */
function row<T>(db: Database, sql: string, ...params: (string | number)[]): T | null {
  try { return db.query(sql).get(...params) as T | null; }
  catch (e) {
    if (/no such (table|column)/.test((e as Error).message)) return null;
    throw e;
  }
}

function held(what: string, id: string): void {
  if (schedulerV2Diagnostic(`held:${what}:${id}`)) console.info(`[scheduler-v2 held] ${what} ${id}: skip`);
}

/** No mode file = no shared feature at all: every route is local, so stage one runs exactly as before (nothing else is read). */
const sharedModes = (db: Database): boolean => existsSync(join(dirname(db.filename), "shared-ledger-modes.json"));

/** The card's route is `skip`. A card that cannot be read (corrupt row) holds while shared modes exist. */
export function schedulerV2SkipTask(db: Database, taskId: string): boolean {
  if (!sharedModes(db)) return false;
  try { return schedulerV2Route(taskId, db) === "skip"; }
  catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    held("card unreadable", taskId);
    return true;
  }
}

/** No local new card, claim or feature-level write: the feature is migrating or execution (unreadable holds too). */
export function schedulerV2SkipFeature(db: Database, featureId: string): boolean {
  if (!sharedModes(db)) return false;
  try {
    const mode = readSharedLedgerModeCached(featureId, dirname(db.filename));
    return !!mode.migrating || mode.authorityMode === "execution";
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    held("feature mode unreadable", featureId);
    return true;
  }
}

/** Any of the agent's live cards (task agent or an unretired scheduler session) is skip. */
export function schedulerV2SkipAgent(db: Database, agent: string): boolean {
  if (!sharedModes(db)) return false;
  const ids = new Set<string>();
  for (const sql of ["SELECT id FROM tasks WHERE agent = ?", "SELECT taskId AS id FROM scheduler_sessions WHERE agent = ? AND state != 'retired'"]) {
    try { for (const r of db.query(sql).all(agent) as { id: string }[]) ids.add(r.id); }
    catch (e) { if (!/no such table/.test((e as Error).message)) throw e; }
  }
  return [...ids].some((id) => schedulerV2SkipTask(db, id));
}

// lend-pr-takeover.ts cannot import this module (its import chain leads back here), so the hook is handed to it on load.
configureTakeoverSkip(schedulerV2SkipTask);

/** True when any of the listed cards is skip (a train carrying one is not stepped). */
export const schedulerV2SkipAny = (db: Database, cards: readonly { taskId: string }[]): boolean =>
  cards.some((c) => schedulerV2SkipTask(db, c.taskId));

/** The cards whose route is not skip. */
export const schedulerV2Unskipped = <T extends { taskId: string }>(db: Database, cards: readonly T[]): T[] =>
  cards.filter((c) => !schedulerV2SkipTask(db, c.taskId));

interface Targets { tasks: Set<string>; features: Set<string> }

function scanToken(db: Database, token: string, out: Targets): void {
  if (!token) return;
  if (token.startsWith("{")) {
    let data: unknown;
    try { data = JSON.parse(token); } catch { return; }
    if (data && typeof data === "object") {
      for (const key of ["taskId", "intentId", "featureId"]) {
        const v = (data as Record<string, unknown>)[key];
        if (typeof v === "string") scanToken(db, v, out);
      }
    }
    return;
  }
  if (row(db, "SELECT 1 FROM tasks WHERE id = ?", token)) out.tasks.add(token);
  const intent = row<{ taskId: string }>(db, "SELECT taskId FROM scheduler_intents WHERE id = ?", token);
  if (intent) out.tasks.add(intent.taskId);
  if (row(db, "SELECT 1 FROM features WHERE id = ?", token)) out.features.add(token);
}

/** The cards and features a `ledger <sub> …` call is about. */
function schedulerV2LedgerTargets(db: Database, args: readonly string[]): Targets {
  const out: Targets = { tasks: new Set(), features: new Set() };
  const [sub = "", ...rest] = args;
  for (const a of rest) {
    if (!a.startsWith("--")) scanToken(db, a, out);
    else if (a.includes("=")) scanToken(db, a.slice(a.indexOf("=") + 1), out);
  }
  const kind = SKIP_LEDGER_COMMANDS[sub] ?? "card";
  if (kind === "autostart" && /^\d+$/.test(rest[1] ?? "")) {
    const claim = row<{ target: string; data: string }>(db, "SELECT target, data FROM events WHERE seq = ?", Number(rest[1]));
    if (claim) { scanToken(db, claim.target, out); scanToken(db, claim.data, out); }
  } else if (kind === "lend-order" && rest[0]) {
    const order = row<{ taskId: string }>(db, "SELECT taskId FROM lend_orders WHERE orderId = ?", rest[0]);
    if (order) out.tasks.add(order.taskId);
  } else if (kind === "manual-claim" && rest[0] && row(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_intents'")) {
    // The queue head the claim would take (manualTurn's `queued` request): first one with no intent, no revoke, no refusal.
    const now = Date.now(), head = listRequests(db, rest[0]).find((r) => !intentOf(db, r) && !revokeOf(db, r) && !requestRefusal(db, r, now));
    if (head) out.tasks.add(head.taskId);
  }
  return out;
}

/** The skip card or feature a ledger call would write for, or null when it may run. */
function schedulerV2HeldTarget(db: Database, args: readonly string[]): string | null {
  const t = schedulerV2LedgerTargets(db, args);
  for (const id of t.tasks) if (schedulerV2SkipTask(db, id)) return id;
  for (const id of t.features) if (schedulerV2SkipFeature(db, id)) return id;
  return null;
}

/**
 * The pass manager's skip gate (outside S2D's `schedulerV2PassManager`, inside the maintenance guard). Only `ledger` calls are
 * judged; a held call reaches neither S2Q nor the real manager. No ledger = nothing to judge: the manager is returned as is.
 */
export function schedulerV2SkipManager(db: Database | null, manager: SchedulerV2Manager): SchedulerV2Manager {
  if (!db) return manager;
  return async (...args) => {
    if (args[0] === "ledger" && sharedModes(db)) {
      const id = schedulerV2HeldTarget(db, args.slice(1));
      if (id !== null) {
        held(`ledger ${args[1] ?? ""}`, id);
        return { ok: false, code: V2_HELD, held: true, error: `v2 route skip: ${id} held, nothing written` };
      }
    }
    return manager(...args);
  };
}
