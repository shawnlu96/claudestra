/**
 * Right of way for a live merge train (i28-MT1f2). While a project's train is testing or settling, any merge into main that is not
 * one of its riding members voids the whole train and throws its CI away, so such a merge run waits at ready / await_ci (no
 * update-branch, no merge; trainGate in scheduler-merge-train.ts asks here) until the train is done or void. The wait is a plain
 * "wait" (the run keeps its phase: not unknown, not a bounce), and its reason is one train event per card and phase.
 * A train that is still testing or settling past HOLD_LIMIT_MS is judged stuck: it is voided and the waiting card goes on serially.
 */
import type { MergeRun } from "./scheduler-merge.js";
import type { TrainDeps, TrainState } from "./scheduler-merge-train.js";

/** The train's own CI timeout (TRAIN_CI_TIMEOUT_MS), counted from the train's start: past it the train no longer holds anyone. */
export const HOLD_LIMIT_MS = 60 * 60_000;
const STEP: Record<string, string> = { testing: "拼车 / 跑 CI", settling: "逐张合并" };
/** Cards already told why they wait, so a wait that lasts many passes is one event, not one per pass (a restart may repeat it once). */
const told = new Set<string>();

/** The reason a card outside the train waits; the train's label matches trainView. */
const holdReason = (s: TrainState, taskId: string): string =>
  `${taskId} 等第 ${s.seq} 辆列车 ${s.id} 结束（${STEP[s.phase] ?? s.phase}）再走串行合并，不 update-branch、不合并`;

type Io = Pick<TrainDeps, "store" | "now" | "notify">;
export async function holdForTrain<D extends Io>(s: TrainState, run: MergeRun, deps: D,
  voidTrain: (s: TrainState, deps: D, reason: string) => Promise<void>): Promise<"wait" | null> {
  if (s.phase !== "testing" && s.phase !== "settling") return null;
  if (deps.now() - s.startedAt > HOLD_LIMIT_MS) {
    await voidTrain(s, deps, `列车超时：${STEP[s.phase]}超过 ${HOLD_LIMIT_MS / 60_000} 分钟仍未结束，放行串行合并 ${run.taskId}`);
    return null;
  }
  const key = `${s.project} ${s.id} ${s.phase} ${run.intentId}`;
  if (!told.has(key)) {
    if (told.size >= 500) told.clear();
    told.add(key);
    deps.store.event(s.project, { at: deps.now(), train: s.id, seq: s.seq, kind: "hold", text: holdReason(s, run.taskId),
      data: { taskId: run.taskId, intentId: run.intentId, phase: s.phase } });
  }
  return "wait";
}
