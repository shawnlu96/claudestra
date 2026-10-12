import type { Database } from "bun:sqlite";
import type { SchedulerConfig } from "./scheduler-config.js";
import { observeDedupKey, recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { getEventByDedup } from "./ledger-store.js";
import { notifyProjectPm } from "./pm-notify.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip.js";
import { rotateAfter, type TickPace } from "./scheduler-yield.js";
import type { runBounded } from "./run-bounded.js";
import { readReconcileFacts, reconcileGitProof, reconcileTaskIds } from "./scheduler-deploy-reconcile-facts.js";

interface ReconcileDeps {
  manager: (...args: string[]) => Promise<Record<string, unknown>>;
  assertActive: () => void;
  now: () => number;
  policy?: RecoveryPolicyPort;
  command?: typeof runBounded;
  notifyPm?: (project: string, text: string) => Promise<void>;
  log?: (text: string) => void;
}
const reported = new WeakMap<Database, Set<string>>();

/** Diagnostics write no ledger events: one line per card/reason per reader lifetime, including after a reason recurs. */
function report(db: Database, deps: ReconcileDeps, taskId: string, reason: string): void {
  let seen = reported.get(db);
  if (!seen) { seen = new Set(); reported.set(db, seen); }
  const key = JSON.stringify([taskId, reason]);
  if (seen.has(key)) return;
  seen.add(key);
  (deps.log ?? console.info)(`[deploy-reconcile] ${taskId}: ${reason}`);
}

async function inform(db: Database, deps: ReconcileDeps, project: string, taskId: string, version: string): Promise<void> {
  deps.assertActive();
  const text = `[部署补记观察] ${taskId} 本会补记部署 ${version.slice(0, 12)} 并推到 live；请核部署来源及 git 祖先关系后启用 deployReconcile`;
  if (deps.notifyPm) await deps.notifyPm(project, text);
  else await notifyProjectPm(db, project, text, { fromName: "scheduler", stillActive: () => {
    try { deps.assertActive(); return true; } catch { return false; /* lost lease: never send a late notice */ }
  } });
  deps.assertActive();
}

/** Additive after deployTick: no deploy job, queue mutation, workflow change, verify or new credentials. */
export async function deployReconcileTick(db: Database, config: SchedulerConfig, deps: ReconcileDeps, pace?: TickPace):
  Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [];
  const candidates = Object.entries(config.projects).flatMap(([project, schedule]) => {
    const mode = (deps.policy ?? recoveryPolicy)(project, "deployReconcile").mode;
    return mode === "off" ? [] : reconcileTaskIds(db, project).map((taskId) => ({ project, schedule, mode, taskId, key: `${project}/${taskId}` }));
  });
  if (!candidates.length) return failed;
  let last: string | undefined;
  for (const { project, schedule, mode, taskId, key: cursorKey } of rotateAfter(candidates, (c) => c.key, pace?.cursor.deployReconcile)) {
    if (pace?.skipTask?.(taskId) || schedulerV2SkipTask(db, taskId)) continue;
    try {
      deps.assertActive();
      const current = readReconcileFacts(db, taskId, deps.now());
      if ("reason" in current) { report(db, deps, taskId, current.reason); continue; }
      const { task, merge, source } = current.facts;
      const key = observeDedupKey({ project, mechanism: "deployReconcile", target: taskId, actionKey: "reconcile" });
      if (mode === "observe" && getEventByDedup(db, key)) continue;
      if (pace?.yieldNow()) {
        if (pace.budgetEnded?.() && last !== undefined) pace.cursor.deployReconcile = last;
        return failed;
      }
      last = cursorKey;
      const proof = await reconcileGitProof(schedule.repoDir, merge.mergeSha!, String(source.data.version), deps.assertActive, deps.command);
      if ("reason" in proof) { report(db, deps, taskId, proof.reason); continue; }
      deps.assertActive();
      const result = await deps.manager("ledger", "scheduler-deploy-reconcile", taskId, "--rev", String(task.rev),
        "--merge-intent", merge.intentId, "--merge-rev", String(merge.rev), "--source-seq", String(source.seq));
      deps.assertActive();
      if (result.code === "lease-lost") throw new SchedulerStopped("deploy reconcile lost lease");
      if (result.ok !== true) { report(db, deps, taskId, String(result.error ?? result.code)); continue; }
      if (result.mode === "observe" && result.recorded === true) await inform(db, deps, project, taskId, String(result.version));
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      const error = (e as Error).message;
      report(db, deps, taskId, error);
      // The observation already committed: a lost PM notice is logged once, never retried on every tick.
      failed.push({ taskId, error });
    }
  }
  if (pace) pace.cursor.deployReconcile = undefined;
  return failed;
}
