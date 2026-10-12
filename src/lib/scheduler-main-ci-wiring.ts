/**
 * MAINCIW: wires MAINCI's main health (scheduler-main-ci.ts readMainCi) and plan (scheduler-main-ci-plan.ts planMainCi) into production.
 * Recovery key mainCiPause (default observe): on = pause, observe = the old scheduling byte for byte plus one "本会暂停" note per
 * (mainSha, state) and the PM notices, off = the old scheduling with no GitHub read, no note, no notice.
 *
 * One gate per scheduler pass (scheduler-pass.ts, right after the MQ1 manualMergeGate): mainCiPass reads each local-merge project at
 * most once, only when it has a pending / submitted merge intent, a train candidate or a live train, persists planMainCi's state through
 * the scheduler's guarded ledger child (`scheduler-main-ci`, the pass's connection is query_only), records observe notes, claims and
 * sends PM notices, and composes the train's blocks / formFence with MQ1's (either refusing = no train). The gate is then found by
 * the ledger connection (mergeTick, the train tick) or the project policy object (mergeExternal) for the rest of the pass:
 * - mergeTick (scheduler-service.ts): a paused intent with no run yet is neither claimed nor begun, it stays pending;
 * - driveMerge (scheduler-merge-driver.ts) through MergeExternal.mainCi: ready / await_ci end an unsent auto run as cancelled with
 *   main_ci_pause (MRGUNK1's path, scheduler-merge-unsent.ts: slot freed, no freeze, not counted); updating skips bounces;
 * - the train tick (scheduler-merge-train-tick.ts): a testing / settling train is voided (no culprit, no bounce), then cleans up.
 * A PM repair binding (`ledger main-ci-repair`, planMainCi's approval) lets exactly that card / head / main / fault through the serial path.
 */
import type { Database } from "bun:sqlite";
import { getTask, listEvents } from "./ledger-store.js";
import { notifyProjectPm } from "./pm-notify.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { runBounded } from "./run-bounded.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { projectRepo } from "./scheduler-foreign-repo.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { MainCiHealth, MainCiTarget } from "./scheduler-main-ci.js";
import { planMainCi, type MainCiPlan } from "./scheduler-main-ci-plan.js";
import { readMainCiNow } from "./scheduler-main-ci-wiring-gh.js";
import {
  MAIN_CI_MAX_AGE_MS, mainCiApprovals, mainCiClaims, mainCiNoticeText, mainCiPms, mainCiReasonText, nextMainCiState, readMainCiState,
  sameMainCiState, type MainCiPersisted,
} from "./scheduler-main-ci-wiring-store.js";
import type { MainCiDecision, MergeExternal } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";
import { MAIN_CI_PAUSE, unsentAuto } from "./scheduler-merge-unsent.js";
import type { TrainDeps, TrainState, TrainStore } from "./scheduler-merge-train.js";
import { defaultTrainStore } from "./scheduler-merge-train-hold-slot.js";
import { trainCandidates } from "./scheduler-merge-train-tick.js";
import { isTestProcess } from "./test-guard.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type Command = typeof runBounded;
type ProjectSchedule = SchedulerConfig["projects"][string];
interface ProjectRead { target: MainCiTarget; health: MainCiHealth; currentMainSha: string | null; state: MainCiPersisted }
interface Gate { db: Database; now: () => number; modes: Map<string, RecoveryMode>; reads: Map<string, ProjectRead> }
/** What the pass hands in: its guarded ledger child and gh command, CFG's policy port, the train store, the lease check. */
export interface MainCiPassDeps { manager: Manager; command: Command; policy?: RecoveryPolicyPort; trains?: TrainStore | null; active?: () => void }
/** MQ1's gate (manual-merge-queue-pass.ts); the main CI gate is composed into these two in place. */
interface TrainFence { blocks(project: string): boolean; formFence(project: string, save: () => void): void }

/** Tests only: a fake gh command (the real envelope code still runs), a PM notice recorder and a clock. */
interface TestPorts { command?: Command; notify?: (project: string, text: string) => Promise<void>; now?: () => number }
let testPorts: TestPorts = {};
export function setMainCiPortsForTest(p: TestPorts | null): void { testPorts = p ?? {}; }

const gates = new WeakMap<Database, Gate>();
const owners = new WeakMap<ProjectSchedule, Database>();
const stopped = (e: unknown) => e instanceof SchedulerStopped;
const warn = (project: string, what: string, e: unknown) => console.error(`⚠️ [main-ci] ${project} ${what}：${(e as Error).message}`);

