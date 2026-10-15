import { ownerMainCiDecision } from "./merge-queue-owner-hooks.js";
/**
 * MAINCIW, the per-pass gate (filled by scheduler-main-ci-wiring.ts mainCiPass) and every question asked of it later in the pass:
 * mergeTick (mainCiHolds, scheduler-main-ci-wiring.ts), the merge driver through MergeExternal.mainCi (withMainCi, assembled in scheduler-merge-external.ts) and the
 * train tick (mainCiTrainPause). A leaf of the train / merge modules: it imports none of them by value, so they can import it.
 * Decisions only under mainCiPause=on; observe and off always answer go. A project that should have been read but was not pauses.
 */
import type { Database } from "bun:sqlite";
import { listEvents } from "./ledger-store.js";
import type { RecoveryMode } from "./recovery-policy.js";
import type { runBounded } from "./run-bounded.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { MainCiHealth, MainCiTarget } from "./scheduler-main-ci.js";
import { planMainCi, type MainCiPlan } from "./scheduler-main-ci-plan.js";
import { MAIN_CI_MAX_AGE_MS, mainCiApprovals, mainCiPms, mainCiReasonText, type MainCiPersisted } from "./scheduler-main-ci-wiring-store.js";
import type { MainCiDecision, MergeExternal } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";
import { MAIN_CI_PAUSE, unsentAuto } from "./scheduler-merge-unsent.js";
import type { TrainDeps, TrainState } from "./scheduler-merge-train.js";

type ProjectSchedule = SchedulerConfig["projects"][string];
interface ProjectRead { target: MainCiTarget; health: MainCiHealth; currentMainSha: string | null; state: MainCiPersisted }
export interface MainCiGate { db: Database; now: () => number; modes: Map<string, RecoveryMode>; reads: Map<string, ProjectRead> }

/** Tests only: a fake gh command (the real envelope code still runs), a PM notice recorder and a clock. */
interface TestPorts { command?: typeof runBounded; notify?: (project: string, text: string) => Promise<void>; now?: () => number }
export let mainCiTestPorts: TestPorts = {};
export function setMainCiPortsForTest(p: TestPorts | null): void { mainCiTestPorts = p ?? {}; }

const gates = new WeakMap<Database, MainCiGate>();
const owners = new WeakMap<ProjectSchedule, Database>();
export const warnMainCi = (project: string, what: string, e: unknown) => console.error(`⚠️ [main-ci] ${project} ${what}：${(e as Error).message}`);

/** This pass's gate for this ledger connection, also found from each project policy object (mergeExternal only gets that). */
export function openMainCiGate(db: Database, config: SchedulerConfig): MainCiGate {
  const gate: MainCiGate = { db, now: mainCiTestPorts.now ?? Date.now, modes: new Map(), reads: new Map() };
  gates.set(db, gate);
  for (const policy of Object.values(config.projects)) owners.set(policy, db);
  return gate;
}

/**
 * MAINCIW2: the rule follows the project's mode, on = run-aware (a running main push run only waits), observe = the original rule;
 * observe asks for "run" explicitly only to record what on would do.
 */
export function mainCiPlanFor(gate: MainCiGate, project: string, candidate: { taskId: string; head: string }, claims: readonly string[] = [],
  rule: "legacy" | "run" = gate.modes.get(project) === "on" ? "run" : "legacy"): MainCiPlan | null {
  const read = gate.reads.get(project);
  if (!read) return null;
  const approvals = mainCiApprovals(gate.db, project, read.target.repo);
  return planMainCi({ target: read.target, health: read.health, currentMainSha: read.currentMainSha, now: gate.now(), maxAgeMs: MAIN_CI_MAX_AGE_MS,
    readFailureSince: read.state.readFailureSince, uncertainty: read.state.uncertainty, candidate: { project, repo: read.target.repo, ...candidate },
    projectPms: mainCiPms(gate.db, project, approvals), approvals, notificationClaims: claims, rule });
}

export function decide(gate: MainCiGate, project: string, taskId: string, head: string): "go" | "pause" {
  if (gate.modes.get(project) !== "on") return "go";
  return mainCiPlanFor(gate, project, { taskId, head })?.actions.merge === "normal-gates" ? "go" : "pause";
}
/** Trains never carry a repair: the project-level plan (no card) decides formation and in-flight trains. */
export const mainCiTrainPaused = (gate: MainCiGate, project: string): boolean =>
  gate.modes.get(project) === "on" && mainCiPlanFor(gate, project, { taskId: "", head: "" })?.actions.formTrain !== "normal-gates";

