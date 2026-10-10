/**
 * S2F · scheduler-process composition root (plan §2.2「configure 端口」/「调度输入供应」, appendix S2F). `initSchedulerV2()`
 * runs once in the daemon (scheduler.ts) and injects:
 *  - S2R `startStage2Leases` (one instance per process), whose `current` is every node's fence;
 *  - S2D pass port (S2S effective switch + `wrapManager`) and S2I intents port, both wrapping with the SAME S2Q instance;
 *  - S2Q ledger-command port (route / client / fence / S2P sync / executor token / X0 context);
 *  - S2J merge port, S2V retire port; and `schedulerV2DeployDeps` for the `--deploy-job` branch (S2M).
 * `schedulerV2Route` (S2D) is the only route every node gets. Credentials resolve lazily per call, so with the switch off (the
 * default) no center request is made: routes of execution cards are skip and every other card is local.
 */
import type { Database } from "bun:sqlite";
import { LedgerReader } from "./ledger-read.js";
import { getIntent } from "./ledger-scheduler.js";
import { getTask } from "./ledger-store.js";
import { instanceIdSync } from "./instance-id.js";
import { SchedulerCentralJournal } from "./scheduler-central-journal.js";
import type { SchedulerCentralWorkerDeps } from "./scheduler-central-worker.js";
import { centralDeployDeps, type DeployV2Deps } from "./scheduler-v2-deploy.js";
export { runDeployJobV2 } from "./scheduler-v2-deploy.js";
import { configureSchedulerV2Intents, schedulerV2EnsureClaimFence } from "./scheduler-v2-intent.js";
import { startStage2Leases, type Stage2LeaseFeature, type Stage2LeasePort } from "./scheduler-v2-lease.js";
import { withSchedulerV2LedgerCmds, type SchedulerV2ExecutorCall, type SchedulerV2LedgerManager, type SchedulerV2LedgerPort } from "./scheduler-v2-ledger-cmds.js";
import { schedulerV2LedgerClaimFence } from "./scheduler-v2-ledger-cmds-args.js";
import { configureSchedulerV2Merge } from "./scheduler-v2-merge.js";
import { localMergeTask } from "./scheduler-v2-merge-context.js";
import { clearSchedulerV2Diagnostics, configureSchedulerV2Pass, schedulerV2Route } from "./scheduler-v2-pass.js";
import { configureSchedulerV2Retire } from "./scheduler-v2-retire.js";
import { centralCard, centralContext, centralIntentFence, leaseIdOf, refreshCentralAsks, type CentralAction } from "./scheduler-v2-wiring-central.js";
import { parseFence, type V2Fence } from "./shared-ledger-contract-v2.js";
import { withExecutorScope } from "./shared-ledger-v2-write-gate.js";
import { syncExecutionProjection } from "./shared-ledger-v2-projection.js";
import { OWNER_PRINCIPAL, Stage2Wiring, type Stage2WiringOptions } from "./shared-ledger-v2-wiring.js";

type Leases = ReturnType<typeof startStage2Leases>;
export interface SchedulerV2WiringOptions extends Stage2WiringOptions {
  wiring?: Stage2Wiring;
  /** The ledger the scheduler writes (default: its own LedgerReader on statePath("ledger.sqlite")). */
  db?(): Database | null;
  /** This home's instance id as the center knows it (default: instance-id.ts). */
  instanceId?(): string;
  /** S2R lease commands. Default refuses (unavailable): the feature → task lease mapping is not frozen (see S2F delivery). */
  leaseCommand?: Stage2LeasePort["command"];
  leasePolicy?(): unknown;
  /** Tests inject their own lease controller; production starts exactly one per process. */
  leases?: Leases;
  journalDir?: string;
  /** Trusted center instance → local peer (name, fp) for projected remote executors; default none (v2_unmapped, held). */
  peerOf?(instanceId: string): { name: string; fp: string } | null;
  registryPath?: string;
}
export interface SchedulerV2Wiring {
  wiring: Stage2Wiring;
  leases: Leases;
  route(taskId: string): "local" | "skip" | "central";
  /** The single S2Q wrapper both scheduler managers get. */
  wrapManager(manager: SchedulerV2LedgerManager): SchedulerV2LedgerManager;
  sync(project: string, featureId: string): Promise<void>;
  /** S2M worker deps for `scheduler.ts --deploy-job`. */
  deployDeps(): DeployV2Deps;
  stop(): Promise<void>;
}

