/**
 * S2I: the auto tick's side-effect ports for execution cards (stage-two plan §2.2, appendix S2I). Routing comes only from the
 * injected `route(taskId)`; this module never reads modes or switches. local = the original ports (the send rechecks the route); skip = no effect
 * at all; central = dispatch / review sends run inside X8's executeSchedulerCentral (intent.check before, operation.result
 * after), ensure_session stays a home-local action guarded by the claim's lease fence, and every ledger subcommand goes through
 * the port's wrapManager (S2Q) — this module maps none of them, except that the settle of an intent X8 already owns the result
 * of is answered by `settled` instead of reaching S2Q (one result writer per operation). Planning logic in scheduler-auto-tick.ts is unchanged.
 */
import type { Database } from "bun:sqlite";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import type { AutoTickDeps } from "./scheduler-auto-tick.js";
import type { SchedulerCentralContext, SchedulerCentralRuntime } from "./scheduler-central-context.js";
import type { SchedulerCentralJournal } from "./scheduler-central-journal.js";
import type { SessionRole } from "./scheduler-sessions.js";
import type { V2Fence } from "./shared-ledger-contract-v2.js";
import type { EnsureResult, SessionRef, WorkerSession } from "./worker-session.js";
import { centralSettle, centralSubmit, type SchedulerV2CentralOwned } from "./scheduler-v2-intent-submit.js";

type SchedulerV2IntentManager = (...args: string[]) => Promise<Record<string, unknown>>;
export type SchedulerV2IntentRoute = "local" | "skip" | "central";
/** Everything X8 needs for one send; S2F builds it from the projected intent and the trusted authorization / lease context. */
export interface SchedulerV2IntentCentral { context: SchedulerCentralContext; runtime: SchedulerCentralRuntime; journal: SchedulerCentralJournal }

export interface SchedulerV2IntentPort {
  /** S2D's schedulerV2Route, injected by S2F. */
  route(taskId: string): SchedulerV2IntentRoute;
  /** S2Q's withSchedulerV2LedgerCmds (the same instance S2D wraps the pass manager with). */
  wrapManager(manager: SchedulerV2IntentManager): SchedulerV2IntentManager;
  /** Optional (S2F wiring): S2R `current(featureOf(taskId))`; absent = central ensure holds (v2_unmapped). */
  fence?(taskId: string): V2Fence | null;
  /** Optional: the fence of this role's submitted ensure_session claim (see schedulerV2EnsureClaimFence); absent = hold. */
  claimFence?(taskId: string, role: SessionRole): V2Fence | null;
  /** Optional: the X8 context / runtime / journal for this dispatch or review intent; absent or null = the send is refused. */
  central?(taskId: string, intentId: string): SchedulerV2IntentCentral | null;
  /**
   * Optional (S2F wiring): the driver's settle from submitted (`to` = done / cancelled / unknown) of a dispatch / review intent
   * whose result X8 already reported: sync the S2P projection and return S2Q's shape ({ ok, intent }); ok only if the projected
   * status is `to`. It must send no command (X8 owns the result). Absent = held (v2_unmapped), zero center requests.
   */
  settled?(taskId: string, intentId: string, to: string): Promise<Record<string, unknown>>;
  /** Optional: observe log for holds and skips; default console.warn. */
  observe?(taskId: string, code: string): void;
}

let configured: SchedulerV2IntentPort | null = null;
/** null (or never called) = the center is not wired: every port passes through and the S2D pass gate holds execution cards. */
export function configureSchedulerV2Intents(port: SchedulerV2IntentPort | null): void { configured = port; }

const sameFence = (a: V2Fence, b: V2Fence): boolean =>
  a.epoch === b.epoch && a.bootId === b.bootId && a.serviceGeneration === b.serviceGeneration;
const roleOfEnsure = (node: string): SessionRole => node === "adversarial_review" ? "reviewer" : "author";

/**
 * The trusted claim fence for S2F's `claimFence`: the fence the executor token stamped on this role's pending→submitted settle
 * (plan §2.2「认领任期」). Only the local ledger is read; null = no submitted claim or a claim written outside the token.
 */
export function schedulerV2EnsureClaimFence(db: Database, taskId: string, role: SessionRole): V2Fence | null {
  const rows = db.query(`SELECT id, node FROM scheduler_intents WHERE taskId = ? AND action = 'ensure_session' AND status = 'submitted'
    ORDER BY eventSeq DESC`).all(taskId) as { id: string; node: string }[];
  const claim = rows.find((r) => roleOfEnsure(r.node) === role);
  const fence = claim ? getEventByDedup(db, `scheduler:${claim.id}:submitted`)?.data.fence : null;
  if (!fence || typeof fence !== "object") return null;
  const f = fence as Record<string, unknown>;
  return typeof f.epoch === "number" && typeof f.bootId === "string" && typeof f.serviceGeneration === "number"
    ? { serviceGeneration: f.serviceGeneration, epoch: f.epoch, bootId: f.bootId } : null;
}

