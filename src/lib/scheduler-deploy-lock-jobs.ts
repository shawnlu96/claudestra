/** Retry only jobs which proved deferred. Keep the original journal claim and a durable retry marker across restarts. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { statePath } from "./paths.js";
import { readDeployJob, type DeployJobs } from "./scheduler-deploy-job.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import type { DeployRun } from "./scheduler-deploy.js";

export const deployJobDir = (run: Pick<DeployRun, "intentId">, root = statePath("scheduler-deploy")): string =>
  join(root, createHash("sha256").update(run.intentId).digest("hex"));
interface Retry { firstAt: number; pending: boolean; job: ReturnType<typeof readDeployJob> }
type View = Awaited<ReturnType<DeployJobs["observe"]>>;
export interface DeferredDeps { jobs: DeployJobs; manager: (...args: string[]) => Promise<Record<string, unknown>>; now: () => number; assertActive(): void }
const requireOk = (r: Record<string, unknown>) => { if (r.ok !== true) throw new Error("部署台账写入失败"); };

export async function deferredDeployTick(d: DeferredDeps, run: DeployRun, seen: View, root?: string): Promise<boolean> {
  const dir = deployJobDir(run, root), marker = `${dir}.deferred.json`, old = readJsonStateSync(marker);
  const prior = old.status === "ok" ? old.data as Retry : null;
  const samples = readJsonStateSync(`${dir}.machine-events.json`);
  if (samples.status === "ok") {
    d.assertActive();
    requireOk(await d.manager("ledger", "scheduler-center-deploy", run.taskId, "--op", "machine", "--intent", run.intentId));
  }
  if (seen?.liveness !== "dead" && seen !== null) return false;
  if (seen?.result && seen.result.status !== "deferred") {
    rmSync(marker, { force: true }); return false;
  }
  if (seen?.result?.status !== "deferred" && !prior?.pending) return false;
  if (prior?.pending && seen && !seen.result && existsSync(join(dir, "started"))) {
    rmSync(marker, { force: true }); return false; // The new attempt started: lost outcome is unknown, never another retry.
  }
  const retry: Retry = prior ?? { firstAt: d.now(), pending: true, job: readDeployJob(join(dir, "request.json")) };
  const history = samples.status === "ok" && Array.isArray(samples.data) ? samples.data as { status: string; at: number }[] : [];
  const acquired = history.findLastIndex((s) => s.status === "acquired");
  const firstDeferred = history.slice(acquired + 1).find((s) => s.status === "deferred" && Number.isFinite(s.at));
  if (acquired >= 0 && firstDeferred) retry.firstAt = firstDeferred.at;
  if (d.now() - retry.firstAt >= 3_600_000) {
    d.assertActive();
    requireOk(await d.manager("ledger", "scheduler-pm-todo", run.taskId, "--kind", "deploy_deferred", "--text", "部署连续等整机锁已满 60 分钟",
      "--dedup", `deploy-deferred:${run.intentId}:${retry.firstAt}`));
  }
  d.assertActive();
  if (!(await d.jobs.remove(seen?.label ?? run.label!))) return true;
  writeJsonAtomicSync(marker, { ...retry, pending: true }, { mode: 0o600 });
  rmSync(dir, { recursive: true, force: true });
  const j = retry.job;
  d.assertActive();
  await d.jobs.submit(run, j.repoDir, { relayArgv: j.relayArgv ?? undefined, restartLabels: j.restartLabels, timeoutMs: j.timeoutMs }, j.deploySha);
  writeJsonAtomicSync(marker, { ...retry, pending: false }, { mode: 0o600 });
  return true;
}
