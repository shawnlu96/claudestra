import { v2ObjectDigest, literal, object, id, fail, type Infer } from "./shared-ledger-contract-v2.js";
import { readJsonStateSync } from "./state-file.js";
import { readDeployJob, type DeployJob } from "./scheduler-deploy-job.js";
import { assertLocalOwner, parseSchedulerCentralContext, type SchedulerCentralContext, type SchedulerCentralRuntime } from "./scheduler-central-context.js";
import { checkSchedulerCentral } from "./scheduler-central-gate.js";
import { SchedulerCentralJournal, type SchedulerCentralJournalEntry } from "./scheduler-central-journal.js";
import type { BoundedResult, runBounded } from "./run-bounded.js";

const parseCentralDeployment = object({ version: literal(1), connectionId: id, context: parseSchedulerCentralContext });
type CentralDeployment = Infer<typeof parseCentralDeployment>;

/** Bind the actual local deployment plan; only this digest crosses the center, never argv/env/paths themselves. */
export function schedulerCentralDeploymentDigest(job: DeployJob): string {
  return v2ObjectDigest({ mergeSha: job.mergeSha, repoDir: job.repoDir, relayArgv: job.relayArgv,
    restartLabels: job.restartLabels, timeoutMs: job.timeoutMs, env: job.env });
}

/** Spread into the LOCAL job request, not a central command. connectionId resolves credentials in the worker process. */
export function schedulerCentralDeployment(context: SchedulerCentralContext, connectionId: string): { central: CentralDeployment } {
  const central = parseCentralDeployment({ version: 1, context, connectionId });
  if (central.context.action !== "deploy") fail("invalid_field");
  return { central };
}

export function readSchedulerCentralDeployment(path: string): DeployJob & { central: CentralDeployment } {
  const job = readDeployJob(path), raw = readJsonStateSync(path);
  if (raw.status !== "ok") fail("invalid_field");
  const central = parseCentralDeployment((raw.data as Record<string, unknown>).central);
  if (central.context.action !== "deploy" || job.taskId !== central.context.taskId || job.intentId !== central.context.intentId
    || job.mergeSha !== central.context.head || central.context.authorizationBind.actionDigest !== schedulerCentralDeploymentDigest(job)) fail("invalid_field");
  return { ...job, central };
}

/** Step names are local and stable; hashing avoids the 128-character id limit and exposing local labels/paths. */
export function schedulerCentralStepOperationId(context: SchedulerCentralContext, step: string): string {
  if (!step || step.length > 200) fail("invalid_field");
  return `step-${v2ObjectDigest([context.operationId, step])}`;
}

/** The root intent stays submitted until the WHOLE job finishes. Only its operationId goes to the center. Step IDs and
 * per-step results stay local; X12 may add central step receipts in a future contract, never by overloading intent IDs.
 */
export function schedulerCentralStepRunner(context: SchedulerCentralContext, runtime: SchedulerCentralRuntime,
  journal: SchedulerCentralJournal, entry: SchedulerCentralJournalEntry, run: typeof runBounded) {
  let stopped = false;
  return async (step: string, argv: string[], options: Parameters<typeof runBounded>[1]): Promise<BoundedResult> => {
    if (stopped) fail("unknown_operation");
    const operationId = schedulerCentralStepOperationId(context, step);
    if (entry.steps.some(s => s.operationId === operationId)) { stopped = true; fail("unknown_operation"); }
    try { await checkSchedulerCentral(context, runtime); }
    catch (e) { stopped = true; throw e; }
    const record: SchedulerCentralJournalEntry["steps"][number] = { operationId, state: "started" };
    entry.steps.push(record);
    journal.write(entry);
    try {
      assertLocalOwner(context, runtime);
      const result = await run(argv, options);
      // Losing ownership or a timeout cannot prove what a process already did. No subsequent command may start.
      await checkSchedulerCentral(context, runtime);
      if (result.timedOut || result.code === null) fail("unknown_operation");
      record.state = result.code === 0 ? "succeeded" : "failed";
      journal.write(entry);
      return result;
    } catch (e) {
      stopped = true;
      record.state = "unknown";
      journal.write(entry);
      throw e;
    }
  };
}
