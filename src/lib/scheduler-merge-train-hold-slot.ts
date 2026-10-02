/**
 * The merge-slot side of a live train's right of way (i28-MT1f2, scheduler-merge-train-hold.ts says why it lives here).
 * - mergeSlotHold: the auto tick asks right before it plans a merge intent; a card the train will not merge waits with a
 *   readable reason (no intent, no slot, no update-branch, no merge; not unknown, not a bounce) until the train is done or void.
 * - mergeSlotTurn: the merge pass asks before driving a run; a card outside a live train that holds the slot but has sent no merge
 *   (ready / await_ci) lends it to the train and waits, and takes it back once the train is over (i28-MT1f2f2: never void the train).
 * - trainProjects: the pass asks before the train tick; a project whose slot sits with a card already merging (past await_ci, or
 *   an unknown intent) forms no new train until that card settles, and neither does one whose card lent its slot to the last
 *   train and has not merged yet (it would lend it again and again).
 * A train past HOLD_LIMIT_MS holds no one. In a test process there is no default store (as scheduler-merge-train-tick.ts).
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { isTestProcess } from "./test-guard.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";
import type { TrainState, TrainStore } from "./scheduler-merge-train.js";
import { fileTrainStore } from "./scheduler-merge-train-tick.js";
import { holdReason, ridesTrain, SLOT_RECLAIM, SLOT_YIELD, trainHolds } from "./scheduler-merge-train-hold.js";

const defaultStore = (): TrainStore | null => (isTestProcess() ? null : fileTrainStore());
/** A corrupt state file holds no one here: the train tick reports it, and the driver gate still guards every merge. */
const loadTrain = (store: TrainStore | null, project: string): TrainState | null => {
  try { return store?.load(project) ?? null; } catch { return null; }
};
/** Cards already told why they wait, so a wait that lasts many passes is one train event, not one per pass (a restart may repeat it once). */
const told = new Set<string>();

/** One train event per card and phase, not one per pass. */
function tell(store: TrainStore, s: TrainState, taskId: string, why: string, now: number): void {
  const key = `${s.project} ${s.id} ${s.phase} ${taskId}`;
  if (told.has(key)) return;
  if (told.size >= 500) told.clear();
  told.add(key);
  try {
    store.event(s.project, { at: now, train: s.id, seq: s.seq, kind: "hold", text: why, data: { taskId, phase: s.phase } });
  } catch (e) { console.error(`⚠️ [merge-train] 让路记录没写进状态文件：${(e as Error).message}`); }
}

/** Why this card may not plan its merge now (the auto tick shows it as the card's step), or null. */
export function mergeSlotHold(task: Pick<LedgerTask, "id" | "project" | "headSHA">, store: TrainStore | null = defaultStore(),
  now: number = Date.now()): string | null {
  const s = loadTrain(store, task.project);
  if (!s || !trainHolds(s, now) || ridesTrain(s, task.id, task.headSHA)) return null;
  const why = holdReason(s, task.id);
  tell(store!, s, task.id, why, now);
  return why;
}

type Advance = (from: MergePhase, to: MergePhase, rev: number, receipt?: string) => Promise<MergeRun>;
const slotHolder = (db: Database, project: string) => db.query("SELECT intentId, taskId FROM scheduler_resources WHERE project = ? AND resource = ?")
  .get(project, `merge:${project}`) as { intentId: string; taskId: string } | null;

/**
 * The merge pass's turn on a run before it is driven (scheduler-service.ts mergeTick): an outsider of a live train that has sent no
 * merge yet gives the project slot up and waits (its step is journaled with the reason); a run without the slot takes it back once
 * it is free and no train holds it, else waits; any other run is driven as before. Test processes have no default store.
 */
export async function mergeSlotTurn(db: Database, run: MergeRun, advance: Advance, drive: (run: MergeRun) => Promise<MergeRun>,
  store: TrainStore | null = defaultStore(), now: number = Date.now()): Promise<MergeRun> {
  if (!store) return drive(run);
  const s = loadTrain(store, run.project), holder = slotHolder(db, run.project), mine = holder?.intentId === run.intentId;
  if (s && trainHolds(s, now) && !ridesTrain(s, run.taskId, run.reviewedHead) && (run.phase === "ready" || run.phase === "await_ci")) {
    const why = holdReason(s, run.taskId);
    tell(store, s, run.taskId, why, now);
    return mine ? advance(run.phase, run.phase, run.rev, `${SLOT_YIELD}${why}`) : run;
  }
  if (mine) return drive(run);
  if (holder) return run; // lent to a train member or taken by the next card: wait for it like any merge
  return drive(await advance(run.phase, run.phase, run.rev, SLOT_RECLAIM));
}

/** `merge:<project>` is held by a card already merging (false = free, or held by a card that can still ride or lend it), or a card
 * that lent its slot to an earlier train is still to merge (a new train would hold it again). */
function slotOutsider(db: Database, project: string): boolean {
  const row = db.query(`SELECT i.status, m.phase FROM scheduler_resources r JOIN scheduler_intents i ON i.id = r.intentId
    LEFT JOIN scheduler_merges m ON m.intentId = i.id WHERE r.project = ? AND r.resource = ?`).get(project, `merge:${project}`) as
    { status: string; phase: string | null } | null;
  if (row && (row.status === "unknown" || (!!row.phase && !["ready", "updating", "await_ci"].includes(row.phase)))) return true;
  return !!db.query(`SELECT 1 FROM scheduler_merges m JOIN scheduler_intents i ON i.id = m.intentId WHERE m.project = ? AND i.status = 'submitted'
    AND m.phase IN ('ready','updating','await_ci') AND EXISTS (SELECT 1 FROM events e WHERE e.target = m.taskId AND e.kind = 'scheduler'
    AND json_extract(e.data, '$.op') = 'merge_slot' AND json_extract(e.data, '$.intentId') = m.intentId)`).get(project);
}

/** The projects the train tick may look at this pass: any with a live train (to step it), else those with no outsider on the slot. */
export function trainProjects(db: Database, projects: readonly string[], store: TrainStore | null = defaultStore()): string[] {
  if (!store) return [...projects];
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return [...projects];
  return projects.filter((p) => {
    let s: TrainState | null;
    try { s = store.load(p); } catch { return true; } // the train tick reports a corrupt file
    return (!!s && s.phase !== "done") || !slotOutsider(db, p);
  });
}
