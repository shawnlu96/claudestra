/**
 * Right of way for a live merge train (i28-MT1f2, i28-MT1f2f2). While a project's train is testing or settling, any merge into
 * main that is not one of its riding members voids the whole train and throws its CI away. Its members merge one by one, and each
 * needs the project's only merge slot (`merge:<project>`, held from the merge intent's plan until it settles; beginMergeRun requires it).
 * So the wait happens around the slot, never by voiding a healthy train:
 * - a card the train will not merge gets no merge intent while the train lives (scheduler-merge-train-hold-slot.ts, asked by the
 *   auto tick right before it plans);
 * - a card outside the train that already holds the slot but has sent no merge yet (ready / await_ci) lends it to the train: the
 *   merge pass journals a same-phase step that gives the slot up (turnMergeSlot), the run waits with a readable reason, and once
 *   the train is done, void or past HOLD_LIMIT_MS it takes the slot back the same way and goes on. Not a bounce, not unknown;
 * - a card already merging keeps the slot, and no train forms until it settles (trainProjects).
 * A train still testing or settling past HOLD_LIMIT_MS is judged stuck: the hold lifts, and the first outsider to reach the
 * driver gate voids it and goes on serially.
 */
import type { Database } from "bun:sqlite";
import type { WriteCtx } from "./ledger-checks.js";
import { LedgerError } from "./ledger-store.js";
import { insertEvent } from "./ledger-tx.js";
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
 * trainGate's answer for a run the train will not merge. While the train holds, the merge pass has it give the slot up before
 * driving it (scheduler-merge-train-hold-slot.ts mergeSlotTurn), so it only gets here in the pass it began: it waits, and the
 * next pass lends the slot to the train. Past the limit the stuck train is voided and the run goes on serially.
 */
export async function releaseOutsider<D extends Io>(s: TrainState, run: MergeRun, deps: D,
  voidTrain: (s: TrainState, deps: D, reason: string) => Promise<void>): Promise<"wait" | null> {
  if (s.phase !== "testing" && s.phase !== "settling") return null;
  if (trainHolds(s, deps.now())) return "wait";
  await voidTrain(s, deps, `列车超时：${HOLD_STEP[s.phase]}超过 ${HOLD_LIMIT_MS / 60_000} 分钟仍未结束，放行串行合并 ${run.taskId}`);
  return null;
}

/** Same-phase merge step receipts that move the project merge slot (no external effect, so no new phase). */
export const SLOT_YIELD = "让出合并槽：", SLOT_RECLAIM = "取回合并槽，接着合并";
export const isSlotTurn = (receipt: string | undefined): receipt is string => receipt === SLOT_RECLAIM || !!receipt?.startsWith(SLOT_YIELD);

/**
 * The ledger side of a slot turn, inside advanceMergeRun's transaction (scheduler-merge.ts observeMergeState, after its drift check).
 * Yield: only a run that holds the slot and has sent no merge (ready / await_ci; updating finishes its update first). Reclaim:
 * only a free slot. Either way the run's revision moves, so a racing step is refused.
 */
export function turnMergeSlot(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, now: number): void {
  const lock = `merge:${row.project}`, give = receipt !== SLOT_RECLAIM;
  const holder = db.query("SELECT intentId FROM scheduler_resources WHERE project = ? AND resource = ?").get(row.project, lock) as
    { intentId: string } | null;
  if (give && (row.phase !== "ready" && row.phase !== "await_ci")) throw new LedgerError("conflict", `合并步骤在 ${row.phase}，不能让出合并槽`);
  if (give && holder?.intentId !== row.intentId) throw new LedgerError("conflict", "本意图未占项目合并槽，无从让出");
  if (!give && holder) throw new LedgerError("conflict", holder.intentId === row.intentId ? "本意图已占项目合并槽" : "项目合并槽仍被占用");
  if (give) db.prepare("DELETE FROM scheduler_resources WHERE project = ? AND resource = ? AND intentId = ?").run(row.project, lock, row.intentId);
  else db.prepare("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES (?, ?, ?, ?, ?, 'intent')")
    .run(row.project, lock, row.taskId, row.intentId, now);
  db.prepare("UPDATE scheduler_merges SET rev = rev + 1, updatedAt = ? WHERE intentId = ?").run(now, row.intentId);
  insertEvent(db, { actor: ctx.actor, now }, { project: row.project, target: row.taskId, kind: "scheduler", text: `合并队列：${receipt}`,
    data: { op: "merge_slot", intentId: row.intentId, phase: row.phase, turn: give ? "yield" : "reclaim", receipt } }, false);
}
