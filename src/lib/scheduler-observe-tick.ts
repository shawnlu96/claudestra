/**
 * One service pass over observe cards. The service only reads the ledger; each record is written by the guarded
 * `ledger scheduler-observe` CLI under the scheduler identity, which recomputes the plan inside its own transaction.
 * A failing card — an {ok:false} answer or a manager call that throws — is reported and skipped so one bad card cannot
 * starve the rest; only a stop / lost-lease signal ends the pass.
 */
import type { Database } from "bun:sqlite";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { paceCards, type TickPace } from "./scheduler-yield.js";
import { memoryAutoTick } from "./memory-auto-tick.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

export interface ObserveTickResult { recorded: number; unchanged: number; failed: { taskId: string; error: string }[] }

export async function schedulerObserveTick(db: Database, projects: Record<string, { maxActiveWorkers: number }>, manager: Manager,
  pace?: TickPace): Promise<ObserveTickResult> {
  const out: ObserveTickResult = { recorded: 0, unchanged: 0, failed: [] };
  out.failed.push(...await memoryAutoTick(db, Object.keys(projects), manager));
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_workflows'").get()) return out;
  for (const { project, policy, taskId } of paceCards(db, projects, "observe", pace)) {
    if (pace?.yieldNow()) break;
    if (pace) pace.cursor.observe = `${project}/${taskId}`;
    let r: Record<string, unknown>;
    try { r = await manager("ledger", "scheduler-observe", taskId, "--max-workers", String(policy.maxActiveWorkers)); }
    catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      out.failed.push({ taskId, error: String((e as Error).message).slice(0, 300) });
      continue;
    }
    if (r.ok !== true) out.failed.push({ taskId, error: String(r.error ?? "manager failed").slice(0, 300) });
    else if (r.duplicate === true) out.unchanged++;
    else out.recorded++;
  }
  return out;
}
