/**
 * One service pass = merge + observe + auto under a single maintenance lease, the same one `update` takes: while an
 * update holds it the whole pass is skipped, never just the merge part. The lease, the stop signal and the singleton lock
 * are re-checked with no await between the check and the effect: before each subprocess spawn (ledger CLI, git, gh,
 * manager create) and after it exits, and inside the bridge client's onopen right before a frame is sent. A stop or a lost
 * lease ends the pass there; no later card is driven. Auto cards run only with scheduler.json autoDispatch: true (T68h).
 * The pass runs when scheduler.json or lend.json is on; merge / observe / auto look only at scheduler.json, the lend step
 * (remote-capacity §2.3, lib/lend-loop.ts) only at lend.json, so lending never forces merge or auto-dispatch on.
 * Tests: tests/scheduler-service-lease.test.ts.
 */
import type { Database } from "bun:sqlite";
import { autoTickDeps } from "./scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "./scheduler-auto-tick.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { acquireMaintenance, SchedulerStopped } from "./scheduler-maintenance.js";
import { mergeExternal } from "./scheduler-merge-external.js";
import { runBounded } from "./run-bounded.js";
import type { MergeExternal } from "./scheduler-merge-driver.js";
import { schedulerObserveTick } from "./scheduler-observe-tick.js";
import { mergeTick, schedulerManager } from "./scheduler-service.js";
import type { WorkerSession } from "./worker-session.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Active = () => void;

export interface PassOpts {
  /** Throws SchedulerStopped when the service is stopping or lost its singleton lock. */
  assertOwner: Active;
  manager?: Manager;
  external?: (project: SchedulerConfig["projects"][string]) => MergeExternal;
  autoDeps?: (active: Active) => AutoTickDeps;
  /** Tests point this at a private lock / update marker. */
  maintenance?: { path?: string; marker?: string };
  /** The lend step (lend-deps.ts lendStep), given only while lend.json is on or journal orders are still running. */
  lend?: (active: Active) => Promise<{ failed: { orderId: string; error: string }[] }>;
}

export interface PassResult { ran: boolean; failed: { taskId: string; error: string }[] }

/** Checked right before the call and again when it settles, failed or not: after a stop, SchedulerStopped wins over the call's own error. */
const guard = <A extends unknown[], R>(active: Active, fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  active();
  try { return await fn(...a); } finally { active(); }
};

function guardWorker(w: WorkerSession, active: Active): WorkerSession {
  return {
    route: w.route, fallbackReason: w.fallbackReason,
    ensure: guard(active, w.ensure.bind(w)), submit: guard(active, w.submit.bind(w)), observe: guard(active, w.observe.bind(w)),
    cancel: guard(active, w.cancel.bind(w)), archive: guard(active, w.archive.bind(w)),
  };
}

function guardAutoDeps(d: AutoTickDeps, active: Active): AutoTickDeps {
  return {
    manager: guard(active, d.manager), ensure: guard(active, d.ensure), pinReview: guard(active, d.pinReview),
    reviewDirty: guard(active, d.reviewDirty), notifyPm: guard(active, d.notifyPm), now: d.now,
    worker: (ref) => { active(); const w = d.worker(ref); return "manual" in w ? w : guardWorker(w, active); },
  };
}

export async function schedulerPass(db: Database | null, config: SchedulerConfig, opts: PassOpts): Promise<PassResult> {
  if (!config.enabled && !opts.lend) return { ran: false, failed: [] };
  const lease = await acquireMaintenance("scheduler", opts.maintenance);
  if (!lease) return { ran: false, failed: [] };
  const active: Active = () => { opts.assertOwner(); if (!lease.held()) throw new SchedulerStopped("scheduler lost maintenance lease"); };
  const manager = guard(active, opts.manager ?? schedulerManager);
  const failed: PassResult["failed"] = [];
  try {
    if (config.enabled) {
      if (!db) throw new Error("scheduler enabled but ledger is unavailable");
      // every gh subprocess of the merge driver, reads included, is checked right before its spawn and after its exit
      await mergeTick(db, config, manager, opts.external ?? ((p) => mergeExternal(p, guard(active, runBounded))), active);
      // observe 卡只写观察事件，auto 卡每卡推一步；某张卡失败不挡其余卡，失败汇总给服务的去重日志
      failed.push(...(await schedulerObserveTick(db, config.projects, manager)).failed);
      if (config.autoDispatch === true) {
        failed.push(...(await schedulerAutoTick(db, config.projects, guardAutoDeps((opts.autoDeps ?? ((a) => autoTickDeps(db, { active: a })))(active), active))).failed);
      }
    }
    if (opts.lend) failed.push(...(await opts.lend(active)).failed.map((f) => ({ taskId: `lend ${f.orderId}`, error: f.error })));
    return { ran: true, failed };
  } finally { lease.release(); }
}
