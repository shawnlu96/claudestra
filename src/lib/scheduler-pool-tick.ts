/**
 * The auto tick's side of a pool intent (i28-R9): every pass runs one `ledger scheduler-pool` step under the scheduler
 * identity (offer on the first pass, then mirror the lend order onto the intent), and tells PM once when an unclaimed order
 * is withdrawn. A pool intent is never re-planned or handed to a session adapter: the order, not a local session, is its effect.
 * poolIdleSkip on: a claimed order whose intent is already submitted skips that CLI (pure no-op sync; scheduler-pool-idle.ts).
 */
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { DEFAULT_REMOTE, type RemotePolicy } from "./scheduler-config.js";
import { LedgerReader } from "./ledger-read.js";
import { poolRefusalStep } from "./ledger-pool-refusal-tick.js";
import { centralPoolStep } from "./ledger-lend-central-pool.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { poolIdleCandidate, observePoolIdle, logPoolIdleObservation, type PoolIdleObservation } from "./scheduler-pool-idle.js";
import { claimSlot } from "./scheduler-priority-order.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

export interface PoolTickDeps {
  manager: Manager;
  recoveryPolicy?: RecoveryPolicyPort;
  poolIdleObservation?: PoolIdleObservation;
  notifyPm(task: LedgerTask, text: string): Promise<void>;
  /** Called when a lost notice must be logged; SchedulerStopped is rethrown by the caller's handler. */
  lost(what: string): (e: unknown) => void;
  /** MODELXP2 读池单拒审事实的只读句柄；不给 = 本模块自己的只读 LedgerReader（同 scheduler.ts 的默认台账） */
  db?: import("bun:sqlite").Database | null;
}
let reader: LedgerReader | null = null;
const readDb = () => { try { return (reader ??= new LedgerReader()).get(); } catch { return null; } }; // 读不了 = 照旧走老路

/** A policy that no longer pools still syncs an order already out; only the offer re-checks the mode. */
const OFF: RemotePolicy = { mode: "off", roles: [], poolTimeoutMin: DEFAULT_REMOTE.poolTimeoutMin };

export async function drivePool(deps: PoolTickDeps, task: LedgerTask, intent: SchedulerIntent, maxWorkers: number,
  remote: RemotePolicy | undefined): Promise<{ step: string; detail: string }> {
  const r = remote ?? OFF;
  const db = deps.db !== undefined ? deps.db : readDb(); // MODELXP2：镜像成 unknown 之前先接池单拒审
  const refused = db ? await poolRefusalStep({ db, manager: deps.manager, localFamilies: r.localFamilies }, task, intent) : null;
  if (refused) return refused;
  // S2F6: a central card's order goes through the center (lend.create), never `ledger scheduler-pool`; null = the path below unchanged.
  const central = await centralPoolStep(task, intent, { maxWorkers, remote: r });
  if (central) return central;
  const mode = (deps.recoveryPolicy ?? recoveryPolicy)(task.project, "poolIdleSkip").mode;
  const idle = mode === "off" ? null : poolIdleCandidate(db, task.id, intent.id);
  if (idle && mode === "on") return { step: idle.step, detail: idle.detail };
  const reread = claimSlot(db, r.mode === "off" ? "local_slot" : "lend_slot", task); if (reread) return reread; // PRIO2 定 3
  const res = await deps.manager("ledger", "scheduler-pool", intent.id, "--max-workers", String(r.agents ? Math.min(32, maxWorkers) : maxWorkers), "--mode", r.mode,
    "--roles", r.roles.length ? r.roles.join(",") : "none", "--timeout-min", String(r.poolTimeoutMin),
    // The offer re-plans from these flags: a dropped reviewFirst / localPriority would pick another machine and cancel the intent.
    ...(r.reviewFirst?.length ? ["--review-first", r.reviewFirst.join(",")] : []),
    ...(r.localPriority ? ["--local-priority", r.localPriority] : []), ...(r.repo ? ["--repo", r.repo] : []),
    ...(r.writeFamilies ? ["--write-families", r.writeFamilies.join(",")] : []), ...(r.fixReassignMin ? ["--fix-reassign-min", String(r.fixReassignMin)] : []));
  if (idle && mode === "observe") {
    const stats = deps.poolIdleObservation ?? { candidates: 0, idle: 0, mismatches: 0 };
    observePoolIdle(stats, idle, res);
    if (!deps.poolIdleObservation) logPoolIdleObservation(stats);
  }
  if (res.ok !== true) return { step: res.code === "conflict" ? "lost_race" : "held", detail: `挂池一步没走通：${String(res.error)}` };
  const outcome = String(res.outcome), text = String(res.text ?? "");
  if (outcome === "timeout") await deps.notifyPm(task, `[调度引擎] ${task.id} ${text}`).catch(deps.lost("挂池超时通知没发出去（台账已记撤回）"));
  return { step: `pool_${outcome}`, detail: text };
}
