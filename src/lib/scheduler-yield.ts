/**
 * Fairness between `update` and the scheduler's passes over the one maintenance lease (T68f r4 ④). An update that finds
 * the lease held leaves a request file and keeps it fresh while it waits; the scheduler then starts no new pass, and a
 * running pass gives the lease up before its next card. A pass also stops starting cards once its time budget is spent,
 * and the next pass resumes after the last card it handled, so a cut-off never starves the cards at the end of the list.
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

/** Per-pass pacing handed to the merge / observe / auto loops; `cursor` survives across passes (one per loop). */
export interface TickPace {
  yieldNow(): boolean;
  cursor: Record<string, string | undefined>;
}

export function passPace(cursor: Record<string, string | undefined>, opts: { budgetMs?: number; request?: string; now?: () => number } = {}): TickPace {
  const now = opts.now ?? Date.now, deadline = now() + (opts.budgetMs ?? PASS_BUDGET_MS);
  return { cursor, yieldNow: () => now() >= deadline || maintenanceRequested(opts.request, now()) };
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
    WHERE w.project = ? AND w.mode = ? AND t.stage NOT IN ('done','cancelled') ORDER BY w.taskId`).all(project, mode) as { taskId: string }[])
    .map(({ taskId }) => ({ project, policy, taskId })));
  return pace ? rotateAfter(all, (c) => `${c.project}/${c.taskId}`, pace.cursor[mode]) : all;
}