const unwiredLease: Stage2LeasePort["command"] = async () => {
  throw Object.assign(new Error("stage2 lease adapter not wired"), { code: "unavailable" });
};

let active: SchedulerV2Wiring | null = null;
export function schedulerV2Wiring(): SchedulerV2Wiring | null { return active; }

/** Everything the per-node ports share in this process. */
interface Ctx {
  opts: SchedulerV2WiringOptions; wiring: Stage2Wiring; leases: Leases; journal: SchedulerCentralJournal;
  db(): Database | null; instanceId(): string; route(taskId: string): "local" | "skip" | "central";
  observe(taskId: string, code: string): void;
}

function leaseFeatures(wiring: Stage2Wiring, db: () => Database | null, instanceId: () => string): Stage2LeaseFeature[] {
  const d = db();
  if (!d) return [];
  const rows = d.query("SELECT id, project FROM features").all() as { id: string; project: string }[];
  return rows.flatMap((f) => {
    const m = wiring.readMode(f.id);
    if (!m?.centerExecution) return [];
    const view = wiring.cachedView(m.centerExecution.centerFeatureId);
    return [{ localFeatureId: f.id, projectId: f.project, homeInstanceId: view?.feature.homeInstanceId ?? instanceId(),
      centerExecution: m.centerExecution, ...(m.migrating ? { migrating: m.migrating } : {}) }];
  });
}

function featureIdOf(c: Ctx, taskId: string): string | null {
  const task = c.db() && getTask(c.db()!, taskId);
  const id = task?.featureId ?? task?.extra.sharedFeatureId;
  return typeof id === "string" ? id : null;
}
function fenceOfTask(c: Ctx, taskId: string): V2Fence | null {
  const featureId = featureIdOf(c, taskId);
  return featureId ? c.leases.current(featureId) : null;
}
async function syncOne(c: Ctx, project: string, featureId: string): Promise<void> {
  const d = c.db();
  if (!d) throw Object.assign(new Error("ledger unavailable"), { code: "unavailable" });
  await syncExecutionProjection(d, { snapshot: (p, f) => c.wiring.snapshot(p, f), observe: c.observe,
    identity: () => ({ home: c.instanceId(), peer: (id) => c.opts.peerOf?.(id) ?? null }) })(project, featureId);
  const ref = c.wiring.featureRef(featureId, project), view = ref && c.wiring.cachedView(ref.centerFeatureId);
  if (view) await refreshCentralAsks(c.wiring, project, view);
}
function context(c: Ctx, taskId: string, action: CentralAction, head: string | null, intentId?: string) {
  const d = c.db();
  return d ? centralContext({ wiring: c.wiring, db: d, taskId, action, head, intentId, fence: fenceOfTask(c, taskId),
    homeInstanceId: c.instanceId() }) : null;
}
function runtime(c: Ctx, taskId: string) {
  const featureId = featureIdOf(c, taskId), project = c.db() && getTask(c.db()!, taskId)?.project;
  const transport = project ? c.wiring.transportFor(project) : null;
  return transport && featureId ? { instanceId: c.instanceId(), client: transport.scheduler,
    lock: { held: () => c.leases.current(featureId) !== null && c.route(taskId) === "central" } } : null;
}

