/** The service reads ledger snapshots and delegates all writes to manager's guarded ledger CLI. */
import type { Database } from "bun:sqlite";
import { resolveBunPath } from "./bun-path.js";
import { SRC_DIR } from "./repo-root.js";
import { runManagerProcess } from "./run-manager.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { mergeExternal } from "./scheduler-merge-external.js";
import { driveMerge, type MergeExternal } from "./scheduler-merge-driver.js";
import { getMergeRun, mergeRunDrift, type MergeRun, type MergePhase } from "./scheduler-merge.js";
import { acquireMaintenance, SchedulerStopped } from "./scheduler-maintenance.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

const schedulerManager: Manager = (...args) => runManagerProcess(args, {
  bunPath: resolveBunPath(), managerPath: `${SRC_DIR}/manager.ts`,
  env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "1" }, timeoutMs: 120_000,
});

const requireOk = (result: Record<string, unknown>, what: string): Record<string, unknown> => {
  if (result.ok !== true) throw new Error(`${what}: ${String(result.error ?? "manager failed")}`);
  return result;
};

/** One project is serial; journal rows plus project merge lock survive a daemon restart. */
export async function schedulerMergeTick(db: Database, config: SchedulerConfig, manager: Manager = schedulerManager,
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

async function mergeTick(db: Database, config: SchedulerConfig, manager: Manager,
  externalFactory: (project: SchedulerConfig["projects"][string]) => MergeExternal, assertActive: () => void): Promise<number> {
  let handled = 0;
  for (const [project, policy] of Object.entries(config.projects)) {
    const intents = db.query(`SELECT id, status FROM scheduler_intents WHERE project=? AND action='merge'
      AND status IN ('pending','submitted') ORDER BY eventSeq`).all(project) as { id: string; status: string }[];
    for (const intent of intents) {
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
      const drift = ["merged", "unknown", "resolved", "await_review"].includes(run.phase) ? null : mergeRunDrift(db, run);
      if (drift) {
        requireOk(await manager("ledger", "scheduler-merge-step", intent.id, "--from", run.phase, "--to", "unknown",
          "--rev", String(run.rev), "--receipt", drift), "freeze drifted merge run");
      } else if (run.phase === "merged") {
        // Settling frees the project merge slot; the task stays in `merge` until the PM deploys and moves it to live by hand.
        requireOk(await manager("ledger", "scheduler-settle", intent.id, "--from", "submitted", "--to", "done",
          "--receipt", `merge:${run.mergeSha}; 待 PM 部署`), "settle merge intent");
      } else if (!["unknown", "resolved", "await_review"].includes(run.phase)) {
        const advance = async (from: MergePhase, to: MergePhase, rev: number, receipt?: string, mergeSha?: string, newHead?: string) => {
          const args = ["ledger", "scheduler-merge-step", intent.id, "--from", from, "--to", to, "--rev", String(rev)];
          if (receipt) args.push("--receipt", receipt);
          if (mergeSha) args.push("--merge-sha", mergeSha);
          if (newHead) args.push("--new-head", newHead);
          const result = requireOk(await manager(...args), "advance merge run");
          return result.run as MergeRun;
        };
        await driveMerge(run, externalFactory(policy), advance, assertActive);
      }
      handled++;
    }
  }
  return handled;
}
