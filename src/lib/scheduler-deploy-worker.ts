/** A one-shot launchd job owns the bounded deployment child, independently of all four daemons. */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readDeployJob } from "./scheduler-deploy-job.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { runBounded } from "./run-bounded.js";

export async function runDeployJob(requestPath: string, command: typeof runBounded = runBounded): Promise<void> {
  const job = readDeployJob(requestPath), dir = dirname(requestPath);
  // A reused launchd invocation cannot run the command twice even if the scheduler died before receiving submit's reply.
  mkdirSync(join(dir, "started"), { mode: 0o700 });
  const result = await command(job.argv, { cwd: job.cwd, timeoutMs: job.timeoutMs, env: { ...job.env,
    CLAUDESTRA_SCHEDULER_SERVICE: "", DISCORD_CHANNEL_ID: "", GIT_TERMINAL_PROMPT: "0",
    CLAUDESTRA_DEPLOY_INTENT: job.intentId,
    CLAUDESTRA_MERGE_SHA: job.mergeSha, CLAUDESTRA_PR_URL: job.prRef, CLAUDESTRA_TASK_ID: job.taskId } });
  writeJsonAtomicSync(join(dir, "result.json"), { intentId: job.intentId, mergeSha: job.mergeSha,
    code: result.code, timedOut: result.timedOut, endedAt: Date.now(), stderr: result.stderr.slice(-4000) }, { mode: 0o600 });
}