/** S2Q (E7): X0 context and the S2G executor token, with a leaseId derived from the trusted S2R fence. */
function ledgerPort(c: Ctx): SchedulerV2LedgerPort {
  return {
    route: c.route, db: () => c.db()!, fence: (featureId) => c.leases.current(featureId), sync: (p, f) => syncOne(c, p, f),
    clientFor: (p) => c.wiring.clientFor(OWNER_PRINCIPAL, p),
    context: (p, featureId) => {
      const fence = c.leases.current(featureId), scope = c.wiring.scope(p);
      return fence && scope ? { teamId: scope.teamId, projectId: scope.projectId, serviceGeneration: fence.serviceGeneration,
        bootId: fence.bootId, homeInstanceId: c.instanceId(), fence: { ...fence } } : null;
    },
    scope: <T>(fn: () => T): T => {
      const { db: d, ref } = (fn as SchedulerV2ExecutorCall<T>).executor;
      return withExecutorScope(d, { ...ref, leaseIdOf }, fn);
    },
    claimFence: (_p, intentId) => { const d = c.db(); return d ? centralIntentFence(c.wiring, d, intentId) : null; },
    ...(c.opts.registryPath ? { registryPath: c.opts.registryPath } : {}),
    observe: c.observe,
  };
}

function configureIntents(c: Ctx, wrapManager: (m: SchedulerV2LedgerManager) => SchedulerV2LedgerManager): void {
  configureSchedulerV2Intents({
    route: c.route, wrapManager, observe: c.observe,
    fence: (taskId) => fenceOfTask(c, taskId),
    claimFence: (taskId, role) => { const d = c.db(); return d ? schedulerV2EnsureClaimFence(d, taskId, role) : null; },
    central: (taskId, intentId) => {
      const intent = c.db() && getIntent(c.db()!, intentId);
      const r = runtime(c, taskId), ctx = intent && (intent.action === "dispatch" || intent.action === "review")
        ? context(c, taskId, intent.action, intent.head, intentId) : null;
      return ctx && r ? { context: ctx, runtime: r, journal: c.journal } : null;
    },
    // X8 already reported the result: only re-project and answer in S2Q's shape (no second command).
    settled: async (taskId, intentId, to) => {
      const featureId = featureIdOf(c, taskId), project = c.db() && getTask(c.db()!, taskId)?.project;
      if (!featureId || !project) return { ok: false, code: "v2_unmapped" };
      await syncOne(c, project, featureId);
      const intent = getIntent(c.db()!, intentId);
      return { ok: intent?.status === to, intent };
    },
  });
}

function configureMergeAndRetire(c: Ctx): void {
  configureSchedulerV2Merge({
    route: c.route, journal: c.journal, observe: (d) => c.observe(d.taskId, `${d.action}: ${d.reason}`),
    taskForPr: (pr) => {
      const t = localMergeTask(pr), card = t && c.db() ? centralCard(c.wiring, c.db()!, t.taskId) : null;
      return t && card ? { ...t, centerFeatureId: card.centerFeatureId } : t;
    },
    context: (taskId, head) => context(c, taskId, "merge", head),
    runtime: (taskId) => runtime(c, taskId),
  });
  configureSchedulerV2Retire({
    route: c.route,
    featureOfTask: (taskId) => c.wiring.featureOfTask(c.db(), taskId),
    fence: (centerFeatureId) => {
      const local = leaseFeatures(c.wiring, c.db, c.instanceId).find((f) => f.centerExecution?.centerFeatureId === centerFeatureId);
      return local ? c.leases.current(local.localFeatureId) : null;
    },
    claimFence: (intentId) => {
      const d = c.db(), raw = d ? schedulerV2LedgerClaimFence(d, intentId) : null;
      return raw && typeof raw === "object" ? strictFence(raw as Record<string, unknown>) : null;
    },
  });
}

const unconfigure = () => {
  configureSchedulerV2Pass(null); configureSchedulerV2Intents(null); configureSchedulerV2Merge(null); configureSchedulerV2Retire(null);
  clearSchedulerV2Diagnostics();
};

