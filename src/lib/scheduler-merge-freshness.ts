/**
 * dispatch-recovery-MRGFRESH1: the serial merge path's last look at main. The run's CI went green against one main (the
 * freshness read that found the branch up to date); the durable `merging` claim is awaited after that read, and main can
 * move meanwhile. Right after the claim the driver asks once more and compares: a moved, lagging or unreadable main ends
 * the claim with an explicit unsent receipt (MERGE_NOT_SENT — the merge call was never made). The ledger settles that receipt
 * as it does every pre-send refusal (scheduler-merge.ts advanceMergeRun), and whichever attempt comes next reads the head
 * as behind from `ready` and refreshes the branch first.
 *
 * This narrows the window; it does not close it. The REST merge only pins the PR head (`sha`), there is no compare-and-swap
 * on main, so main can still move between this read and GitHub applying the merge. That remainder is closed only by the
 * repository's own "require branches to be up to date" / merge queue protection, which this code neither reads nor sets.
 *
 * Serial path only: a cleared train member merges on its car's joint proof (re-asked before the claim), and mergeDirect
 * never chases main, so neither is judged by "behind main = 0" here.
 */
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { MainFreshness, MergeExternal } from "./scheduler-merge-driver.js";
import type { MergeRun } from "./scheduler-merge.js";

const MAIN_MOVED_AT_CLAIM = "领取 merging 期间 main 已变";
const MAIN_UNREAD_AT_CLAIM = "领取 merging 后读不到 main";
const SHA = /^[a-f0-9]{40}$/i;

/** Why the main the CI ran against is no longer the main about to be merged into; null = same head, nothing behind. */
function mainDrift(ci: MainFreshness, last: MainFreshness): string | null {
  if (typeof last?.mainHead !== "string" || !SHA.test(last.mainHead) || !Number.isSafeInteger(last.behindBy) || last.behindBy < 0) {
    return `${MAIN_UNREAD_AT_CLAIM}：读数无效`;
  }
  if (last.behindBy === 0 && last.mainHead.toLowerCase() === String(ci.mainHead).toLowerCase()) return null;
  return `${MAIN_MOVED_AT_CLAIM}：CI 全绿时 main ${ci.mainHead}，发出前 main ${last.mainHead}，落后 ${last.behindBy} 个提交`;
}

/**
 * The read between the `merging` claim and the merge call. A failed lookup is a refusal too (it never reads as "up to date"),
 * and since nothing was sent yet it is reported as unsent instead of escaping as an unverified external step.
 */
export async function mainMovedSinceCi(external: Pick<MergeExternal, "freshness">, run: Pick<MergeRun, "prRef" | "reviewedHead">,
  ci: MainFreshness, assertActive: () => void): Promise<string | null> {
  let last: MainFreshness;
  try {
    last = await external.freshness(run.prRef, run.reviewedHead);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    const why = String((e as Error)?.message ?? e).replace(/[\p{Cc}\p{Cf}\u2028\u2029\s]+/gu, " ").trim().slice(0, 200);
    return `${MAIN_UNREAD_AT_CLAIM}：${why}`;
  }
  assertActive();
  return mainDrift(ci, last);
}
