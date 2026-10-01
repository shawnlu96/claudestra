/** File leases protect the card through review/merge; worker slots protect only active local writing. */
import type { Database } from "bun:sqlite";
import { getTask } from "./ledger-store.js";
import { localWriteOwner, writeSlotFacts } from "./scheduler-slot-hold-facts.js";

/** Called inside planIntent's transaction: reclaim pre-upgrade review/merge/peer slots before acquiring a vacancy. */
export function releaseIdleWriteSlots(db: Database, project: string): void {
  for (const row of writeSlotFacts(db, project).stale) {
    db.query("DELETE FROM scheduler_resources WHERE project = ? AND taskId = ? AND resource = ?").run(project, row.taskId, row.resource);
  }
}

export function releaseFinishedCardLeases(db: Database, taskId: string): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_resources'").get()) return;
  const task = getTask(db, taskId);
  if (task && !localWriteOwner(db, task)) db.query("DELETE FROM scheduler_resources WHERE taskId = ? AND resource LIKE 'slot:%'").run(taskId);
  if (!task || !["live", "verified", "done", "cancelled"].includes(task.stage)) return;
  const active = db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(taskId);
  if (active) return;
  db.query("DELETE FROM scheduler_resources WHERE taskId = ? AND scope = 'card'").run(taskId);
}
