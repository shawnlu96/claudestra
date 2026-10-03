import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { v2ObjectDigest } from "./shared-ledger-contract-v2.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { acquireMaintenance } from "./scheduler-maintenance.js";
import { runBounded } from "./run-bounded.js";
import { runDeploySteps } from "./scheduler-deploy-steps.js";
import { readSchedulerCentralDeployment, schedulerCentralStepRunner } from "./scheduler-central-deploy.js";
import { SchedulerCentralJournal } from "./scheduler-central-journal.js";
import { executeSchedulerCentral, type SchedulerCentralOutcome } from "./scheduler-central.js";
import type { SchedulerCentralClient, SchedulerCentralRuntime } from "./scheduler-central-context.js";

export interface SchedulerCentralWorkerDeps {
  /** Construct a fresh authenticated client from LOCAL configuration. No serialized callback, bearer or private key. */
  openClient(connectionId: string): Promise<{ instanceId: string; client: SchedulerCentralClient }>;
  acquire?: typeof acquireMaintenance;
  run?: typeof runBounded;
  now?: () => number;
  uid?: number;
  lockWaitMs?: number;
}

/** X12 routes --deploy-job here for shared execution jobs. Reuses the existing maintenance lock and deploy commands.
 * Its runner adapter gates every command independently, including commands after a daemon reload or a failed restart.
 */
export async function runSchedulerCentralDeployJob(requestPath: string, deps: SchedulerCentralWorkerDeps): Promise<SchedulerCentralOutcome> {
  const job = readSchedulerCentralDeployment(requestPath), dir = dirname(requestPath), c = job.central.context;
  const now = deps.now ?? Date.now;
  const connection = await deps.openClient(job.central.connectionId);
  const lock = await (deps.acquire ?? acquireMaintenance)("deploy", { waitMs: deps.lockWaitMs ?? 10 * 60_000 });
  if (!lock) return { state: "blocked", resourceHeld: true, reported: false, replayed: false, reason: "local_lock_unavailable", result: null };
  const runtime: SchedulerCentralRuntime = { ...connection, lock };
  const journal = new SchedulerCentralJournal(join(dir, "central-outbox"));
  try {
    writeJsonAtomicSync(join(dir, "lease.json"), { path: lock.path, token: lock.token, pid: process.pid, at: now() }, { mode: 0o600 });
    const outcome = await executeSchedulerCentral(c, runtime, journal, async entry => {
      // Honor the independent job's existing at-most-once marker, including a launch by an older worker.
      // An existing marker has no trustworthy outcome: the parent remains unknown until reconciliation.
      mkdirSync(join(dir, "started"), { mode: 0o700 });
      const step = schedulerCentralStepRunner(c, runtime, journal, entry, deps.run ?? runBounded);
      const occurrences = new Map<string, number>();
      // Existing runDeploySteps passes one command per step. Stable argv digests identify steps across process restarts;
      // X12 can instead call step(name, argv, options) at its named exec boundary without changing center semantics.
      const run: typeof runBounded = (argv, options) => {
        const key = v2ObjectDigest(argv), occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        return step(`${key}:${occurrence}`, argv, options);
      };
      const result = await runDeploySteps({ repoDir: job.repoDir, mergeSha: job.mergeSha, relayArgv: job.relayArgv,
        restartLabels: job.restartLabels, env: job.env, uid: deps.uid ?? process.getuid?.() ?? 0,
        deadline: job.createdAt + job.timeoutMs }, run, () => lock.held(), now);
      writeJsonAtomicSync(join(dir, "local-steps.json"), result, { mode: 0o600 });
      return { state: result.ok ? "succeeded" : "failed", head: result.head, artifactIds: [],
        summary: result.ok ? "Deployment completed" : "Deployment stopped; details remain at home" };
    }, now);
    writeJsonAtomicSync(join(dir, "result.json"), { intentId: job.intentId, mergeSha: job.mergeSha, taskId: job.taskId,
      central: job.central, ...outcome, ok: outcome.state === "succeeded", summary: outcome.reason, endedAt: now() }, { mode: 0o600 });
    return outcome;
  } finally { lock.release(); }
}
