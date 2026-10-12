/**
 * MAINCIW, the merge driver's side (scheduler-merge-driver.ts only calls these): MergeExternal.mainCi (scheduler-main-ci-wiring.ts
 * withMainCi) answers go / wait / cancel. Asked at ready and await_ci before any bounce, update-branch, rerun or merge, and at updating
 * where the update already sent is only read back: no bounce while paused, the run goes on to await_ci whose gate then ends it.
 */
import { carryChainSuffix } from "./review-main-carry-manual-auto.js";
import { carryReceipt, type MergePhase, type MergeRun } from "./scheduler-merge.js";
import type { MergeExternal, PrSnapshot, ReviewCarry } from "./scheduler-merge-driver.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { movedHeadReceipt } from "./scheduler-review-rebase.js";

type Step = (to: MergePhase, receipt?: string, mergeSha?: string, newHead?: string) => Promise<MergeRun>;

/** ready / await_ci: null = go on as before; a paused unsent auto run ends via unknown → MRGUNK1's cancel (main_ci_pause), any other waits. */
export async function mainCiHold(run: MergeRun, external: MergeExternal, step: Step): Promise<MergeRun | null> {
  const d = await external.mainCi?.(run);
  if (!d || d === "go") return null;
  return d === "wait" ? run : step("unknown", d.cancel);
}

export const mainCiPaused = async (run: MergeRun, external: MergeExternal): Promise<boolean> => {
  const d = await external.mainCi?.(run);
  return !!d && d !== "go";
};

/**
 * updating while paused: the update-branch already sent is read back only. Still running (BEHIND / UNKNOWN / draft) = next round;
 * done = await_ci, carrying the review only for a pure "merge main in" head (else back to review, as the driver does); never a bounce.
 */
export async function mainCiUpdating(run: MergeRun, external: MergeExternal, pr: PrSnapshot, step: Step): Promise<MergeRun> {
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
