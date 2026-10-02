/**
 * Right of way for a live merge train (i28-MT1f2). While a project's train is testing or settling, any merge into main that is not
 * one of its riding members voids the whole train and throws its CI away. Its members merge one by one, and each needs the
 * project's only merge slot (`merge:<project>`, held from the merge intent's plan until it settles; beginMergeRun requires it).
 * So the wait happens where the slot is handed out, not in the merge driver: a card the train will not merge gets no merge intent
 * while the train lives (scheduler-merge-train-hold-slot.ts, asked by the auto tick right before it plans), and a train is not formed
 * while the slot sits with a card that can no longer ride. Holding a run in the driver instead would keep the slot from every
 * member: the train could never settle (review r1 P1 train-hold-keeps-project-slot).
 * A train still testing or settling past HOLD_LIMIT_MS is judged stuck: the hold lifts, and the first outsider to reach the
 * driver gate voids it and goes on serially.
 */
import type { MergeRun } from "./scheduler-merge.js";
import type { TrainDeps, TrainState } from "./scheduler-merge-train.js";

/** The train's own CI timeout (TRAIN_CI_TIMEOUT_MS), counted from the train's start: past it the train no longer holds anyone. */
export const HOLD_LIMIT_MS = 60 * 60_000;
const HOLD_STEP: Record<string, string> = { testing: "拼车 / 跑 CI", settling: "逐张合并" };

/** testing / settling and not past the limit: the train still has the right of way. */
export const trainHolds = (s: TrainState, now: number): boolean =>
  (s.phase === "testing" || s.phase === "settling") && now - s.startedAt <= HOLD_LIMIT_MS;

/** A member at its tested head the train will still merge (testing: any; settling: cleared) or bounce: it may take the merge slot. */
export function ridesTrain(s: TrainState, taskId: string, head: string | null): boolean {
  const m = s.members.find((x) => x.taskId === taskId && !!head && x.head.toLowerCase() === head.toLowerCase());
  if (!m || s.serial.includes(m.taskId) || s.dropped.includes(m.taskId) || s.merged.some((x) => x.taskId === m.taskId)) return false;
  return s.phase === "testing" || s.cleared.includes(m.taskId) || s.bounced.some((b) => b.taskId === m.taskId);
}

/** The reason a card outside the train waits; the train's label matches trainView. */
export const holdReason = (s: TrainState, taskId: string): string =>
  `${taskId} 等第 ${s.seq} 辆列车 ${s.id} 结束（${HOLD_STEP[s.phase] ?? s.phase}）再申请合并槽，不 update-branch、不合并`;

type Io = Pick<TrainDeps, "store" | "now" | "notify">;
/**
 * trainGate's answer for a run the train will not merge. Such a run already holds the project merge slot (no run exists without
 * it), so while it lives no member can begin: waiting here would stall the train until its timeout. It got the slot before the
 * hold could stop it (a train formed around it, or it left the train while holding the slot), so the train cannot settle anyway:
 * it is voided now, before more CI is spent on it, and the run goes on serially.
 */
export async function releaseOutsider<D extends Io>(s: TrainState, run: MergeRun, deps: D,
  voidTrain: (s: TrainState, deps: D, reason: string) => Promise<void>): Promise<null> {
  if (s.phase !== "testing" && s.phase !== "settling") return null;
  await voidTrain(s, deps, trainHolds(s, deps.now())
    ? `合并槽在本批之外的 ${run.taskId} 手里（${run.phase}），成员拿不到槽无法逐张合并，放行它走串行合并`
    : `列车超时：${HOLD_STEP[s.phase]}超过 ${HOLD_LIMIT_MS / 60_000} 分钟仍未结束，放行串行合并 ${run.taskId}`);
  return null;
}