export function initSchedulerV2(opts: SchedulerV2WiringOptions = {}): SchedulerV2Wiring {
  if (active) return active;
  const wiring = opts.wiring ?? new Stage2Wiring(opts);
  const reader = opts.db ? null : new LedgerReader();
  const db = (): Database | null => opts.db ? opts.db() : reader!.get();
  const instanceId = (): string => opts.instanceId?.() ?? instanceIdSync(wiring.dir);
  const route = (taskId: string) => schedulerV2Route(taskId, db());
  if (!wiring.wired()) {
    // No local credential: every port is injected as null (execution cards skip, the rest local); restart after joining.
    const leases = startStage2Leases(null);
    unconfigure();
    active = { wiring, leases, route, wrapManager: (m) => m,
      sync: async () => { throw Object.assign(new Error("unavailable"), { code: "unavailable" }); },
      deployDeps: () => centralDeployDeps(null, route),
      async stop() { active = null; await leases.stop(); reader?.close(); } };
    return active;
  }
  const leases = opts.leases ?? startStage2Leases({
    get instanceId() { return instanceId(); },
    features: () => leaseFeatures(wiring, db, instanceId), mode: (p) => wiring.mode(p),
    command: opts.leaseCommand ?? unwiredLease,
    onLost: (featureId, reason) => wiring.observe({ node: "lease", featureId, code: "lease_lost", reason }),
    leasePolicy: opts.leasePolicy ?? (() => ({ leaseMs: 60_000, renewMs: 15_000, clock: "central" })),
  });
  const c: Ctx = { opts, wiring, leases, db, instanceId, route,
    journal: new SchedulerCentralJournal(opts.journalDir ?? `${wiring.dir}/scheduler-v2-central`),
    observe: (taskId, code) => wiring.observe({ node: "scheduler", taskId, code }) };
  const port = ledgerPort(c);
  // One S2Q port for both managers: the pass manager (S2D) and the auto-tick manager (S2I).
  const wrapManager = (manager: SchedulerV2LedgerManager) => withSchedulerV2LedgerCmds(manager, port);
  configureSchedulerV2Pass({ mode: (p) => wiring.mode(p), wrapManager });
  configureIntents(c, wrapManager);
  configureMergeAndRetire(c);
  const openClient: SchedulerCentralWorkerDeps["openClient"] = async (connectionId) => {
    const transport = wiring.transportFor(connectionId);
    if (!transport) throw Object.assign(new Error("stage2 center unavailable"), { code: "unavailable" });
    return { instanceId: instanceId(), client: transport.scheduler };
  };
  active = {
    wiring, leases, route, wrapManager, sync: (p, f) => syncOne(c, p, f),
    deployDeps: () => centralDeployDeps(openClient, route),
    async stop() { unconfigure(); active = null; await leases.stop(); reader?.close(); },
  };
  return active;
}

/** S2G stamps leaseId next to X0's fence; the retire claim compares only X0's three fields. */
function strictFence(raw: Record<string, unknown>): V2Fence | null {
  try { return parseFence({ serviceGeneration: raw.serviceGeneration, epoch: raw.epoch, bootId: raw.bootId }); }
  catch { return null; }
}

/**
 * Deploy-job branch of scheduler.ts: a one-shot process. It needs only S2D's route (with the S2S switch) and a client opener;
 * no lease loop, no manager wrapping. The submit-side hook (deploymentJobs({ v2 })) is not wired yet, so no job carries a
 * `central` field today and every central job would be blocked by S2M before any argv.
 */
export function schedulerV2DeployDeps(opts: Stage2WiringOptions & { wiring?: Stage2Wiring; instanceId?(): string } = {}): DeployV2Deps {
  const wiring = opts.wiring ?? new Stage2Wiring(opts);
  configureSchedulerV2Pass({ mode: (p) => wiring.mode(p), wrapManager: (m) => m });
  return centralDeployDeps(async (connectionId) => {
    const transport = wiring.transportFor(connectionId);
    if (!transport) throw Object.assign(new Error("stage2 center unavailable"), { code: "unavailable" });
    return { instanceId: opts.instanceId?.() ?? instanceIdSync(wiring.dir), client: transport.scheduler };
  }, (taskId) => schedulerV2Route(taskId));
}
