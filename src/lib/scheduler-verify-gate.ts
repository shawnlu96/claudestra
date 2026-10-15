/**
 * The scheduler may run the normal completion checklist only for a card it deployed itself (T68g): auto workflow on the current
 * spec, a `deployed` deploy journal whose merge reviewed the card's current head. It never waives a probe. A replay of its own
 * recorded verify (same dedup key) is allowed after the card already moved to verified. Tests: tests/scheduler-deploy.test.ts.
 * PMHAND1 12: also a deploy run a PM / master / owner resolved as `done` (resolveDeployRun turns the card manual, so any mode),
 * the merge reviewed the current head and the run's intent is on the current spec; the same checklist, no waiver. This file only
 * says which runs qualify: it sits under ledger-write.ts, which may not reach the recovery policy (no-cycle), so verifyAfterResolve
 * is read by the one scheduler caller right before it calls `ledger verify` (pm-handback-verify.ts; off / observe never call).
 * Tests: tests/scheduler-verify-gate.test.ts.
 */
import type { Database } from "bun:sqlite";

/** `d` resolved by a human as done (resolveDeployRun refuses the scheduler) and its intent planned on the card's current spec. */
export const RESOLVED_DONE_SQL = `d.phase='resolved' AND EXISTS (SELECT 1 FROM events AS r WHERE r.target=d.taskId AND r.kind='scheduler'
      AND r.actor<>'scheduler' AND json_extract(r.data,'$.op')='deploy_resolve' AND json_extract(r.data,'$.intentId')=d.intentId
      AND json_extract(r.data,'$.outcome')='done')
    AND EXISTS (SELECT 1 FROM scheduler_intents AS i WHERE i.id=d.intentId AND i.specRev=t.specRev)`;

const canVerify = (deploy: string, mode: string) => `SELECT 1 FROM tasks AS t
    JOIN task_workflows AS w ON w.taskId=t.id ${mode} AND w.specRev=t.specRev
    JOIN scheduler_deploys AS d ON d.taskId=t.id AND d.project=t.project AND ${deploy}
    JOIN scheduler_merges AS m ON m.intentId=d.intentId AND m.reviewedHead=t.headSHA
    WHERE t.id=? AND (t.stage='live' OR (t.stage='verified' AND ? = 'deploy-verify:' || d.intentId
      AND EXISTS (SELECT 1 FROM events AS e WHERE e.project=t.project AND e.target=t.id
        AND e.dedupKey=? AND e.kind='verify' AND e.actor='scheduler'))) LIMIT 1`;

export function schedulerCanVerify(db: Database, taskId: string, dedupKey?: string): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()) return false;
  const args = [taskId, dedupKey ?? "", dedupKey ?? ""];
  return !!db.query(canVerify("d.phase='deployed'", "AND w.mode='auto'")).get(...args) || !!db.query(canVerify(RESOLVED_DONE_SQL, "")).get(...args);
}

/** The repo the scheduler verifies against: the deployed tree from scheduler.json, not wherever the CLI happens to run. */
export function schedulerVerifyRepo(project: string, read: () => { projects: Record<string, { repoDir: string; deploy?: unknown }> }): string | null {
  const p = read().projects[project];
  return p?.deploy ? p.repoDir : null;
}
