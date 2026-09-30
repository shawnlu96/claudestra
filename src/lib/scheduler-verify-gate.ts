/**
 * The scheduler may run the normal completion checklist only for a card it deployed itself (T68g): auto workflow on the current
 * spec, a `deployed` deploy journal whose merge reviewed the card's current head. It never waives a probe. A replay of its own
 * recorded verify (same dedup key) is allowed after the card already moved to verified. Tests: tests/scheduler-deploy.test.ts.
 */
import type { Database } from "bun:sqlite";

export function schedulerCanVerify(db: Database, taskId: string, dedupKey?: string): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()) return false;
  return !!db.query(`SELECT 1 FROM tasks AS t
    JOIN task_workflows AS w ON w.taskId=t.id AND w.mode='auto' AND w.specRev=t.specRev
    JOIN scheduler_deploys AS d ON d.taskId=t.id AND d.project=t.project AND d.phase='deployed'
    JOIN scheduler_merges AS m ON m.intentId=d.intentId AND m.reviewedHead=t.headSHA
    WHERE t.id=? AND (t.stage='live' OR (t.stage='verified' AND ? = 'scheduler:' || d.intentId || ':verify'
      AND EXISTS (SELECT 1 FROM events AS e WHERE e.project=t.project AND e.target=t.id
        AND e.dedupKey=? AND e.kind='verify' AND e.actor='scheduler'))) LIMIT 1`).get(taskId, dedupKey ?? "", dedupKey ?? "");
}

/** The repo the scheduler verifies against: the deployed tree from scheduler.json, not wherever the CLI happens to run. */
export function schedulerVerifyRepo(project: string, read: () => { projects: Record<string, { repoDir: string; deploy?: unknown }> }): string | null {
  const p = read().projects[project];
  return p?.deploy ? p.repoDir : null;
}
