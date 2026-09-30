/** Card-scoped claims outlive dispatch receipts and are released only after the card and effects are settled. */
import type { Database } from "bun:sqlite";

export function releaseFinishedCardLeases(db: Database, taskId: string): void {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduler_resources'").get()) return;
  const task = db.query("SELECT stage FROM tasks WHERE id = ?").get(taskId) as { stage: string } | null;
  if (!task || !["live", "verified", "done", "cancelled"].includes(task.stage)) return;
  const active = db.query("SELECT 1 FROM scheduler_intents WHERE taskId = ? AND status IN ('pending','submitted','unknown') LIMIT 1").get(taskId);
  if (active) return;
  db.query("DELETE FROM scheduler_resources WHERE taskId = ? AND scope = 'card'").run(taskId);
}