function held(port: SchedulerV2IntentPort, taskId: string, code: string): void {
  if (port.observe) port.observe(taskId, code);
  else console.warn(`[scheduler-v2-intent] ${taskId}: ${code}`);
}

/** Effects refused without sending: a skip card never reaches a transport, a session or the PM channel. */
function skippedWorker(w: WorkerSession, reason: string): WorkerSession {
  const refused = { ok: false as const, unknown: false, reason };
  return { ...w, ensure: async () => ({ kind: "wait", reason }),
    submit: async () => ({ status: "rejected", route: w.route, reason }), cancel: async () => refused, archive: async () => refused };
}

/**
 * route=local: every port is the original one, but the route is read again right before the send — the driver awaits the claim
 * between worker() and submit(), and a card that left local meanwhile (skip / migrating / central) must not send from here.
 * Unchanged route = the original submit with the same arguments and its own receipt.
 */
function localWorker(port: SchedulerV2IntentPort, w: WorkerSession, skip: (taskId: string) => string): WorkerSession {
  return { ...w, submit: async (ref, intentId, order) => {
    const now = port.route(ref.taskId);
    if (now === "local") return w.submit(ref, intentId, order);
    const reason = now === "skip" ? skip(ref.taskId) : (held(port, ref.taskId, "route_changed"), "route_changed：卡已不走本机，未投递");
    return { status: "rejected", route: w.route, reason };
  } };
}

/** plan §2.2「ensure 的租约保护」: build only under the claim's own term; a term that moved during the build is unknown. */
async function guardedEnsure(port: SchedulerV2IntentPort, deps: AutoTickDeps, task: LedgerTask, role: SessionRole,
  family: AuthorFamily): Promise<EnsureResult> {
  if (!port.fence || !port.claimFence) { held(port, task.id, "v2_unmapped"); return { kind: "wait", reason: "v2_unmapped：缺少主场租约端口" }; }
  const claim = port.claimFence(task.id, role), before = port.fence(task.id);
  if (!claim || !before || !sameFence(before, claim)) {
    held(port, task.id, "lease");
    return { kind: "wait", reason: "lease" };
  }
  const got = await deps.ensure(task, role, family);
  const after = port.fence(task.id);
  if (!after || !sameFence(after, claim) || port.route(task.id) !== "central") {
    held(port, task.id, "lease_lost");
    return { kind: "unknown", reason: `建 session 期间主场租约丢失或换任期，结果不明（${got.kind}），不重建，交 PM` };
  }
  return got;
}

/**
 * Wrap the auto tick's ports (scheduler-auto-deps.ts return value). The port is read once here, as autoTickDeps runs per pass;
 * the route is read again before every effect. route=local returns what the original port returns (the worker's submit
 * rechecks the route first).
 */
export function withSchedulerV2Intents(deps: AutoTickDeps): AutoTickDeps {
  const port = configured;
  if (!port) return deps;
  const skip = (taskId: string): string => { held(port, taskId, "skip"); return "v2_skip：execution 卡暂停或 feature 正在 migrating"; };
  const owned: SchedulerV2CentralOwned = new Map(), manager = port.wrapManager(deps.manager);
  return {
    ...deps,
    // wrapManager(original) for every call; only an X8-owned intent's settle is answered without a second result report.
    manager: async (...args) => await centralSettle(port, owned, args, (id, code) => held(port, id, code)) ?? manager(...args),
    worker: (ref: SessionRef) => {
      const route = port.route(ref.taskId), w = deps.worker(ref);
      if ("manual" in w) return w;
      if (route === "local") return localWorker(port, w, skip);
      return route === "skip" ? skippedWorker(w, skip(ref.taskId)) : centralSubmit(port, w, (code) => held(port, ref.taskId, code), owned);
    },
    ensure: async (task, role, family) => {
      const route = port.route(task.id);
      if (route === "local") return deps.ensure(task, role, family);
      if (route === "skip") return { kind: "wait", reason: skip(task.id) };
      return guardedEnsure(port, deps, task, role, family);
    },
    pinReview: async (task, ref, head) => port.route(task.id) === "skip" ? { manual: skip(task.id) } : deps.pinReview(task, ref, head),
    notifyPm: async (task, text) => { if (port.route(task.id) === "skip") skip(task.id); else await deps.notifyPm(task, text); },
  };
}