function modeOf(policy: RecoveryPolicyPort, project: string): RecoveryMode {
  try { return policy(project, "mainCiPause").mode; } catch { return "off"; } // an unreadable policy is off, as MQ1 reads it
}

/** Read only when something could merge or ride a train: a pending / submitted merge intent, a live train or a train candidate. */
function wanted(db: Database, project: string, trains: TrainStore | null | undefined): boolean {
  if (db.query("SELECT 1 FROM scheduler_intents WHERE project = ? AND action = 'merge' AND status IN ('pending','submitted') LIMIT 1").get(project)) return true;
  try {
    const live = (trains === undefined ? defaultTrainStore() : trains)?.load(project);
    if (live && live.phase !== "done") return true;
  } catch { return true; } // a corrupt train file: the train tick reports it, the read keeps the pause decision honest
  try { return trainCandidates(db, project).length > 0; } catch { return false; }
}

function planFor(gate: Gate, project: string, candidate: { taskId: string; head: string }, claims: readonly string[] = []): MainCiPlan | null {
  const read = gate.reads.get(project);
  if (!read) return null;
  const approvals = mainCiApprovals(gate.db, project, read.target.repo);
  return planMainCi({ target: read.target, health: read.health, currentMainSha: read.currentMainSha, now: gate.now(), maxAgeMs: MAIN_CI_MAX_AGE_MS,
    readFailureSince: read.state.readFailureSince, uncertainty: read.state.uncertainty, candidate: { project, repo: read.target.repo, ...candidate },
    projectPms: mainCiPms(gate.db, project, approvals), approvals, notificationClaims: claims });
}

/** on only; a project that should have been read but was not (its read threw) pauses: never green by default. */
function decide(gate: Gate, project: string, taskId: string, head: string): "go" | "pause" {
  if (gate.modes.get(project) !== "on") return "go";
  return planFor(gate, project, { taskId, head })?.actions.merge === "normal-gates" ? "go" : "pause";
}
const trainPaused = (gate: Gate, project: string): boolean =>
  gate.modes.get(project) === "on" && planFor(gate, project, { taskId: "", head: "" })?.actions.formTrain !== "normal-gates";

async function ledger(m: Manager, project: string, op: string, ...args: string[]): Promise<Record<string, unknown>> {
  const r = await m("ledger", "scheduler-main-ci", project, "--op", op, ...args);
  if (r.ok !== true) throw new Error(`scheduler-main-ci ${op}：${String(r.error ?? "失败")}`);
  return r;
}

async function notify(gate: Gate, project: string, text: string, active?: () => void): Promise<void> {
  if (testPorts.notify) return testPorts.notify(project, text);
  const alive = () => { try { active?.(); return true; } catch { return false; } };
  active?.();
  try { await notifyProjectPm(gate.db, project, text, { fromName: "scheduler", stillActive: alive }); } finally { active?.(); }
}

/** One read of one project, then its durable state, its observe note and its PM notice; the gate keeps the read for this pass. */
async function readProject(gate: Gate, project: string, policy: ProjectSchedule, mode: "on" | "observe", deps: MainCiPassDeps): Promise<void> {
  const target: MainCiTarget = { project, repo: projectRepo(policy) ?? "", requiredChecks: [...policy.requiredChecks] };
  const { health, currentMainSha: current } = await readMainCiNow(target, testPorts.command ?? deps.command, policy.repoDir, gate.now);
  const prev = readMainCiState(gate.db, project), state = nextMainCiState(health, prev);
  gate.reads.set(project, { target, health, currentMainSha: current, state });
  if (!sameMainCiState(prev, state)) {
    await ledger(deps.manager, project, "state", "--read-failure-since", state.readFailureSince === null ? "none" : String(state.readFailureSince),
      "--uncertainty", state.uncertainty ? JSON.stringify(state.uncertainty) : "none");
  }
  const plan = planFor(gate, project, { taskId: "", head: "" }, mainCiClaims(gate.db, project))!;
  if (mode === "observe" && plan.actions.formTrain === "pause") {
    await ledger(deps.manager, project, "observe", "--sha", health.mainSha ?? "none", "--state", health.state,
      "--reason", `${plan.reason}：${mainCiReasonText(health)}`);
  }
  const n = plan.notification;
  if (!n) return;
  // claim first, durably; a lost claim (another process, an earlier run) means no send, and a send that fails after it is not retried
  const claim = await ledger(deps.manager, project, "claim", "--key", n.key, "--kind", n.kind, "--sha", n.mainSha ?? "none");
  if (claim.claimed === true) await notify(gate, project, mainCiNoticeText(target, health, n, mode), deps.active);
}

