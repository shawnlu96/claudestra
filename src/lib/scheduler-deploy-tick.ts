/**
 * Scheduler side of automatic deploy (T68g). For a project with `deploy` in scheduler.json, a merge run that reached `merged`
 * is deployed through the journal in lib/scheduler-deploy.ts; afterwards the card, now live, gets `ledger verify`.
 * Rules this file keeps: submit only right after assertActive with a fresh drift check; leave `running` only on a checked
 * "job gone"; past the deadline a live job is booted out and judged on a later tick, never declared dead in the same breath.
 * Tests: tests/scheduler-deploy-tick.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { SchedulerConfig } from "./scheduler-config.js";
import { getMergeRun } from "./scheduler-merge.js";
import { deployDrift, deployInFlight, getDeployRun, type DeployRun, type DeployStep } from "./scheduler-deploy.js";
import type { DeployJobs } from "./scheduler-deploy-job.js";
import { getMeta, getTask, getEventByDedup } from "./ledger-store.js";
import type { TickPace } from "./scheduler-yield.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface DeployTickDeps { manager: Manager; jobs: DeployJobs; assertActive: () => void; now: () => number }

/** A daemon that just restarted can fail a probe for a moment; verify is retried this long before its failure is recorded. */
export const VERIFY_WINDOW_MS = 10 * 60_000;
const VERIFY_EVERY_MS = 60_000;
const lastVerify = new Map<string, number>();

const requireOk = (r: Record<string, unknown>, what: string): Record<string, unknown> => {
  if (r.ok !== true) throw new Error(`${what}: ${String(r.error ?? "manager failed")}`);
  return r;
};
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 450);

async function step(d: DeployTickDeps, run: DeployRun, s: Omit<DeployStep, "intentId" | "from" | "rev">): Promise<DeployRun> {
  const args = ["ledger", "scheduler-deploy-step", run.intentId, "--from", run.phase, "--to", s.to, "--rev", String(run.rev)];
  if (s.receipt) args.push("--receipt", oneLine(s.receipt));
  if (s.label) args.push("--label", s.label);
  if (s.outcome) args.push("--outcome", s.outcome);
  if (s.liveness) args.push("--liveness", s.liveness);
  return requireOk(await d.manager(...args), `deploy ${run.phase}→${s.to}`).run as DeployRun;
}

/** claimed: the at-most-once job directory decides between "never submitted" and "submitted, record it". */
async function driveClaimed(d: DeployTickDeps, db: Database, run: DeployRun, target: NonNullable<SchedulerConfig["projects"][string]["deploy"]>,
  repoDir: string): Promise<void> {
  const seen = await d.jobs.observe(run);
  if (seen) return void await step(d, run, { to: "running", label: seen.label, receipt: "重启后接上已提交的部署任务" });
  const drift = deployDrift(db, run.intentId);
  if (drift) return void await step(d, run, { to: "unknown", outcome: "failed", liveness: "dead", receipt: `提交前流程已变，没提交：${drift}` });
  d.assertActive();
  try {
    const label = await d.jobs.submit(run, repoDir, target);
    await step(d, run, { to: "running", label, receipt: `已提交部署任务 ${label}` });
  } catch (e) {
    const after = await d.jobs.observe(run);
    if (after && after.liveness !== "dead") return; // may have started after all: next tick records it as running
    if (after?.result) return void await step(d, run, { to: "running", label: after.label, receipt: "提交报错但任务已跑完，按运行中接上" });
    await step(d, run, { to: "unknown", outcome: "failed", liveness: "dead", receipt: `部署任务没起来：${(e as Error).message}` });
  }
}

