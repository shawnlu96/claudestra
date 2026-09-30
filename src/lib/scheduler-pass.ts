/**
 * One service pass = merge + observe + auto under a single maintenance lease, the same one `update` takes: while an
 * update holds it the whole pass is skipped, never just the merge part. Every external effect of the pass (ledger CLI,
 * session create, review pin, order submit, PM notice) re-checks the lease, the stop signal and the singleton lock
 * before and after its await, so a stop or a lost lease ends the pass there and no later card is driven.
 */
import type { Database } from "bun:sqlite";
import { autoTickDeps } from "./scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "./scheduler-auto-tick.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { acquireMaintenance, SchedulerStopped, whileOwned } from "./scheduler-maintenance.js";
import { mergeExternal } from "./scheduler-merge-external.js";
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
}

export interface PassResult { ran: boolean; failed: { taskId: string; error: string }[] }

const guard = <A extends unknown[], R>(active: Active, fn: (...a: A) => Promise<R>) => (...a: A): Promise<R> => whileOwned(active, () => fn(...a));

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

export async function schedulerPass(db: Database, config: SchedulerConfig, opts: PassOpts): Promise<PassResult> {
  if (!config.enabled) return { ran: false, failed: [] };
  const lease = await acquireMaintenance("scheduler", opts.maintenance);
  if (!lease) return { ran: false, failed: [] };
  const active: Active = () => { opts.assertOwner(); if (!lease.held()) throw new SchedulerStopped("scheduler lost maintenance lease"); };
  const manager = guard(active, opts.manager ?? schedulerManager);
  try {
    await mergeTick(db, config, manager, opts.external ?? mergeExternal, active);
    // observe 卡只写观察事件，auto 卡每卡推一步；某张卡失败不挡其余卡，失败汇总给服务的去重日志
    const observed = await schedulerObserveTick(db, config.projects, manager);
    const auto = await schedulerAutoTick(db, config.projects, guardAutoDeps((opts.autoDeps ?? ((a) => autoTickDeps(db, undefined, undefined, a)))(active), active));
    return { ran: true, failed: [...observed.failed, ...auto.failed] };
  } finally { lease.release(); }
}
