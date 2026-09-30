/**
 * Body of the one-shot launchd deploy job (`bun src/scheduler.ts --deploy-job <request.json>`). It holds the maintenance lease
 * for the whole deploy, the same lease `update` and scheduler passes take, so a deploy and an update can never overlap; it
 * writes lease.json (so the scheduler can see it alive) and result.json before letting the lease go. `started` makes a second
 * launch of the same request a no-op. Tests: tests/scheduler-deploy-worker.test.ts.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readDeployJob } from "./scheduler-deploy-job.js";
import { runDeploySteps, type StepsOutcome } from "./scheduler-deploy-steps.js";
import { acquireMaintenance } from "./scheduler-maintenance.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { runBounded } from "./run-bounded.js";

export interface WorkerDeps {
  run?: typeof runBounded;
  acquire?: typeof acquireMaintenance;
  now?: () => number;
  uid?: number;
  /** How long to wait for the running scheduler pass to yield the lease. */
  lockWaitMs?: number;
}

export async function runDeployJob(requestPath: string, deps: WorkerDeps = {}): Promise<StepsOutcome | null> {
  const job = readDeployJob(requestPath), dir = dirname(requestPath), now = deps.now ?? Date.now;
  try { mkdirSync(join(dir, "started"), { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    console.error(`deploy job ${job.label}: launched again after start; not rerunning`);
    return null;
  }
  const write = (o: StepsOutcome) => writeJsonAtomicSync(join(dir, "result.json"), { intentId: job.intentId, mergeSha: job.mergeSha,
    ok: o.ok, summary: o.summary, relay: o.relay, head: o.head, steps: o.steps, endedAt: now() }, { mode: 0o600 });
  const lease = await (deps.acquire ?? acquireMaintenance)("deploy", { waitMs: deps.lockWaitMs ?? 10 * 60_000 });
  if (!lease) {
    const o: StepsOutcome = { ok: false, summary: "拿不到维护租约（update 在跑或半截），什么都没做", steps: [], relay: "not_needed", head: null };
    write(o);
    return o;
  }
  try {
    writeJsonAtomicSync(join(dir, "lease.json"), { path: lease.path, token: lease.token, pid: process.pid, at: now() }, { mode: 0o600 });
    let outcome: StepsOutcome;
    try {
      outcome = await runDeploySteps({ repoDir: job.repoDir, mergeSha: job.mergeSha, relayArgv: job.relayArgv, restartLabels: job.restartLabels,
        env: job.env, uid: deps.uid ?? process.getuid?.() ?? 0, deadline: job.createdAt + job.timeoutMs }, deps.run ?? runBounded, () => lease.held(), now);
    } catch (e) {
      outcome = { ok: false, summary: `部署步骤异常：${(e as Error).message.slice(0, 300)}`, steps: [], relay: "not_needed", head: null };
    }
    write(outcome); // before the lease goes: once the lease is free, a result is already on disk
    return outcome;
  } finally { lease.release(); }
}
