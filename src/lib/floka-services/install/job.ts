import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { claimLaunchdJob, launchdJobEnv, removeLaunchdJob, submitLaunchdJob } from "../../launchd-oneshot.js";
import type { runBounded } from "../../run-bounded.js";
import { realRun } from "./host.js";
import type { RunnerRequestId } from "./runner.js";

export function maintenanceJobLabel(id: string): string {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid maintenance job id");
  return `ai.floka.maintenance.${id}`;
}
export const serviceJobCommand: typeof runBounded = async (argv, opts) => {
  const r = await realRun(argv, opts.timeoutMs);
  return { ...r, timedOut: r.code === null };
};
const domain = () => `gui/${process.getuid?.() ?? -1}`;
const jobDir = (root: string, id: string) => join(root, "part-jobs", id);

/** Same claim and bootstrap mechanism as deployment; repeated submission never launches another runner. */
export async function submitPartJob(root: string, id: RunnerRequestId, command = serviceJobCommand): Promise<void> {
  const label = maintenanceJobLabel(id), dir = jobDir(root, id);
  if (!claimLaunchdJob(dir)) throw new Error("Maintenance job already submitted");
  await submitLaunchdJob({ label, dir, cwd: root,
    argv: [process.execPath, "--no-env-file", "--config=/dev/null", new URL("./runner.ts", import.meta.url).pathname, id],
    env: launchdJobEnv(process.env, ["FLOKA_STATE_DIR", "FLOKA_RUNTIME_DIR", "FLOKA_SANDBOX", "FLOKA_SANDBOX_ROOT",
      "FLOKA_SANDBOX_DENY_DIRS", "FLOKA_SANDBOX_DENY_PORTS"]) }, domain(), command);
}

export function claimPartExecution(root: string, id: string, xpcServiceName: string | undefined): void {
  const label = maintenanceJobLabel(id);
  if (xpcServiceName !== label) throw new Error("XPC_SERVICE_NAME does not match the approved maintenance job");
  if (!claimLaunchdJob(join(jobDir(root, id), "started"))) throw new Error("Maintenance job already started");
}

/** The result is durable before self-bootout can reap this process and its children. */
export async function finishPartJob(root: string, id: string, command = serviceJobCommand): Promise<void> {
  const label = maintenanceJobLabel(id);
  try { unlinkSync(join(jobDir(root, id), "job.plist")); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!await removeLaunchdJob(label, domain(), command)) throw new Error("Maintenance result retained; temporary job cleanup failed");
}
