/**
 * The auto tick's side of a pool intent (i28-R9): every pass runs one `ledger scheduler-pool` step under the scheduler
 * identity (offer on the first pass, then mirror the lend order onto the intent), and tells PM once when an unclaimed order
 * is withdrawn. A pool intent is never re-planned or handed to a session adapter: the order, not a local session, is its effect.
 */
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { DEFAULT_REMOTE, type RemotePolicy } from "./scheduler-config.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

export interface PoolTickDeps {
  manager: Manager;
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  /** Called when a lost notice must be logged; SchedulerStopped is rethrown by the caller's handler. */
  lost(what: string): (e: unknown) => void;
}

/** A policy that no longer pools still syncs an order already out; only the offer re-checks the mode. */
const OFF: RemotePolicy = { mode: "off", roles: [], poolTimeoutMin: DEFAULT_REMOTE.poolTimeoutMin };

export async function drivePool(deps: PoolTickDeps, task: LedgerTask, intent: SchedulerIntent, maxWorkers: number,
  remote: RemotePolicy | undefined): Promise<{ step: string; detail: string }> {
  const r = remote ?? OFF;
  const res = await deps.manager("ledger", "scheduler-pool", intent.id, "--max-workers", String(maxWorkers), "--mode", r.mode,
    "--roles", r.roles.includes("review") ? "review" : "none", "--timeout-min", String(r.poolTimeoutMin),
    // The offer re-plans from these flags; without reviewFirst a tie goes by lend.json order and the intent is cancelled.
    ...(r.reviewFirst?.length ? ["--review-first", r.reviewFirst.join(",")] : []));
  if (res.ok !== true) return { step: res.code === "conflict" ? "lost_race" : "held", detail: `挂池一步没走通：${String(res.error)}` };
  const outcome = String(res.outcome), text = String(res.text ?? "");
  if (outcome === "timeout") await deps.notifyPm(task, `[调度引擎] ${task.id} ${text}`).catch(deps.lost("挂池超时通知没发出去（台账已记撤回）"));
  return { step: `pool_${outcome}`, detail: text };
}
