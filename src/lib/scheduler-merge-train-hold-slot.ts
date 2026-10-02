/**
 * The merge-slot side of a live train's right of way (i28-MT1f2, scheduler-merge-train-hold.ts says why it lives here).
 * - mergeSlotHold: the auto tick asks right before it plans a merge intent; a card the train will not merge waits with a
 *   readable reason (no intent, no slot, no update-branch, no merge; not unknown, not a bounce) until the train is done or void.
 * - trainProjects: the pass asks before the train tick; a project whose slot sits with a card that can no longer ride (its run
 *   past ready / updating, or an unknown intent) forms no new train until that card lets go — the members could never get the slot.
 * A train past HOLD_LIMIT_MS holds no one. In a test process there is no default store (as scheduler-merge-train-tick.ts).
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { isTestProcess } from "./test-guard.js";
import type { TrainState, TrainStore } from "./scheduler-merge-train.js";
import { fileTrainStore } from "./scheduler-merge-train-tick.js";
import { holdReason, ridesTrain, trainHolds } from "./scheduler-merge-train-hold.js";

const defaultStore = (): TrainStore | null => (isTestProcess() ? null : fileTrainStore());
/** A corrupt state file holds no one here: the train tick reports it, and the driver gate still guards every merge. */
const loadTrain = (store: TrainStore | null, project: string): TrainState | null => {
  try { return store?.load(project) ?? null; } catch { return null; }
};
/** Cards already told why they wait, so a wait that lasts many passes is one train event, not one per pass (a restart may repeat it once). */
const told = new Set<string>();

/** Why this card may not plan its merge now (the auto tick shows it as the card's step), or null. */
export function mergeSlotHold(task: Pick<LedgerTask, "id" | "project" | "headSHA">, store: TrainStore | null = defaultStore(),
  now: number = Date.now()): string | null {
  const s = loadTrain(store, task.project);
  if (!s || !trainHolds(s, now) || ridesTrain(s, task.id, task.headSHA)) return null;
  const why = holdReason(s, task.id), key = `${s.project} ${s.id} ${s.phase} ${task.id}`;
  if (!told.has(key)) {
    if (told.size >= 500) told.clear();
    told.add(key);
    try {
      store!.event(s.project, { at: now, train: s.id, seq: s.seq, kind: "hold", text: why, data: { taskId: task.id, phase: s.phase } });
    } catch (e) { console.error(`⚠️ [merge-train] 让路记录没写进状态文件：${(e as Error).message}`); }
  }
  return why;
}

/** `merge:<project>` is held by a card that can no longer ride a train (false = free, or held by a train candidate). */
function slotOutsider(db: Database, project: string): boolean {
  const row = db.query(`SELECT i.status, m.phase FROM scheduler_resources r JOIN scheduler_intents i ON i.id = r.intentId
    LEFT JOIN scheduler_merges m ON m.intentId = i.id WHERE r.project = ? AND r.resource = ?`).get(project, `merge:${project}`) as
    { status: string; phase: string | null } | null;
  return !!row && (row.status === "unknown" || (!!row.phase && row.phase !== "ready" && row.phase !== "updating"));
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
