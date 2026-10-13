/** Deployment evidence is a ledger assertion, never the checkout's current HEAD or a build/version endpoint. */
import type { Database } from "bun:sqlite";
import { getTask, LedgerError, toEvent } from "./ledger-store.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import type { MergeRun } from "./scheduler-merge.js";
import { getIntent } from "./ledger-scheduler.js";
import { deployDrift } from "./scheduler-deploy.js";
import { runBounded } from "./run-bounded.js";

export const DEPLOY_RECONCILE_MAX_AGE_MS = 24 * 60 * 60_000;
export const DEPLOY_RECONCILE_MARK = "deployReconcile";
const SHA = /^[a-f0-9]{40}$/i;
const hasTable = (db: Database, table: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

/** An unsettled merge intent whose deploy may still start (deployDrift null) belongs to the auto deploy and its verify. */
function autoDeployPending(db: Database, intentId: string): boolean {
  const status = getIntent(db, intentId)?.status;
  return (status === "pending" || status === "submitted" || status === "unknown") && deployDrift(db, intentId) === null;
}

export function reconcileTaskIds(db: Database, project: string): string[] {
  if (!hasTable(db, "scheduler_merges")) return [];
  // Finished cards, in-flight attempts and merges still awaiting their auto deploy are normal scheduler work.
  return (db.query(`SELECT m.taskId, m.intentId FROM scheduler_merges m JOIN tasks t ON t.id=m.taskId AND t.project=m.project
    WHERE m.project=? AND t.stage='merge' AND m.phase='merged' AND m.intentId=(
      SELECT latest.intentId FROM scheduler_merges latest JOIN scheduler_intents i ON i.id=latest.intentId
      WHERE latest.taskId=m.taskId AND latest.project=m.project
      ORDER BY i.eventSeq DESC, latest.createdAt DESC, latest.intentId DESC LIMIT 1)
    ORDER BY m.taskId`).all(project) as { taskId: string; intentId: string }[])
    .filter((r) => !autoDeployPending(db, r.intentId)).map((r) => r.taskId);
}

export interface ReconcileFacts { task: LedgerTask; merge: MergeRun; source: LedgerEvent }
export type ReconcileRead = { facts: ReconcileFacts } | { reason: string };

/** Do not fall back past an unreadable latest deployment: an older success cannot describe production now. */
function deploymentSource(db: Database, project: string, now: number): { source: LedgerEvent } | { reason: string } {
  const row = db.query(`SELECT * FROM events WHERE project=? AND kind='deploy'
    AND json_type(data,'$.reconciledBy') IS NULL ORDER BY seq DESC LIMIT 1`).get(project);
  if (!row) return { reason: "deployment-missing" };
  const source = toEvent(row as Record<string, unknown>);
  if (source.data.imported || source.data.approxTime || typeof source.data.version !== "string"
    || !/^[a-f0-9]{7,40}$/i.test(source.data.version)) return { reason: "deployment-unreadable" };
  if (source.ts > now || now - source.ts > DEPLOY_RECONCILE_MAX_AGE_MS) return { reason: "deployment-expired" };
  if (db.query("SELECT 1 FROM events WHERE project=? AND kind='rollback' AND seq>? LIMIT 1").get(project, source.seq)) {
    return { reason: "rollback-after-deployment" };
  }
  if (hasTable(db, "scheduler_deploys") && db.query(`SELECT 1 FROM scheduler_deploys WHERE project=?
    AND (phase IN ('claimed','running') OR (phase='unknown' AND updatedAt>=?)) LIMIT 1`).get(project, source.ts)) {
    return { reason: "deployment-unsettled" };
  }
  return { source };
}

/** Latest attempt wins, including a newer non-merged attempt. A deployment must follow this merge's structured event. */
export function readReconcileFacts(db: Database, taskId: string, now: number): ReconcileRead {
  const task = getTask(db, taskId);
  if (!task) return { reason: "task-missing" };
  if (task.stage !== "merge") return { reason: "stage-not-merge" };
  if (!hasTable(db, "scheduler_merges")) return { reason: "merge-missing" };
  const merge = db.query(`SELECT m.* FROM scheduler_merges m JOIN scheduler_intents i ON i.id=m.intentId
    WHERE m.taskId=? AND m.project=? ORDER BY i.eventSeq DESC, m.createdAt DESC, m.intentId DESC LIMIT 1`).get(taskId, task.project) as MergeRun | null;
  if (!merge) return { reason: "merge-missing" };
  if (merge.phase !== "merged") return { reason: "merge-not-merged" };
  if (!merge.mergeSha || !SHA.test(merge.mergeSha)) return { reason: "merge-sha-missing" };
  if (merge.reviewedHead !== task.headSHA) return { reason: "merge-head-changed" };
  if (autoDeployPending(db, merge.intentId)) return { reason: "auto-deploy-pending" };
  const event = db.query(`SELECT seq FROM events WHERE project=? AND target=? AND kind='scheduler' AND actor='scheduler'
    AND json_extract(data,'$.op')='merge_phase' AND json_extract(data,'$.intentId')=?
    AND json_extract(data,'$.to')='merged' AND json_extract(data,'$.mergeSha')=? ORDER BY seq DESC LIMIT 1`)
    .get(task.project, taskId, merge.intentId, merge.mergeSha) as { seq: number } | null;
  if (!event) return { reason: "merge-evidence-missing" };
  if (db.query("SELECT 1 FROM events WHERE project=? AND target=? AND kind='deploy' AND seq>? LIMIT 1")
    .get(task.project, taskId, event.seq)) return { reason: "already-deployed" };
  if (db.query(`SELECT 1 FROM events WHERE project=? AND target=? AND kind='stage' AND seq>?
    AND json_extract(data,'$.to')='merge' LIMIT 1`).get(task.project, taskId, event.seq)) return { reason: "merge-stay-changed" };
  const deployed = deploymentSource(db, task.project, now);
  if ("reason" in deployed) return deployed;
  if (deployed.source.seq <= event.seq) return { reason: "deployment-before-merge" };
  return { facts: { task, merge, source: deployed.source } };
}

/** Resolve only an immutable hexadecimal commit name; short versions must be unambiguous locally. Never fetch or deploy. */
export async function reconcileGitProof(repoDir: string, mergeSha: string, rawVersion: string, active: () => void,
  command: typeof runBounded = runBounded): Promise<{ version: string } | { reason: string }> {
  const run = async (args: string[]) => {
    active();
    try { return await command(["git", "-C", repoDir, ...args], { timeoutMs: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }); }
    finally { active(); }
  };
  if (!SHA.test(mergeSha) || !/^[a-f0-9]{7,40}$/i.test(rawVersion)) throw new LedgerError("invalid", "部署证明只接受提交号");
  const resolved = await run(["rev-parse", "--verify", `${rawVersion}^{commit}`]);
  const version = resolved.stdout.trim();
  if (resolved.code !== 0 || resolved.timedOut || !SHA.test(version)) return { reason: "deployment-commit-unreadable" };
  const ancestor = await run(["merge-base", "--is-ancestor", mergeSha, version]);
  if (ancestor.timedOut || (ancestor.code !== 0 && ancestor.code !== 1)) return { reason: "git-proof-unreadable" };
  return ancestor.code === 0 ? { version } : { reason: "merge-not-ancestor" };
}
