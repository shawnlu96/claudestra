/** The service reads ledger snapshots and delegates all writes to manager's guarded ledger CLI. */
import type { Database } from "bun:sqlite";
import { resolveBunPath } from "./bun-path.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { mergeExternal } from "./scheduler-merge-external.js";
import { driveMerge, type MergeExternal } from "./scheduler-merge-driver.js";
import { getMergeRun, mergeRunDrift, type MergeRun, type MergePhase } from "./scheduler-merge.js";
import { getDeployRun } from "./scheduler-deploy.js";
import { acquireMaintenance, SchedulerStopped } from "./scheduler-maintenance.js";
import { encodeLease, SCHEDULER_LEASE_ENV, type SchedulerLease } from "./scheduler-lease-env.js";
import type { TickPace } from "./scheduler-yield.js";
import { mergeSlotTurn } from "./scheduler-merge-train-hold-slot.js";
import type { TrainStore } from "./scheduler-merge-train.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

/**
 * The ledger CLI under the scheduler identity. `lease` is the service's (singleton + maintenance): the child
 * re-checks them itself right before it writes, so a stop or a lost lease while it queued on the write lock writes nothing.
 * Without a lease the child refuses every write (lib/scheduler-lease-env.ts).
 */
export const schedulerManagerWith = (lease: SchedulerLease | undefined): Manager => (...args) => runManagerProcess(args, {
  bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
  env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "1", [SCHEDULER_LEASE_ENV]: encodeLease(lease) }, timeoutMs: 120_000,
});

const requireOk = (result: Record<string, unknown>, what: string): Record<string, unknown> => {
  if (result.ok !== true) throw new Error(`${what}: ${String(result.error ?? "manager failed")}`);
  return result;
};

/**
 * One project is serial; journal rows plus project merge lock survive a daemon restart. The caller supplies the manager:
 * this entry holds only the maintenance lease, and a service child needs both (the daemon goes through schedulerPass).
 */
export async function schedulerMergeTick(db: Database, config: SchedulerConfig, manager: Manager,
  externalFactory: (project: SchedulerConfig["projects"][string]) => MergeExternal = mergeExternal,
  assertOwner: () => void = () => {}): Promise<number> {
  if (!config.enabled) return 0;
  const lock = await acquireMaintenance("scheduler");
  if (!lock) return 0;
  const assertActive = () => { assertOwner(); if (!lock.held()) throw new SchedulerStopped("scheduler lost maintenance lease"); };
  const call = async (...args: string[]) => { assertActive(); const r = await manager(...args); assertActive(); return r; };
  try { return await mergeTick(db, config, call, externalFactory, assertActive); }
  finally { lock.release(); }
}

/** The merge pass itself; the caller holds the maintenance lease and passes a manager already guarded by assertActive. */
export async function mergeTick(db: Database, config: SchedulerConfig, manager: Manager,
  externalFactory: (project: SchedulerConfig["projects"][string]) => MergeExternal, assertActive: () => void, pace?: TickPace, trains?: TrainStore | null): Promise<number> {
  let handled = 0;
  for (const [project, policy] of Object.entries(config.projects)) {
    const intents = db.query(`SELECT id, status FROM scheduler_intents WHERE project=? AND action='merge'
      AND status IN ('pending','submitted') ORDER BY eventSeq`).all(project) as { id: string; status: string }[];
    for (const intent of intents) {
      if (pace?.yieldNow()) return handled; // 合并日志落盘可跨轮续，让出只挑意图之间
      if (intent.status === "pending") {
        requireOk(await manager("ledger", "scheduler-settle", intent.id, "--from", "pending", "--to", "submitted",
          "--receipt", "merge controller claimed"), "claim merge intent");
      }
      let run = getMergeRun(db, intent.id);
      if (!run) {
        const r = await manager("ledger", "scheduler-merge-begin", intent.id,
          "--required-checks", policy.requiredChecks.join(","));
        if (r.ok !== true) {
          if (r.code === "busy") throw new Error(`begin merge run: ${String(r.error)}`);
          const why = `合并预检失败：${String(r.error ?? "unknown").replace(/\s+/g, " ").slice(0, 450)}`;
          requireOk(await manager("ledger", "scheduler-settle", intent.id, "--from", "submitted", "--to", "unknown",
            "--receipt", why), "hold rejected merge intent");
          handled++;
          continue;
        }
        run = r.run as MergeRun;
      }
      const settle = async (r: MergeRun) => requireOk(await manager("ledger", "scheduler-settle", intent.id, "--from", "submitted", "--to", "done",
        "--receipt", `merge:${r.mergeSha}; 待 PM 部署`), "settle merge intent");
      const drift = ["merged", "unknown", "resolved", "await_review"].includes(run.phase) ? null : mergeRunDrift(db, run);
      if (drift) {
        requireOk(await manager("ledger", "scheduler-merge-step", intent.id, "--from", run.phase, "--to", "unknown",
          "--rev", String(run.rev), "--receipt", drift), "freeze drifted merge run");
      } else if (run.phase === "merged" && (policy.deploy || getDeployRun(db, intent.id))) {
        // lib/scheduler-deploy-tick.ts deploys it; the intent keeps the project merge slot until that deploy ends, even if
        // `deploy` was taken out of the config meanwhile (the journal, not the config, says a job may still be running).
      } else if (run.phase === "merged") {
        // Settling frees the project merge slot; the task stays in `merge` until the PM deploys and moves it to live by hand.
        await settle(run);
      } else if (!["unknown", "resolved", "await_review"].includes(run.phase)) {
        const advance = async (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) => {
          const args = ["ledger", "scheduler-merge-step", intent.id, "--from", from, "--to", to, "--rev", String(rev)];
          if (receipt) args.push("--receipt", receipt);
          if (mergeSha) args.push("--merge-sha", mergeSha);
          if (newHead) args.push("--new-head", newHead);
          const result = requireOk(await manager(...args), "advance merge run");
          return result.run as MergeRun;
        };
        const after = await mergeSlotTurn(db, run, advance, (r) => driveMerge(r, externalFactory(policy), advance, assertActive), trains); // i28-MT1f2f2: slot lent to a live train
        if (after.phase === "merged" && !policy.deploy) await settle(after); // i28-MT1f2: free the slot before this pass's auto tick plans the next merge
      }
      handled++;
    }
  }
  return handled;
}
