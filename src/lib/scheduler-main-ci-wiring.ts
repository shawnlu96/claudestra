/**
 * MAINCIW: wires MAINCI's main health (scheduler-main-ci.ts readMainCi) and plan (scheduler-main-ci-plan.ts planMainCi) into production.
 * Recovery key mainCiPause (default observe): on = pause, observe = the old scheduling byte for byte plus one "本会暂停" note per
 * (mainSha, state) and the PM notices, off = the old scheduling with no GitHub read, no note, no notice.
 *
 * One gate per scheduler pass (scheduler-pass.ts, right after the MQ1 manualMergeGate): mainCiPass reads each local-merge project at
 * most once, only when it has a pending / submitted merge intent, a train candidate or a live train, persists planMainCi's state through
 * the scheduler's guarded ledger child (`scheduler-main-ci`, the pass's connection is query_only), records observe notes, claims and
 * sends PM notices, and composes the train's blocks / formFence with MQ1's (either refusing = no train). The gate is then found by
 * the ledger connection (mergeTick, the train tick) or the project policy object (mergeExternal) for the rest of the pass
 * (scheduler-main-ci-wiring-gate.ts):
 * - mergeTick (scheduler-service.ts): a paused intent with no run yet is neither claimed nor begun, it stays pending;
 * - the merge drive (scheduler-main-ci-wiring-driver.ts mainCiDrive asks MergeExternal.mainCi before driveMerge, which stays
 *   unchanged): ready / await_ci end an unsent auto run as cancelled with
 *   main_ci_pause (MRGUNK1's path, scheduler-merge-unsent.ts: slot freed, no freeze, not counted); updating skips bounces;
 * - the train tick (scheduler-merge-train-tick.ts): a testing / settling train is voided (no culprit, no bounce), then cleans up.
 * A PM repair binding (`ledger main-ci-repair`, planMainCi's approval) lets exactly that card / head / main / fault through the serial path.
 */
import type { Database } from "bun:sqlite";
import { notifyProjectPm } from "./pm-notify.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { runBounded } from "./run-bounded.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import { projectRepo } from "./scheduler-foreign-repo.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { MainCiTarget } from "./scheduler-main-ci.js";
import { mainCiPlanFor, mainCiTestPorts, mainCiTrainPaused, openMainCiGate, warnMainCi, type MainCiGate } from "./scheduler-main-ci-wiring-gate.js";
import { readMainCiNow } from "./scheduler-main-ci-wiring-gh.js";
import { mainCiClaims, mainCiNoticeText, mainCiReasonText, nextMainCiState, readMainCiState, sameMainCiState } from "./scheduler-main-ci-wiring-store.js";
import type { TrainStore } from "./scheduler-merge-train.js";
import { defaultTrainStore } from "./scheduler-merge-train-hold-slot.js";
import { trainCandidates } from "./scheduler-merge-train-tick.js";
import { isTestProcess } from "./test-guard.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
type ProjectSchedule = SchedulerConfig["projects"][string];
/** What the pass hands in: its guarded ledger child and gh command, CFG's policy port, the train store, the lease check. */
export interface MainCiPassDeps { manager: Manager; command: typeof runBounded; policy?: RecoveryPolicyPort; trains?: TrainStore | null; active?: () => void }
/** MQ1's gate (manual-merge-queue-pass.ts); the main CI gate is composed into these two in place. */
interface TrainFence { blocks(project: string): boolean; formFence(project: string, save: () => void): void }
const stopped = (e: unknown) => e instanceof SchedulerStopped;

function modeOf(policy: RecoveryPolicyPort, project: string): RecoveryMode {
  try { return policy(project, "mainCiPause").mode; }
  catch (e) { warnMainCi(project, "mainCiPause 档位读不到，按 off（与 MQ1 读坏策略同口径：调度保持改前行为）", e); return "off"; }
}

/** Read only when something could merge or ride a train: a pending / submitted merge intent, a live train or a train candidate. */
function wanted(db: Database, project: string, trains: TrainStore | null | undefined): boolean {
  if (db.query("SELECT 1 FROM scheduler_intents WHERE project = ? AND action = 'merge' AND status IN ('pending','submitted') LIMIT 1").get(project)) return true;
  try {
    const live = (trains === undefined ? defaultTrainStore() : trains)?.load(project);
    if (live && live.phase !== "done") return true;
  } catch (e) { warnMainCi(project, "列车状态读不到，照读主线（列车 tick 另报）", e); return true; } // the read keeps the pause decision honest
  try { return trainCandidates(db, project).length > 0; }
  catch (e) { warnMainCi(project, "列车候选扫描失败，照读主线", e); return true; } // reading anyway only makes the decision better informed
}

async function ledger(m: Manager, project: string, op: string, ...args: string[]): Promise<Record<string, unknown>> {
  const r = await m("ledger", "scheduler-main-ci", project, "--op", op, ...args);
  if (r.ok !== true) throw new Error(`scheduler-main-ci ${op}：${String(r.error ?? "失败")}`);
  return r;
}

async function notify(gate: MainCiGate, project: string, text: string, active?: () => void): Promise<void> {
  if (mainCiTestPorts.notify) return mainCiTestPorts.notify(project, text);
  const alive = () => { try { active?.(); return true; } catch { return false; } };
  active?.();
  try { await notifyProjectPm(gate.db, project, text, { fromName: "scheduler", stillActive: alive }); } finally { active?.(); }
}

/** One read of one project, then its durable state, its observe note and its PM notice; the gate keeps the read for this pass. */
async function readProject(gate: MainCiGate, project: string, policy: ProjectSchedule, mode: "on" | "observe", deps: MainCiPassDeps): Promise<void> {
  const target: MainCiTarget = { project, repo: projectRepo(policy) ?? "", requiredChecks: [...policy.requiredChecks] };
  const { health, currentMainSha: current } = await readMainCiNow(target, mainCiTestPorts.command ?? deps.command, policy.repoDir, gate.now);
  const prev = readMainCiState(gate.db, project), state = nextMainCiState(health, prev);
  gate.reads.set(project, { target, health, currentMainSha: current, state });
  if (!sameMainCiState(prev, state)) {
    await ledger(deps.manager, project, "state", "--read-failure-since", state.readFailureSince === null ? "none" : String(state.readFailureSince),
      "--uncertainty", state.uncertainty ? JSON.stringify(state.uncertainty) : "none");
  }
  const plan = mainCiPlanFor(gate, project, { taskId: "", head: "" }, mainCiClaims(gate.db, project))!;
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
  const gate = openMainCiGate(db, config);
  for (const [project, policy] of Object.entries(config.projects)) {
    if (policy.mergeHandoff) continue; // the repository owner merges (MHO1): no train, no merge driver here
    const mode = modeOf(deps.policy ?? recoveryPolicy, project);
    gate.modes.set(project, mode);
    // off: no GitHub read, no note, no notice; a test process has no live default (as the train's context): only an injected gh reads
    if (mode === "off" || (isTestProcess() && !mainCiTestPorts.command) || !wanted(db, project, deps.trains)) continue;
    try { await readProject(gate, project, policy, mode, deps); }
    catch (e) { if (stopped(e)) throw e; warnMainCi(project, "主线 CI 读取 / 记录失败", e); }
  }
  const { blocks, formFence } = manual;
  manual.blocks = (project) => blocks(project) || mainCiTrainPaused(gate, project);
  manual.formFence = (project, save) => {
    if (mainCiTrainPaused(gate, project)) throw new Error(`${project} 主线 CI 红或不明（main_ci_pause），本轮不组新车`);
    formFence(project, save);
  };
}