/** This pass's gate for the ledger connection mergeTick reads (mainCiHolds, scheduler-main-ci-wiring.ts), or none outside a pass. */
export const mainCiGateOf = (db: Database): MainCiGate | undefined => gates.get(db);

export function pauseReceipt(gate: MainCiGate, run: MergeRun, extra = ""): string {
  const read = gate.reads.get(run.project), plan = mainCiPlanFor(gate, run.project, { taskId: run.taskId, head: run.reviewedHead });
  const what = read ? `main ${read.health.mainSha?.slice(0, 12) ?? "未读到"} ${read.health.state}：${mainCiReasonText(read.health)}` : "本轮没有读到主线 CI";
  return `${MAIN_CI_PAUSE}：主线 CI 暂停（${plan?.reason ?? "unread"}，${what}），未发出合并，取消且不冻结${extra}`.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").slice(0, 600);
}

/** go on, wait (a run MRGUNK1 cannot cancel: not an unsent auto run), or cancel it unsent with main_ci_pause. */
function runDecision(policy: ProjectSchedule, run: MergeRun): MainCiDecision {
  const db = owners.get(policy), gate = db && gates.get(db);
  if (!gate) return "go";
  try {
    if (decide(gate, run.project, run.taskId, run.reviewedHead) === "go") return "go";
    const owner = ownerMainCiDecision(gate, run); if (owner) return owner;
    return unsentAuto(gate.db, run, listEvents(gate.db, { project: run.project, target: run.taskId })) ? { cancel: pauseReceipt(gate, run) } : "wait";
  } catch (e) {
    warnMainCi(run.project, "主线 CI 判定失败，本轮不动", e);
    return gate.modes.get(run.project) === "on" ? "wait" : "go";
  }
}

/** Assembled in scheduler-merge-external.ts, like withMergeTrain: the gate reaches the driver as an optional MergeExternal method. */
export function withMainCi(base: MergeExternal, policy: ProjectSchedule): MergeExternal {
  const now = (run: MergeRun) => runDecision(policy, run);
  return { ...base, mainCi: Object.assign(async (run: MergeRun) => now(run), { now }) };
}
/**
 * The same decision, synchronous and fresh (the binding re-read from the ledger): the drive re-asks it before each effect claim. It rides
 * on the mainCi function itself, so the wrappers that spread the external later in the pass (scheduler-v2-wiring-pass.ts) keep it.
 */
export const mainCiDecideNow = (source: MergeExternal, run: MergeRun): MainCiDecision =>
  (source.mainCi as { now?: (run: MergeRun) => MainCiDecision } | undefined)?.now?.(run) ?? "go";

/**
 * Train tick: a train still testing or settling while main is paused is voided (no culprit, no bounce); stepTrain then cleans up.
 * Returns the PM notice for the tick to send (null = not voided here).
 */
export function mainCiTrainPause(db: Database, s: TrainState, deps: Pick<TrainDeps, "store" | "now">): string | null {
  const gate = gates.get(db);
  if (!gate || (s.phase !== "testing" && s.phase !== "settling") || !mainCiTrainPaused(gate, s.project)) return null;
  const reason = "主线 CI 红或不明（main_ci_pause），不判 culprit、不退回成员";
  s.phase = "cleanup"; s.outcome = "void"; s.reason = reason; s.updatedAt = deps.now();
  // PM 定 8: CI already on GitHub is never cancelled by the pause. A settled exit claim makes exitCancel (trainCiTimeout on) a no-op
  // for this cleanup; the runs on the train branches finish on their own. An exit claim already in flight is left as it is.
  s.ciExit ??= { runs: [], cancel: "confirmed", rechecks: 0, receipts: [`${MAIN_CI_PAUSE}：主线 CI 暂停作废，保留已有 CI，不取消`] };
  deps.store.save(s);
  const text = `作废：${reason}；已合并 ${s.merged.map((m) => m.taskId).join("、") || "（无）"}，其余留在 merge`;
  deps.store.event(s.project, { at: deps.now(), train: s.id, seq: s.seq, kind: "void", text, data: { reason, cause: MAIN_CI_PAUSE } });
  return `[合并列车] 第 ${s.seq} 辆车 ${s.id}：${text}`;
}
