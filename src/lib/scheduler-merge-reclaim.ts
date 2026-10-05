/**
 * MTR1: a run that lent its merge slot to a train takes it back before a fresh merge plan can. The pass order is
 * train → mergeTick → deployTick → … → auto tick: a member's deploy frees `merge:<project>` in deployTick, after mergeTick
 * looked at the lender, so without this step the auto tick plans a fresh merge intent onto the free slot first, and with
 * fresh cards arriving the lender (still submitted at ready / await_ci) waits forever. The pass calls this between
 * deployTick and the auto tick; per project at most one run is turned, and only through the same guarded same-phase
 * SLOT_RECLAIM merge step mergeSlotTurn uses (ledger CAS on rev + free slot + full drift check), so nothing here decides
 * on its own that a run may merge: the next mergeTick drives it through freshness, CI and the match-head merge as before.
 * Skipped: no store (test processes), an unreadable train file, a train that still holds, a busy slot, a run whose
 * latest slot turn is not a yield, a drifted run (mergeTick freezes it itself).
 */
import type { Database } from "bun:sqlite";
import { mergeRunDrift, type MergeRun } from "./scheduler-merge.js";
import type { TrainStore } from "./scheduler-merge-train.js";
import { SLOT_RECLAIM, trainHolds } from "./scheduler-merge-train-hold.js";
import { defaultTrainStore } from "./scheduler-merge-train-hold-slot.js";

type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface ReclaimResult { reclaimed: string[]; failed: { taskId: string; error: string }[] }

/** Runs that lent their slot and sent no merge yet, oldest merge intent first (mergeTick's order). */
function lenders(db: Database, project: string): MergeRun[] {
  return db.query(`SELECT m.* FROM scheduler_merges m JOIN scheduler_intents i ON i.id = m.intentId WHERE m.project = ? AND i.action = 'merge'
    AND i.status = 'submitted' AND m.phase IN ('ready','await_ci') AND (SELECT json_extract(e.data, '$.turn') FROM events e WHERE e.target = m.taskId
    AND e.kind = 'scheduler' AND json_extract(e.data, '$.op') = 'merge_slot' AND json_extract(e.data, '$.intentId') = m.intentId
    ORDER BY e.seq DESC LIMIT 1) = 'yield' ORDER BY i.eventSeq, m.createdAt`).all(project) as MergeRun[];
}

export async function reclaimLentSlots(db: Database, projects: readonly string[], manager: Manager,
  store: TrainStore | null = defaultTrainStore(), now: number = Date.now()): Promise<ReclaimResult> {
  const out: ReclaimResult = { reclaimed: [], failed: [] };
  if (!store || !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return out;
  for (const project of projects) {
    let train;
    try { train = store.load(project); } catch { continue; } // the train tick reports a corrupt file; never guess past it
    if (train && trainHolds(train, now)) continue;
    if (db.query("SELECT 1 FROM scheduler_resources WHERE project = ? AND resource = ?").get(project, `merge:${project}`)) continue;
    const run = lenders(db, project).find((r) => !mergeRunDrift(db, r, now));
    if (!run) continue;
    const r = await manager("ledger", "scheduler-merge-step", run.intentId, "--from", run.phase, "--to", run.phase, "--rev", String(run.rev),
      "--receipt", SLOT_RECLAIM);
    if (r.ok === true) out.reclaimed.push(run.taskId);
    else if (r.code !== "conflict") out.failed.push({ taskId: run.taskId, error: `取回合并槽：${String(r.error ?? "manager failed")}` });
    // conflict: someone moved the run or took the slot first; the CAS let one side win, this pass just waits
  }
  return out;
}
