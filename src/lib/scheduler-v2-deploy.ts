/**
 * Stage 2 (S2M): the independent deploy job joins the center. Submit side: a route=central card's job request carries
 * `schedulerCentralDeployment` (X8); route=skip (migrating included) builds no job at all; route=local is stage 1 unchanged.
 * Worker side: a request with a `central` field runs X8's `runSchedulerCentralDeployJob`, which checks the center online before
 * and after every command; without `deps.central` it is blocked before any argv. Routes come from S2D's `schedulerV2Route`
 * through the port (S2F wires both sides); this module never decides a route itself. Off = every non-execution card is local,
 * every execution card skip: zero center requests. Tests: tests/shared-ledger-v2-stage2-deploy*.test.ts.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readDeployJob, type DeployJob, type DeploySubmitHook } from "./scheduler-deploy-job.js";
import { runDeployJob, type WorkerDeps } from "./scheduler-deploy-worker.js";
import type { StepsOutcome } from "./scheduler-deploy-steps.js";
import type { DeployRun } from "./scheduler-deploy.js";
import { readSchedulerCentralDeployment, schedulerCentralDeployment, schedulerCentralDeploymentDigest } from "./scheduler-central-deploy.js";
import { runSchedulerCentralDeployJob, type SchedulerCentralWorkerDeps } from "./scheduler-central-worker.js";
import type { SchedulerCentralContext } from "./scheduler-central-context.js";
import type { SchedulerCentralOutcome } from "./scheduler-central.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";

export type DeployV2Route = "local" | "skip" | "central";
export type DeployV2RouteFn = (taskId: string) => DeployV2Route;
export interface DeployV2Decision { taskId: string; intentId: string; route: DeployV2Route; outcome: "local" | "central" | "held"; reason: string }

/** Thrown by the submit hook before anything is written; the deploy tick records the run as never started. */
export class V2DeployHeld extends Error {
  constructor(readonly code: "migrating_or_skip" | "unavailable" | "invalid_deployment", message: string) { super(message); }
}

export interface DeploySubmitV2Port {
  route: DeployV2RouteFn;
  /** Optional: the central deploy context (action deploy, bound to the job's plan digest) and the local connection id
   *  that resolves credentials in the worker. Missing or null = `unavailable`, no center request, nothing written. */
  deployment?(run: DeployRun, job: DeployJob): Promise<{ context: SchedulerCentralContext; connectionId: string } | null>;
  /** Optional: observe-log sink for each decision (S2S log in S2F); missing = no record. */
  record?(decision: DeployV2Decision): void;
}

/** Hook for `deploymentJobs({ v2 })`. Route is read at submit time, never cached from when the run was claimed. */
export function schedulerV2DeploySubmit(port: DeploySubmitV2Port): DeploySubmitHook {
  return {
    async prepare(run, job) {
      const route = port.route(run.taskId);
      const decide = (outcome: DeployV2Decision["outcome"], reason: string) =>
        port.record?.({ taskId: run.taskId, intentId: run.intentId, route, outcome, reason });
      if (route === "local") { decide("local", "local"); return {}; }
      if (route !== "central") { decide("held", "skip"); throw new V2DeployHeld("migrating_or_skip", "v2 route skip: deploy job not built"); }
      const d = port.deployment ? await port.deployment(run, job) : null;
      if (!d) { decide("held", "unavailable"); throw new V2DeployHeld("unavailable", "v2 central deployment unavailable: deploy job not built"); }
      const c = d.context;
      if (c.action !== "deploy" || c.taskId !== job.taskId || c.intentId !== job.intentId || c.head !== job.mergeSha
        || c.authorizationBind.actionDigest !== schedulerCentralDeploymentDigest(job)) {
        decide("held", "invalid_deployment");
        throw new V2DeployHeld("invalid_deployment", "v2 central deployment does not bind this job");
      }
      decide("central", "central");
      return schedulerCentralDeployment(c, d.connectionId);
    },
  };
}

export interface DeployV2Deps extends WorkerDeps {
  /** Re-read when the job runs; absent = no stage-2 route check (stage 1). */
  route?: DeployV2RouteFn;
  /** X8 worker deps; absent = every central job is blocked before any command. */
  central?: SchedulerCentralWorkerDeps;
}

/** Worker deps for `runDeployJobV2`. A null client opener or route leaves that part out, which blocks central jobs. */
export function centralDeployDeps(openClient: SchedulerCentralWorkerDeps["openClient"] | null, route: DeployV2RouteFn | null,
  local: WorkerDeps = {}): DeployV2Deps {
  return { ...local, ...(route ? { route } : {}), ...(openClient ? { central: { ...local, openClient } } : {}) };
}

export type DeployV2Outcome =
  | { path: "local"; outcome: StepsOutcome | null }
  | { path: "central"; outcome: SchedulerCentralOutcome }
  | { path: "blocked"; central: boolean; reason: string };

/** Nothing ran. `started` keeps the request at-most-once; an earlier launch's marker or result is left untouched. */
function block(path: string, job: DeployJob, central: boolean, reason: string, now: () => number): DeployV2Outcome {
  const dir = dirname(path);
  try { mkdirSync(join(dir, "started"), { mode: 0o700 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return { path: "blocked", central, reason: "already_started" };
  }
  writeJsonAtomicSync(join(dir, "result.json"), { intentId: job.intentId, mergeSha: job.mergeSha, taskId: job.taskId, ok: false,
    state: "blocked", resourceHeld: true, reason, summary: `v2 部署挡下（${reason}），一条命令都没跑`, steps: [], endedAt: now() }, { mode: 0o600 });
  return { path: "blocked", central, reason };
}

/** `scheduler.ts --deploy-job` entry for stage 2: the `central` field picks X8, everything else the stage-1 worker. */
export async function runDeployJobV2(path: string, deps: DeployV2Deps = {}): Promise<DeployV2Outcome> {
  const raw = readJsonStateSync(path), now = deps.now ?? Date.now;
  const central = raw.status === "ok" && !!raw.data && typeof raw.data === "object" && "central" in (raw.data as object);
  if (!central) {
    const job = readDeployJob(path), route = deps.route?.(job.taskId) ?? "local";
    if (route !== "local") return block(path, job, false, `route_${route}`, now);
    return { path: "local", outcome: await runDeployJob(path, deps) };
  }
  if (!deps.central) return block(path, readDeployJob(path), true, "unavailable", now);
  const job = readSchedulerCentralDeployment(path), route = deps.route?.(job.taskId) ?? "central";
  if (route !== "central") return block(path, job, true, `route_${route}`, now);
  return { path: "central", outcome: await runSchedulerCentralDeployJob(path, deps.central) };
}
