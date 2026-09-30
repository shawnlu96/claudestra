/**
 * One service pass = merge + observe + auto under a single maintenance lease, the same one `update` takes: while an
 * update holds it the whole pass is skipped, never just the merge part. The lease, the stop signal and the singleton lock
 * are re-checked with no await between the check and the effect: before each subprocess spawn (ledger CLI, git, gh,
 * manager create) and after it exits, and inside the bridge client's onopen right before a frame is sent. A stop or a lost
 * lease ends the pass there; no later card is driven. Auto cards run only with scheduler.json autoDispatch: true (T68h).
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
import { mergeTick, schedulerManagerWith } from "./scheduler-service.js";
import type { LeaseHold, SchedulerLease } from "./scheduler-lease-env.js";
import { passPace } from "./scheduler-yield.js";
import type { WorkerSession } from "./worker-session.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Active = () => void;

export interface PassOpts {
  /** Throws SchedulerStopped when the service is stopping or lost its singleton lock. */
  assertOwner: Active;
  manager?: Manager;
  external?: (project: SchedulerConfig["projects"][string]) => MergeExternal;
  autoDeps?: (active: Active) => AutoTickDeps;
  /** Tests point this at a private lock / update marker / update request. */
  maintenance?: { path?: string; marker?: string; request?: string };
  /** Where each loop stopped last pass (kept by the daemon across passes) and this pass's time budget (lib/scheduler-yield.ts). */
  cursor?: Record<string, string | undefined>;
  budgetMs?: number;
  /** The daemon's singleton lease (scheduler.pid); with the maintenance lease it goes to every manager / ledger child. */
  singleton?: LeaseHold;
}

export interface PassResult { ran: boolean; failed: { taskId: string; error: string }[] }

/** Checked right before the call and again when it settles, failed or not: after a stop, SchedulerStopped wins over the call's own error. */
const guard = <A extends unknown[], R>(active: Active, fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
  active();
  try { return await fn(...a); } finally { active(); }
};

/**
 * A child that found the lease gone answers `code: "lease-lost"` (lib/scheduler-lease-env.ts). That is the service stopping,
 * not a card failing: it ends the pass as SchedulerStopped, so no card is counted failed, handed to PM or reported.
 */
const leaseAware = (m: Manager): Manager => async (...args) => {
  const r = await m(...args);
  if (r.code === "lease-lost") throw new SchedulerStopped(`manager child: ${String(r.error ?? "lease lost")}`);
  return r;
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
    manager: guard(active, leaseAware(d.manager)), ensure: guard(active, d.ensure), pinReview: guard(active, d.pinReview),
    reviewDirty: guard(active, d.reviewDirty), notifyPm: guard(active, d.notifyPm), now: d.now, borrow: d.borrow && guard(active, d.borrow),
    worker: (ref) => { active(); const w = d.worker(ref); return "manual" in w ? w : guardWorker(w, active); },
  };
}

export async function schedulerPass(db: Database, config: SchedulerConfig, opts: PassOpts): Promise<PassResult> {
  if (!config.enabled) return { ran: false, failed: [] };
  const lease = await acquireMaintenance("scheduler", opts.maintenance);
  if (!lease) return { ran: false, failed: [] };
  const active: Active = () => { opts.assertOwner(); if (!lease.held()) throw new SchedulerStopped("scheduler lost maintenance lease"); };
  const held: SchedulerLease | undefined = opts.singleton && { singleton: opts.singleton, maintenance: { path: lease.path, token: lease.token } };
  const manager = guard(active, leaseAware(opts.manager ?? schedulerManagerWith(held)));
  // 卡与卡之间：update 在等或本轮超预算（且本阶段保底份额用完）就收手，下一轮从停下的下一张接着排（卡内已开始的一步不打断）
  const pace = passPace(opts.cursor ?? {}, { budgetMs: opts.budgetMs, request: opts.maintenance?.request });
  try {
    // every gh subprocess of the merge driver, reads included, is checked right before its spawn and after its exit
    await mergeTick(db, config, manager, opts.external ?? ((p) => mergeExternal(p, guard(active, runBounded))), active, pace.phase());
    // observe 卡只写观察事件，auto 卡每卡推一步；某张卡失败不挡其余卡，失败汇总给服务的去重日志
    const observed = await schedulerObserveTick(db, config.projects, manager, pace.phase());
    if (config.autoDispatch !== true) return { ran: true, failed: observed.failed };
    const deps = guardAutoDeps((opts.autoDeps ?? ((a) => autoTickDeps(db, { active: a, lease: held })))(active), active);
    const auto = await schedulerAutoTick(db, config.projects, deps, pace.phase());
    return { ran: true, failed: [...observed.failed, ...auto.failed] };
  } finally { lease.release(); }
}
