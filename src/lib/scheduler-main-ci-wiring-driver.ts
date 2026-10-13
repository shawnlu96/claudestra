/**
 * MAINCIW, the merge driver's side: MergeExternal.mainCi (scheduler-main-ci-wiring-gate.ts withMainCi) answers go / wait / cancel,
 * asked by mergeTick's drive (mainCiDrive) at ready / updating / await_ci before driveMerge can bounce, update-branch, rerun or merge.
 * At updating the update already sent is only read back: no bounce while paused, the run goes on to await_ci whose gate then ends it.
 */
import { ciBehindGh, type CiBehindGh } from "./scheduler-merge-ci-behind.js";
import { ciRerunGh, type CiRerunGh } from "./scheduler-merge-ci-rerun.js";
import { isTestProcess } from "./test-guard.js";
import { MAIN_CI_UPDATE_NOT_SENT } from "./scheduler-merge-unsent.js";
import { carryChainSuffix } from "./review-main-carry-manual-auto.js";
import { carryReceipt, type MergePhase, type MergeRun } from "./scheduler-merge.js";
import { driveMerge, type ForeignEscalate, type MergeAdvance, type MergeExternal, type PrSnapshot, type Recheck, type ReviewCarry } from "./scheduler-merge-driver.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { mainCiDecideNow } from "./scheduler-main-ci-wiring-gate.js";
import { movedHeadReceipt } from "./scheduler-review-rebase.js";

type Step = (to: MergePhase, receipt?: string, mergeSha?: string, newHead?: string) => Promise<MergeRun>;
export { mainCiHolds } from "./scheduler-main-ci-wiring.js"; // mergeTick's other question, one import for scheduler-service.ts

/**
 * mergeTick's drive: the gate is asked before driveMerge, so a paused run never reaches its bounce / update-branch / rerun / merge.
 * Paused: one read of the PR, then only a cancel (unsent auto run at ready / await_ci → unknown → MRGUNK1's main_ci_pause cancel),
 * the updating read-back below, or a wait. A PR that is no longer this run's own open PR goes to driveMerge unchanged (its old
 * anomaly handling for PM); a moved head or a draft is cancelled like any unsent run. A failed read waits: never a freeze, never an effect.
 */
