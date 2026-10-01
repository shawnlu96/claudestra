/**
 * Production wiring of card retirement for one service pass. The ledger manager is the pass's own (scheduler identity, lease-aware);
 * archive / kill run as plain manager children carrying the same leases, so a pass that stops or loses its lease mid-card kills
 * nothing further. Every git call and PM notice is checked against `active` right before and after it runs.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolveBunPath } from "./bun-path.js";
import { statePath } from "./paths.js";
import { notifyProjectPm } from "./pm-notify.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import { SchedulerStopped, whileOwned } from "./scheduler-maintenance.js";
import { schedulerRetireTick, type RetireDeps } from "./scheduler-retire.js";
import { git } from "./scheduler-review-worktree.js";
import type { TickPace } from "./scheduler-yield.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

export function retireDeps(db: Database, ledger: Manager, active: () => void, lease: SchedulerLease | undefined): RetireDeps {
  const agent: Manager = async (...args) => {
    const r = await whileOwned(active, () => runManagerProcess(args, { bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
      env: { ...process.env, DISCORD_CHANNEL_ID: "", [SCHEDULER_LEASE_ENV]: encodeLease(lease) }, timeoutMs: 180_000 }));
    if (r.code === "lease-lost") throw new SchedulerStopped(`manager ${args[0]}: ${String(r.error)}`); // the service stopping is not a card failure
    return r;
  };
  const alive = (): boolean => {
    try { active(); return true; } catch { return false; /* a failed liveness check means "not provably ours": send nothing */ }
  };
  return {
    ledger, agent, worktreeRoot: statePath("worktrees"), exists: existsSync,
    git: (args) => whileOwned(active, () => git(args)),
    notifyPm: (task, text) => whileOwned(active, () => notifyProjectPm(db, task.project, text, { fromName: "scheduler", stillActive: alive })),
  };
}

/** The pass's retire step: every project scheduler.json lists, auto or not (manual cards keep scheduler-bound sessions too). */
export async function retireStep(db: Database, config: SchedulerConfig, ledger: Manager, active: () => void,
  lease: SchedulerLease | undefined, pace?: TickPace): Promise<{ taskId: string; error: string }[]> {
  return (await schedulerRetireTick(db, Object.keys(config.projects), retireDeps(db, ledger, active, lease), pace)).failed;
}
