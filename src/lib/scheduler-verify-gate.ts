/** A scheduler may run the normal verification checklist only for its already deployed merge journal. */
import type { Database } from "bun:sqlite";

export function schedulerCanVerify(db: Database, taskId: string, dedupKey?: string): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return false;
  return !!db.query(`SELECT 1 FROM tasks AS t
    JOIN task_workflows AS w ON w.taskId=t.id AND w.mode='auto' AND w.specRev=t.specRev
    JOIN scheduler_merges AS m ON m.taskId=t.id AND m.project=t.project AND m.phase='verifying'
    JOIN scheduler_intents AS i ON i.id=m.intentId AND i.status='submitted' AND i.action='merge'
    WHERE t.id=? AND t.headSHA=m.reviewedHead
      AND m.mergeSha IS NOT NULL AND m.deployReceipt IS NOT NULL
      AND (t.stage='live' OR (t.stage='verified' AND ? = 'scheduler:' || m.intentId || ':verify'
        AND EXISTS (SELECT 1 FROM events AS e WHERE e.project=t.project AND e.target=t.id
          AND e.dedupKey=? AND e.kind='verify' AND e.actor='scheduler'
          AND json_extract(e.data,'$.result')='pass'))) LIMIT 1`).get(taskId, dedupKey ?? "", dedupKey ?? "");
}