export async function mainCiDrive(run: MergeRun, source: MergeExternal, advance: MergeAdvance, assertActive: () => void = () => {},
  recheck?: Recheck, foreign?: ForeignEscalate): Promise<MergeRun> {
  const d = ["ready", "updating", "await_ci"].includes(run.phase) ? await source.mainCi?.(run) : undefined;
  if (!d) return driveMerge(run, source, advance, assertActive, recheck, foreign);
  if (d === "go") return goDrive(run, source, advance, assertActive, recheck, foreign);
  let pr: PrSnapshot;
  try { pr = await source.inspect(run.prRef); }
  catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [main-ci] ${run.taskId} 暂停中读 PR 失败，下一轮再看：${(e as Error).message}`);
    return run;
  }
  if (pr.state !== "OPEN" || pr.base !== "main" || pr.crossRepository || pr.branch !== run.expectedBranch) {
    return driveMerge(run, source, advance, assertActive, recheck, foreign);
  }
  const step: Step = (to, receipt, mergeSha, newHead) => { assertActive(); return advance(run.phase, to, run.rev, receipt, mergeSha, newHead); };
  if (run.phase === "updating") return mainCiUpdating(run, source, pr, step);
  // a draft or a moved head still cancels: nothing was sent, the slot is freed, and the next run (after the pause) meets the
  // draft / moved head in driveMerge as before; waiting on it here would hold the merge slot for as long as main stays red
  return d === "wait" ? run : step("unknown", d.cancel);
}

/** Recovery helpers translate send errors into bounce steps; guarded returns the held or cancelled run for this sentinel. */
class MainCiEnded extends Error {}

/**
 * A go is asked again, fresh (the PM binding re-read from the ledger, the pass's main read re-aged), right before each claim of an
 * external effect, including CI recovery claims, and again at each update / rerun send. Both injected and production fallback ports obey it. A PM revoke,
 * or a binding gone stale, after the first ask stops the run there: an unsent auto run is cancelled main_ci_pause (MRGUNK1, slot
 * freed, no freeze), any other run is left as it is for the next pass. Without the gate (observe / off, a green main) this is driveMerge.
 */
async function goDrive(run: MergeRun, source: MergeExternal, advance: MergeAdvance, assertActive: () => void,
  recheck?: Recheck, foreign?: ForeignEscalate): Promise<MergeRun> {
  let last = run, ended: MergeRun | null = null, stopped: SchedulerStopped | null = null;
  const stop = async (receipt: string | null): Promise<never> => {
    ended = last; // Recovery helpers translate send errors into bounce steps; those steps must return this held run if cancellation fails.
    try { if (receipt) ended = await advance(last.phase, "unknown", last.rev, receipt); }
    catch (e) {
      if (e instanceof SchedulerStopped) { stopped = e; throw e; }
      console.error(`⚠️ [main-ci] ${last.taskId} 未发送外部请求，取消写入失败，保留运行待核对：${(e as Error).message}`);
    }
    throw new MainCiEnded("主线 CI 闸收回放行，外部请求未发出");
  };
  const guarded: MergeAdvance = async (from, to, rev, receipt, mergeSha, newHead) => {
    if (stopped) throw stopped;
    if (ended) return ended;
    if (to === "updating" || to === "merging" || to === "resolved") {
      const again = mainCiDecideNow(source, last);
      if (again !== "go") {
        return stop(typeof again === "object" ? again.cancel : null);
      }
    }
    return (last = await advance(from, to, rev, receipt, mergeSha, newHead));
  };
  // after the merging claim nothing can cancel unsent: a stop here is the driver's own "not sent" unknown (PM checks), never a merge
  const before: Recheck = (m) => recheck?.(m) ?? (m.beforeSend && mainCiDecideNow(source, m) !== "go" ? "主线 CI 修复绑定或主线读数已失效（main_ci_pause）" : null);
  // Claims can return a different phase (CIF2 resolved → updating); the actual returned run and fresh binding decide every send.
  const sendEffect = async (send: () => Promise<void>, update = false) => {
    if (stopped) throw stopped;
    if (ended) throw new MainCiEnded("主线 CI 闸已收回放行");
    const again = mainCiDecideNow(source, last);
    // A rerun during updating may follow an earlier update already sent; only this update send can attest it was unsent.
    if (again !== "go") return stop(last.phase === "updating"
      ? update ? `${MAIN_CI_UPDATE_NOT_SENT}主线 CI 修复绑定或主线读数已失效，取消且不冻结` : null
      : typeof again === "object" ? again.cancel : null);
    return send();
  };
  type Hosted = MergeExternal & { ciBehind?: CiBehindGh; ciRerun?: CiRerunGh };
  const external: Hosted = { ...source, updateBranch: (pr) => sendEffect(() => source.updateBranch(pr), true) };
  // Resolve defaults here, before wrapping: otherwise the CI helpers create a new unguarded port when stage-two is absent.
  const behind = (source as Hosted).ciBehind ?? (isTestProcess() ? null : ciBehindGh());
  const rerun = (source as Hosted).ciRerun ?? (isTestProcess() ? null : ciRerunGh());
  if (behind) external.ciBehind = { ...behind, updateBranch: (repo, pull, head) => sendEffect(() => behind.updateBranch(repo, pull, head), true) };
  if (rerun) external.ciRerun = { ...rerun, rerunFailed: (repo, id) => sendEffect(() => rerun.rerunFailed(repo, id)) };
  return driveMerge(run, external, guarded, assertActive, before, foreign);
}

/**
 * updating while paused: the update-branch already sent is read back only. Still running (BEHIND / UNKNOWN / draft) = next round;
 * done = await_ci, carrying the review only for a pure "merge main in" head (else back to review, as the driver does); never a bounce.
 */
async function mainCiUpdating(run: MergeRun, external: MergeExternal, pr: PrSnapshot, step: Step): Promise<MergeRun> {
  if (pr.draft || pr.mergeState === "BEHIND" || pr.mergeState === "UNKNOWN") return run;
  if (pr.head.toLowerCase() === run.reviewedHead.toLowerCase()) return step("await_ci", `head ${pr.head.slice(0, 12)} 未变，等待 CI（主线 CI 暂停，不判退回）`);
  let carry: ReviewCarry;
  try { carry = await external.carryReview(run.prRef, run.reviewedHead, pr.head); }
  catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    carry = { ok: false, reason: `核对失败：${(e as Error).message.slice(0, 200)}` };
  }
  if (!carry.ok || !carry.mainParent || !carry.mainHead || !carry.diffHash) {
    return step("await_review", movedHeadReceipt(run.reviewedHead, pr.head, carry), undefined, pr.head);
  }
  return step("await_ci", carryReceipt({ oldHead: run.reviewedHead, newHead: pr.head, mainParent: carry.mainParent, mainHead: carry.mainHead,
    diffHash: carry.diffHash }) + carryChainSuffix(carry.chain), undefined, pr.head);
}
