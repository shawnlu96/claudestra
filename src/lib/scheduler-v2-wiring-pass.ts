/**
 * S2F · the daemon's pass entry (scheduler.ts runScheduler). `schedulerV2Pass` runs the real `schedulerPass`; its first step
 * after the maintenance lease (the train tick hook) lands every switched-on execution feature's center view (S2P, so a card a
 * member created and the owner set to auto reaches paceCards in the same pass) under the pass's guard. Three more stage-two
 * hooks the pass itself has no port for:
 *  - E9 the driver's CI-red update-branch bypass: its `ciBehind` gh goes through S2J `wrapSchedulerV2MergeGh`;
 *  - E9 restart recovery: before the driver inspects a central card's `merging` row, S2J `reconcileSchedulerV2MergeOutbox`
 *    settles the center's merge intent; anything but "succeeded" holds the row (the driver records unknown, never resends);
 *  - S2M submit side: `deploymentJobs({ v2: schedulerV2DeploySubmit(...) })`, so a central job carries its X8 deployment.
 * Each gh / launchctl spawn keeps the pass's own guard (stop, singleton and maintenance lease): the guard is the pass's
 * `active`, captured from the train tick, which schedulerPass runs before the merge and deploy ticks.
 * Not wired (no credential) = the plain `schedulerPass`, byte for byte.
 */
import type { Database } from "bun:sqlite";
import type { SchedulerConfig } from "./scheduler-config.js";
import { deploymentJobs } from "./scheduler-deploy-job.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { ciBehindGh, type CiBehindGh } from "./scheduler-merge-ci-behind.js";
import type { MergeExternal } from "./scheduler-merge-driver.js";
import { mergeExternal } from "./scheduler-merge-external.js";
import { mergeTrainPass } from "./scheduler-merge-train-tick.js";
import { schedulerPass, type PassOpts, type PassResult } from "./scheduler-pass.js";
import { schedulerV2DeploySubmit, type DeploySubmitV2Port } from "./scheduler-v2-deploy.js";
import { parseSchedulerV2MergeSha, reconcileSchedulerV2MergeOutbox, SchedulerV2MergeWait, wrapSchedulerV2MergeGh } from "./scheduler-v2-merge.js";
import { initSchedulerV2 } from "./scheduler-v2-wiring.js";
import { runBounded } from "./run-bounded.js";
import { isTestProcess } from "./test-guard.js";

export interface SchedulerV2PassHooks {
  /** Projection sync + lease extension, run first inside the pass under its guard (checked before / after each effect). */
  beforePass?(assert: () => void): Promise<void>;
  db(): Database | null;
  route(taskId: string): "local" | "skip" | "central";
  deployment: NonNullable<DeploySubmitV2Port["deployment"]>;
  observe(entry: Record<string, unknown>): void;
}

type Hosted = MergeExternal & { ciBehind?: CiBehindGh };

/** The central merge intent whose local row is `merging` for this PR (a restart, or right after the merge was sent). */
function mergingIntent(h: SchedulerV2PassHooks, pr: string): string | null {
  const row = h.db()?.query("SELECT intentId, taskId FROM scheduler_merges WHERE prRef = ? AND phase = 'merging'").get(pr) as
    { intentId: string; taskId: string } | null;
  return row && h.route(row.taskId) === "central" ? row.intentId : null;
}

/** Inspect a central `merging` PR only after the center's merge intent is settled with the same merge commit. */
function recovering(h: SchedulerV2PassHooks, external: MergeExternal): MergeExternal {
  return { ...external, async inspect(pr) {
    const intentId = mergingIntent(h, pr);
    if (!intentId) return external.inspect(pr);
    const settled = await reconcileSchedulerV2MergeOutbox(intentId, external);
    if (settled.state !== "succeeded") throw new SchedulerV2MergeWait(settled.reason);
    const snapshot = await external.inspect(pr);
    // E8: the center's recorded mergeSha is read back through S2J's parser; GitHub must report the same commit.
    const recorded = parseSchedulerV2MergeSha(`mergeSha:${settled.mergeSha ?? ""}`);
    if (!recorded || snapshot.mergeSha?.toLowerCase() !== recorded) throw new SchedulerV2MergeWait("merge_sha_mismatch");
    return snapshot;
  } };
}

/** schedulerPass options with the stage-two hooks; anything a caller (test) injected is wrapped, never replaced. */
export function schedulerV2PassOpts(h: SchedulerV2PassHooks, opts: PassOpts): PassOpts {
  let active: (() => void) | null = null;
  const assertActive = () => {
    if (!active) throw new SchedulerStopped("stage2 pass guard not armed");
    active();
  };
  const guarded: typeof runBounded = async (...a) => {
    assertActive();
    try { return await runBounded(...a); } finally { assertActive(); }
  };
  return {
    ...opts,
    // The train tick is the pass's first step after its maintenance lease: the pre-pass runs here, under the same guard.
    trainTick: async (db, projects, a, fence) => {
      active = a;
      if (h.beforePass) await h.beforePass(a);
      return opts.trainTick ? opts.trainTick(db, projects, a, fence) : mergeTrainPass(db, projects, a, opts.train, fence);
    },
    external: (project) => {
      const base = (opts.external ?? ((p) => mergeExternal(p, guarded)))(project) as Hosted;
      const gh = base.ciBehind ?? (isTestProcess() ? null : ciBehindGh(guarded));
      const wrapped: Hosted = recovering(h, base);
      if (gh) wrapped.ciBehind = wrapSchedulerV2MergeGh(gh, project, base);
      return wrapped;
    },
    deployJobs: opts.deployJobs ?? deploymentJobs({ command: guarded, v2: schedulerV2DeploySubmit({
      route: h.route, deployment: h.deployment,
      record: (d) => h.observe({ node: "deploy", ...d }),
    }) }),
  };
}

/** The daemon's pass: the real schedulerPass with the hooks when stage two is wired; the projection sync runs inside it, after
 *  the maintenance lease (a held lease, a stop or a lost singleton = no projection write, no lease request). The daemon's first
 *  pass starts the process's single stage-two wiring (initSchedulerV2 is idempotent; off = no center request). */
export async function schedulerV2Pass(db: Database | null, config: SchedulerConfig, opts: PassOpts): Promise<PassResult> {
  const w = initSchedulerV2();
  if (!w?.pass || !config.enabled) return schedulerPass(db, config, opts);
  return schedulerPass(db, config, schedulerV2PassOpts(w.pass, opts));
}
