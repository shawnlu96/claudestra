/**
 * Fairness between `update` and the scheduler's passes over the one maintenance lease (T68f r4 ④). An update that finds
 * the lease held leaves a request file and keeps it fresh while it waits; the scheduler then starts no new pass, and a
 * running pass gives the lease up before its next card. A pass also stops starting cards once its time budget is spent
 * (each phase keeps a floor, see passPace), and the next pass resumes after the last card it handled, so a cut-off never
 * starves the cards at the end of a list nor a whole later phase.
 * A card step already started is never interrupted. Tests: tests/scheduler-yield.test.ts.
 */
import type { Database } from "bun:sqlite";
import { rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { statePath } from "./paths.js";

/** New cards stop being started after this long; the card in hand runs to its own end. */
const PASS_BUDGET_MS = 60_000;
/** How long `update` waits for a running pass to yield before it gives up. A single card step is bounded by its own timeouts. */
export const UPDATE_WAIT_MS = 300_000;
/** A request not refreshed for this long belongs to an updater that is gone. */
export const REQUEST_FRESH_MS = 30_000;

export const MAINTENANCE_REQUEST = statePath("scheduler-maintenance.request");

export function requestMaintenance(path = MAINTENANCE_REQUEST): void {
  try { const now = new Date(); utimesSync(path, now, now); }
  catch { writeFileSync(path, String(process.pid)); /* 第一次：还没有请求文件 */ }
}

export function maintenanceRequested(path = MAINTENANCE_REQUEST, now = Date.now()): boolean {
  try { return now - statSync(path).mtimeMs < REQUEST_FRESH_MS; } catch { return false; /* 没有请求文件 = 没人在等 */ }
}

export const clearMaintenanceRequest = (path = MAINTENANCE_REQUEST): void => rmSync(path, { force: true });

/** Per-phase pacing handed to the merge / observe / auto loops; `cursor` survives across passes (one per loop). */
export interface TickPace {
  yieldNow(): boolean;
  skipTask?(taskId: string): boolean;
  /** A pre-step's check (manual-resume ahead of auto) that started no card does not use up the list's first card. */
  openList?(): void;
  /** The check that just passed was the phase's guaranteed one past its budget: the card it starts is the list's first in rotation
   *  (cursor order), whatever the loop puts first (an unknown merge), and every later check of the phase yields. */
  lastCard?(): boolean;
  cursor: Record<string, string | undefined>;
}

/** Phases of one pass (merge, observe, auto): each is guaranteed this share of the budget from its own start. */
const PHASES = 3;

/**
 * One pass's pacing. A phase stops starting cards once the pass budget is spent *and* its own floor (budget / PHASES from
 * the phase's start) has run out, or at once when an update is waiting; the floor keeps a busy earlier phase from starving a later one.
 * The floor is wall-clock and can be gone before the phase's first check, so with a positive budget that check (or the first
 * after openList, once) never yields for the budget; if that check finds the budget spent, it is the phase's last: the one
 * card it lets through is the next in cursor rotation (lastCard), judged on the same clock reading as the grant itself.
 * Cost: a pass can run up to budget + 2 floors (plus the cards in hand), 100s with the 60s default. tests/scheduler-phase-first-card.test.ts.
 */
export function passPace(cursor: Record<string, string | undefined>, opts: { budgetMs?: number; request?: string; now?: () => number } = {}): { phase(): TickPace } {
  const now = opts.now ?? Date.now, budget = opts.budgetMs ?? PASS_BUDGET_MS, deadline = now() + budget;
  return {
    phase: () => {
      const floor = now() + budget / PHASES;
      let grant = budget > 0, reopened = false, past = false;
      const spent = () => now() >= deadline && now() >= floor;
      return { cursor,
        yieldNow: () => {
          if (maintenanceRequested(opts.request, now())) return true;
          if (grant) { grant = false; past = spent(); return false; }
          return past || spent();
        },
        openList: () => { if (!reopened) grant = reopened = budget > 0; },
        lastCard: () => past };
    },
  };
}

/** Sorted by key, starting at the first key after `after` and wrapping round; a card that vanished meanwhile skips nothing. */
export function rotateAfter<T>(items: T[], key: (t: T) => string, after: string | undefined): T[] {
  const sorted = [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const i = after === undefined ? -1 : sorted.findIndex((t) => key(t) > after);
  return i <= 0 ? sorted : [...sorted.slice(i), ...sorted.slice(0, i)];
}

/** Live cards of one workflow mode across the service's projects; with a pace, in rotation after where the last pass stopped. */
export function paceCards<P>(db: Database, projects: Record<string, P>, mode: "observe" | "auto", pace?: TickPace): { project: string; policy: P; taskId: string }[] {
  const all = Object.entries(projects).flatMap(([project, policy]) => (db.query(`SELECT w.taskId FROM task_workflows AS w JOIN tasks AS t ON t.id = w.taskId
    WHERE w.project = ? AND w.mode = ? AND t.stage NOT IN ('done','cancelled')
    AND (t.stage != 'verified' OR EXISTS (SELECT 1 FROM scheduler_intents AS i
      WHERE i.taskId = t.id AND i.status IN ('pending','submitted','unknown'))) ORDER BY w.taskId`).all(project, mode) as { taskId: string }[])
    .filter(({ taskId }) => !pace?.skipTask?.(taskId)).map(({ taskId }) => ({ project, policy, taskId })));
  return pace ? rotateAfter(all, (c) => `${c.project}/${c.taskId}`, pace.cursor[mode]) : all;
}
