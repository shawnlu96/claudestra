/**
 * dispatch-recovery-MRGFRESH1: the two receipts the serial driver writes when its post-claim main read refuses the merge
 * (scheduler-merge-freshness.ts). Pure, so the retry planner (scheduler-merge-unsent-plan.ts) can recognise the marker
 * without a database. Only the sending controller writes these, from `merging`, before the merge call; a `merging` row
 * found after a restart is settled by the driver's mergingStep with a different receipt and never matches.
 */
/** manual-merge-queue-facts.ts MERGE_NOT_SENT, the driver's pre-send refusal prefix (same reason as scheduler-ui-review-carry.ts). */
const MERGE_NOT_SENT = "合并未发出";
export const MAIN_MOVED_AT_CLAIM = "领取 merging 期间 main 已变";
export const MAIN_UNREAD_AT_CLAIM = "领取 merging 后读不到 main";
/** The `cause` on the merge_unsent_cancel marker of such a run. */
export const CLAIM_MAIN_CAUSE = "main_moved_at_claim";

export function claimMainUnsent(receipt: unknown): receipt is string {
  return typeof receipt === "string" && [MAIN_MOVED_AT_CLAIM, MAIN_UNREAD_AT_CLAIM].some((why) => receipt.startsWith(`${MERGE_NOT_SENT}：${why}：`));
}