async function driveRunning(d: DeployTickDeps, run: DeployRun): Promise<void> {
  const seen = await d.jobs.observe(run);
  if (!seen) {
    // The job directory is gone: only a booted-out label lets us say nothing can still be running from it.
    if (run.label && await d.jobs.remove(run.label)) await step(d, run, { to: "unknown", outcome: "unknown", liveness: "dead", receipt: "部署任务目录丢失，已卸下任务" });
    return;
  }
  if (seen.liveness !== "dead") {
    if (seen.liveness === "alive" && d.now() > seen.deadline) {
      d.assertActive();
      await d.jobs.remove(seen.label); // SIGTERM; its bounded children die with it. Judged dead on a later tick.
    }
    return;
  }
  if (seen.result?.ok) await step(d, run, { to: "deployed", outcome: "success", liveness: "dead", receipt: seen.result.summary || "部署完成" });
  else {
    await step(d, run, { to: "unknown", outcome: seen.result ? "failed" : "unknown", liveness: "dead",
      receipt: seen.result ? `部署失败：${seen.result.summary}` : seen.corrupt ?? "部署任务已结束但没有结果" });
  }
  await d.jobs.remove(seen.label); // unload the finished job; best effort, doctor lists leftovers
}

/** live card with a deployed journal: dry-run first; record only a pass, or the failure once the window is over. */
async function driveVerify(d: DeployTickDeps, db: Database, run: DeployRun): Promise<void> {
  const task = getTask(db, run.taskId), dedup = `scheduler:${run.intentId}:verify`;
  if (task?.stage !== "live" || getEventByDedup(db, dedup)) return;
  const at = lastVerify.get(run.intentId);
  if (at !== undefined && d.now() - at < VERIFY_EVERY_MS) return;
  lastVerify.set(run.intentId, d.now());
  const late = d.now() - (run.deployedAt ?? 0) > VERIFY_WINDOW_MS;
  if (!late) {
    const dry = await d.manager("ledger", "verify", run.taskId, "--dry-run");
    if (dry.ok !== true || dry.result !== "pass") return;
  }
  const r = await d.manager("ledger", "verify", run.taskId, "--dedup", dedup);
  if (r.code === "invalid" || r.code === "forbidden") throw new Error(`ledger verify ${run.taskId}: ${String(r.error)}`);
  lastVerify.delete(run.intentId);
}

export async function deployTick(db: Database, config: SchedulerConfig, d: DeployTickDeps, pace?: TickPace): Promise<number> {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()) return 0;
  let handled = 0;
  for (const [project, policy] of Object.entries(config.projects)) {
    if (!policy.deploy) continue;
    const intents = db.query(`SELECT id FROM scheduler_intents WHERE project=? AND action='merge' AND status='submitted' ORDER BY eventSeq`)
      .all(project) as { id: string }[];
    for (const { id } of intents) {
      if (pace?.yieldNow()) return handled;
      if (getMergeRun(db, id)?.phase !== "merged") continue;
      let run = getDeployRun(db, id);
      if (!run) {
        const drift = deployDrift(db, id);
        if (drift && getMeta(db, project).queueFrozen.frozen) continue; // frozen: wait for the PM, keep the merge slot
        if (drift) {
          requireOk(await d.manager("ledger", "scheduler-settle", id, "--from", "submitted", "--to", "done", "--receipt",
            `merge:${getMergeRun(db, id)?.mergeSha}; 不自动部署（${drift}），待 PM 部署`), "settle undeployable merge");
          continue;
        }
        if (deployInFlight(db)) continue;
        run = requireOk(await d.manager("ledger", "scheduler-deploy-begin", id), "begin deploy").run as DeployRun;
      }
      if (run.phase === "claimed") await driveClaimed(d, db, run, policy.deploy, policy.repoDir);
      else if (run.phase === "running") await driveRunning(d, run);
      handled++;
    }
    const deployed = db.query(`SELECT d.* FROM scheduler_deploys d JOIN tasks t ON t.id=d.taskId
      WHERE d.project=? AND d.phase='deployed' AND t.stage='live' ORDER BY d.deployedAt`).all(project) as DeployRun[];
    for (const run of deployed) {
      if (pace?.yieldNow()) return handled;
      await driveVerify(d, db, run);
      handled++;
    }
  }
  return handled;
}
