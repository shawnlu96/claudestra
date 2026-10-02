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
import { mergeTrainPass } from "./scheduler-merge-train-tick.js";
import { runBounded } from "./run-bounded.js";
import type { MergeExternal } from "./scheduler-merge-driver.js";
import { schedulerObserveTick } from "./scheduler-observe-tick.js";
import { mergeTick, schedulerManagerWith } from "./scheduler-service.js";
import type { LeaseHold, SchedulerLease } from "./scheduler-lease-env.js";
import { passPace } from "./scheduler-yield.js";
import { deployTick } from "./scheduler-deploy-tick.js";
import { deploymentJobs, type DeployJobs } from "./scheduler-deploy-job.js";
import type { WorkerSession } from "./worker-session.js";
import { withSupervisorHold } from "./agent-supervisor-hold.js";
import { peerPrStep } from "./peer-pr-tick.js";
import { autostartHooks, type AutostartHooks } from "./scheduler-autostart-deps.js";
import { lendTakeoverStep } from "./lend-pr-takeover.js";
import { takeoverGh } from "./lend-pr-takeover-gh.js";
import { retireStep } from "./scheduler-retire-deps.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Active = () => void;

export interface PassOpts {
  /** Throws SchedulerStopped when the service is stopping or lost its singleton lock. */
  assertOwner: Active;
  manager?: Manager;
  external?: (project: SchedulerConfig["projects"][string]) => MergeExternal;
  deployJobs?: DeployJobs;
  autoDeps?: (active: Active) => AutoTickDeps;
  /** Tests point this at a private lock / update marker / update request. */
  maintenance?: { path?: string; marker?: string; request?: string };
  /** Where each loop stopped last pass (kept by the daemon across passes) and this pass's time budget (lib/scheduler-yield.ts). */
  cursor?: Record<string, string | undefined>;
  budgetMs?: number;
  /** The daemon's singleton lease (scheduler.pid); with the maintenance lease it goes to every manager / ledger child. */
  singleton?: LeaseHold;
  /** The lend step (lend-deps.ts lendStep), given only while lend.json is on or journal orders are still running; its children get the same leases. */
  lend?: (active: Active, lease: SchedulerLease | undefined) => Promise<{ failed: { orderId: string; error: string }[] }>;
  /** Agent supervision (i28-S1, agent-supervisor-deps.ts superviseStep); runs only while scheduler.json has supervise on. */
  supervise?: (db: Database, config: SchedulerConfig, active: Active, lease: SchedulerLease | undefined) => Promise<{ failed: { agent: string; error: string }[] }>;
  peerPr?: (active: Active, manager: Manager) => Promise<{ failed: PassResult["failed"] }>; // peer PR 自动审（i28-A2）；默认 peerPrStep，测试注入
  /** 自动交回 / 自动开卡（i28-A1，scheduler-autostart-deps.ts）：tests inject fakes; manager is this pass's guarded scheduler CLI. */
  autostart?: (active: Active, manager: Manager) => AutostartHooks;
  retire?: typeof retireStep; // 收尾（i28-S2，scheduler-retire.ts）；测试注入
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

export async function schedulerPass(db: Database | null, config: SchedulerConfig, opts: PassOpts): Promise<PassResult> {
  if (!config.enabled && !opts.lend) return { ran: false, failed: [] };
  const lease = await acquireMaintenance("scheduler", opts.maintenance);
  if (!lease) return { ran: false, failed: [] };
  const active: Active = () => { opts.assertOwner(); if (!lease.held()) throw new SchedulerStopped("scheduler lost maintenance lease"); };
  const held: SchedulerLease | undefined = opts.singleton && { singleton: opts.singleton, maintenance: { path: lease.path, token: lease.token } };
  const manager = guard(active, leaseAware(opts.manager ?? schedulerManagerWith(held)));
  // 卡与卡之间：update 在等或本轮超预算（且本阶段保底份额用完）就收手，下一轮从停下的下一张接着排（卡内已开始的一步不打断）
  const pace = passPace(opts.cursor ?? {}, { budgetMs: opts.budgetMs, request: opts.maintenance?.request });
  const failed: PassResult["failed"] = [];
  try {
    if (config.enabled) {
      if (!db) throw new Error("scheduler enabled but ledger is unavailable");
      if (config.autoDispatch === true) failed.push(...(await (opts.peerPr ?? ((a, m) => peerPrStep(db, a, m)))(active, manager)).failed); // 推送先于自动派单
      await mergeTrainPass(db, Object.keys(config.projects), active); // i28-MT1 合并列车每项目一步：先于合并驱动，gh 与通知都受本轮租约守护
      // every gh subprocess of the merge driver, reads included, is checked right before its spawn and after its exit
      await mergeTick(db, config, manager, opts.external ?? ((p) => mergeExternal(p, guard(active, runBounded))), active, pace.phase());
      // launchctl calls of the deploy step are guarded the same way; the deploy job itself belongs to launchd, not to this pass
      await deployTick(db, config, { manager, jobs: opts.deployJobs ?? deploymentJobs({ command: guard(active, runBounded) }),
        assertActive: active, now: Date.now }, pace.phase());
      // observe 卡只写观察事件，auto 卡每卡推一步；某张卡失败不挡其余卡，失败汇总给服务的去重日志
      failed.push(...(await schedulerObserveTick(db, config.projects, manager, pace.phase())).failed);
      // 监护先于自动派单：它认领了恢复的回合失败，auto-tick 这一轮就让开（agent-supervisor-hold.ts）；关着时两步都不碰
      const supervising = config.supervise?.enabled === true && !!opts.supervise;
      if (supervising) failed.push(...(await opts.supervise!(db, config, active, held)).failed.map((f) => ({ taskId: `supervise ${f.agent}`, error: f.error })));
      if (config.autoDispatch === true) {
        const auto = (opts.autostart ?? ((a, m) => autostartHooks({ db, ledger: m, active: a, lease: held })))(active, manager);
        failed.push(...(await auto.resume(config, pace.phase()))); // 交回在 tick 之前：交回的卡同一轮就派审
        const base = guardAutoDeps((opts.autoDeps ?? ((a) => autoTickDeps(db, { active: a, lease: held })))(active), active);
        const deps = supervising ? withSupervisorHold(base, db) : base;
        const autoPace = pace.phase();
        failed.push(...(await schedulerAutoTick(db, config.projects, deps, autoPace)).failed);
        failed.push(...(await auto.start(config, autoPace))); // 开卡在 tick 之后，每轮最多一张，tick 用完预算就不开
      }
      failed.push(...(await lendTakeoverStep(db, { manager, gh: takeoverGh(guard(active, runBounded)), now: Date.now })).failed); // 出借写单卡在 publishing：按推送分支接管
      // 收尾不看 autoDispatch（关的是派新活，不是收旧摊子），自带保底份额，开卡吃光预算也轮得到
      failed.push(...(await (opts.retire ?? retireStep)(db, config, manager, active, held, pace.phase())));
    }
    if (opts.lend) failed.push(...(await opts.lend(active, held)).failed.map((f) => ({ taskId: `lend ${f.orderId}`, error: f.error })));
    return { ran: true, failed };
  } finally { lease.release(); }
}
