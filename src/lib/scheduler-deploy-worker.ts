/** A one-shot launchd job owns the bounded deployment child, independently of all four daemons. */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readDeployJob, removeDeployLabel } from "./scheduler-deploy-job.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { runBounded } from "./run-bounded.js";

/** The job's last act is removing its own KeepAlive label; launchd SIGTERMs us then, after result.json is durable. */
async function retire(label: string, command: typeof runBounded): Promise<void> {
  if (!(await removeDeployLabel(label, command))) console.error(`deploy job: cannot remove ${label}; scheduler observe and doctor retry`);
}

/** `launchctl` is separate from `command` so tests can fake the deployment without faking launchd, and vice versa. */
export async function runDeployJob(requestPath: string, command: typeof runBounded = runBounded,
  launchctl: typeof runBounded = runBounded): Promise<void> {
  const job = readDeployJob(requestPath), dir = dirname(requestPath);
  // A reused launchd invocation cannot run the command twice even if the scheduler died before receiving submit's reply.
  try { mkdirSync(join(dir, "started"), { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      console.error(`deploy job ${job.label}: relaunched after start; removing own label without rerunning the command`);
      await retire(job.label, launchctl);
    }
    throw e;
  }
  const result = await command(job.argv, { cwd: job.cwd, timeoutMs: job.timeoutMs, env: { ...job.env,
    CLAUDESTRA_SCHEDULER_SERVICE: "", DISCORD_CHANNEL_ID: "", GIT_TERMINAL_PROMPT: "0",
    CLAUDESTRA_DEPLOY_INTENT: job.intentId,
    CLAUDESTRA_MERGE_SHA: job.mergeSha, CLAUDESTRA_PR_URL: job.prRef, CLAUDESTRA_TASK_ID: job.taskId } });
  writeJsonAtomicSync(join(dir, "result.json"), { intentId: job.intentId, mergeSha: job.mergeSha,
    code: result.code, timedOut: result.timedOut, endedAt: Date.now(), stderr: result.stderr.slice(-4000) }, { mode: 0o600 });
  await retire(job.label, launchctl);
}