/** The pass's one call (scheduler-pass.ts). Never throws for a project's read or write, only for a stop. */
export async function mainCiPass(db: Database, config: SchedulerConfig, manual: TrainFence, deps: MainCiPassDeps): Promise<void> {
  const gate: Gate = { db, now: testPorts.now ?? Date.now, modes: new Map(), reads: new Map() };
  gates.set(db, gate);
  for (const [project, policy] of Object.entries(config.projects)) {
    owners.set(policy, db);
    if (policy.mergeHandoff) continue; // the repository owner merges (MHO1): no train, no merge driver here
    const mode = modeOf(deps.policy ?? recoveryPolicy, project);
    gate.modes.set(project, mode);
    // off: no GitHub read, no note, no notice; a test process has no live default (as the train's context): only an injected gh reads
    if (mode === "off" || (isTestProcess() && !testPorts.command) || !wanted(db, project, deps.trains)) continue;
    try { await readProject(gate, project, policy, mode, deps); }
    catch (e) { if (stopped(e)) throw e; warn(project, "主线 CI 读取 / 记录失败", e); }
  }
  const { blocks, formFence } = manual;
  manual.blocks = (project) => blocks(project) || trainPaused(gate, project);
  manual.formFence = (project, save) => {
    if (trainPaused(gate, project)) throw new Error(`${project} 主线 CI 红或不明（main_ci_pause），本轮不组新车`);
    formFence(project, save);
  };
}

/** mergeTick: a paused intent that has no run yet stays pending (no claim, no scheduler-merge-begin). */
export function mainCiHolds(db: Database, taskId: string): boolean {
  const gate = gates.get(db), task = gate && getTask(db, taskId);
  if (!gate || !task) return false;
  try { return decide(gate, task.project, task.id, task.headSHA ?? "") === "pause"; }
  catch (e) { warn(task.project, "主线 CI 判定失败，按暂停", e); return gate.modes.get(task.project) === "on"; }
}

function pauseReceipt(gate: Gate, run: MergeRun): string {
  const read = gate.reads.get(run.project), plan = planFor(gate, run.project, { taskId: run.taskId, head: run.reviewedHead });
  const what = read ? `main ${read.health.mainSha?.slice(0, 12) ?? "未读到"} ${read.health.state}：${mainCiReasonText(read.health)}` : "本轮没有读到主线 CI";
  return `${MAIN_CI_PAUSE}：主线 CI 暂停（${plan?.reason ?? "unread"}，${what}），未发出合并，取消且不冻结`.slice(0, 600);
}

/** The driver's question at ready / updating / await_ci: go on, wait (a run MRGUNK1 cannot cancel), or cancel it unsent. */
function runDecision(policy: ProjectSchedule, run: MergeRun): MainCiDecision {
  const db = owners.get(policy), gate = db && gates.get(db);
  if (!gate) return "go";
  try {
    if (decide(gate, run.project, run.taskId, run.reviewedHead) === "go") return "go";
    return unsentAuto(gate.db, run, listEvents(gate.db, { project: run.project, target: run.taskId })) ? { cancel: pauseReceipt(gate, run) } : "wait";
  } catch (e) {
    warn(run.project, "主线 CI 判定失败，本轮不动", e);
    return gate.modes.get(run.project) === "on" ? "wait" : "go";
  }
}

/** Assembled in scheduler-merge-external.ts, like withMergeTrain: the gate reaches the driver as an optional MergeExternal method. */
export function withMainCi(base: MergeExternal, policy: ProjectSchedule): MergeExternal {
  return { ...base, mainCi: async (run) => runDecision(policy, run) };
}

/** Train tick: a train still testing or settling while main is paused is voided (no culprit, no bounce); stepTrain then cleans up. */
export async function mainCiTrainPause(db: Database, s: TrainState, deps: Pick<TrainDeps, "store" | "now" | "notify">): Promise<void> {
  const gate = gates.get(db);
  if (!gate || (s.phase !== "testing" && s.phase !== "settling") || !trainPaused(gate, s.project)) return;
  const reason = "主线 CI 红或不明（main_ci_pause），不判 culprit、不退回成员";
  s.phase = "cleanup"; s.outcome = "void"; s.reason = reason; s.updatedAt = deps.now();
  deps.store.save(s);
  const text = `作废：${reason}；已合并 ${s.merged.map((m) => m.taskId).join("、") || "（无）"}，其余留在 merge`;
  deps.store.event(s.project, { at: deps.now(), train: s.id, seq: s.seq, kind: "void", text, data: { reason, cause: MAIN_CI_PAUSE } });
  await deps.notify(s, `[合并列车] 第 ${s.seq} 辆车 ${s.id}：${text}`, false);
}
