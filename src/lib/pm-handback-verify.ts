/**
 * PMHAND1 · the deploy tick's PM hand-back cards, per project (scheduler-deploy-tick.ts deployCards):
 * - the 11a / 11b sample notes found since the last tick (pm-handback-sample.ts);
 * - 12 verifyAfterResolve: a deploy run a PM / master / owner resolved as `done` whose card is live on the reviewed head and the
 *   run's spec (RESOLVED_DONE_SQL). on: the same checklist as driveVerify, dry-run first and only a pass is recorded (never a
 *   failure, nothing waived; the gate is schedulerCanVerify); observe: one note "would verify"; off: no card at all.
 * The verify dedup key is driveVerify's (`deploy-verify:<intent>`), so a PM's own `ledger verify` (card no longer live) ends it.
 * Doc: docs/architecture/pm-handback.md. Tests: tests/pm-handback-verify.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { DeployRun } from "./scheduler-deploy.js";
import type { DeployTickDeps } from "./scheduler-deploy-tick.js";
import { RESOLVED_DONE_SQL } from "./scheduler-verify-gate.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip-card.js";
import type { TickPace } from "./scheduler-yield.js";
import { handbackSamplesDue, recordHandbackSample } from "./pm-handback-sample.js";

export const VERIFY_AFTER_RESOLVE = "verifyAfterResolve" as const;

/** The effective verifyAfterResolve mode, read right before each use; a read that throws is off. */
export function verifyAfterResolveMode(project: string, policy: RecoveryPolicyPort = recoveryPolicy): RecoveryMode {
  try {
    const m = policy(project, VERIFY_AFTER_RESOLVE).mode;
    return m === "on" || m === "observe" ? m : "off";
  } catch (e) {
    console.error(`⚠️ [pm-handback] ${project} 读恢复策略失败，按 off：${(e as Error).message}`);
    return "off";
  }
}

/** A resolved run is retried less often than a fresh deploy: its card may stay failing and only a pass is ever recorded. */
const RESOLVED_VERIFY_EVERY_MS = 10 * 60_000;
const lastTry = new Map<string, number>();
const dedupOf = (run: DeployRun) => `deploy-verify:${run.intentId}`;

/** Live cards whose deploy a human resolved as done, on the merge's reviewed head and the run's spec. */
function resolvedVerifyRuns(db: Database, project: string): DeployRun[] {
  return db.query(`SELECT d.* FROM scheduler_deploys AS d JOIN tasks AS t ON t.id = d.taskId
    JOIN task_workflows AS w ON w.taskId = t.id AND w.specRev = t.specRev
    JOIN scheduler_merges AS m ON m.intentId = d.intentId AND m.reviewedHead = t.headSHA
    WHERE d.project = ? AND t.stage = 'live' AND ${RESOLVED_DONE_SQL} ORDER BY d.updatedAt, d.intentId`).all(project) as DeployRun[];
}

function due(d: DeployTickDeps, db: Database, run: DeployRun): boolean {
  if (getTask(db, run.taskId)?.stage !== "live" || getEventByDedup(db, dedupOf(run))) return false;
  const at = lastTry.get(run.intentId);
  return at === undefined || d.now() - at >= RESOLVED_VERIFY_EVERY_MS;
}

/** on: dry-run, and only on a pass the recorded verify (schedulerCanVerify re-checks the gate inside `ledger verify`). */
async function driveResolvedVerify(d: DeployTickDeps, db: Database, run: DeployRun, policy: RecoveryPolicyPort = recoveryPolicy): Promise<void> {
  if (!due(d, db, run)) return;
  lastTry.set(run.intentId, d.now());
  const head = getTask(db, run.taskId)?.headSHA ?? null;
  const mode = verifyAfterResolveMode(run.project, policy);
  if (mode === "observe") {
    recordObserved(db, { project: run.project, mechanism: VERIFY_AFTER_RESOLVE, target: run.taskId, actionKey: `verify:${run.intentId}`,
      action: `对人工结清为 done 的部署 ${run.intentId} 跑完成检查（先 dry-run，只记通过）`, data: { intentId: run.intentId, head } }, d.now());
    return;
  }
  if (mode !== "on") return;
  const dry = await d.manager("ledger", "verify", run.taskId, "--dry-run");
  if (dry.ok !== true || dry.result !== "pass") return;
  const r = await d.manager("ledger", "verify", run.taskId, "--dedup", dedupOf(run));
  if (r.code === "invalid" || r.code === "forbidden") throw new Error(`ledger verify ${run.taskId}: ${String(r.error)}`);
  lastTry.delete(run.intentId);
  if (r.ok === true) {
    recordHandbackSample(db, { project: run.project, taskId: run.taskId, head, type: "resolve_verify",
      text: `部署 ${run.intentId} 被人工结清为 done 后，调度器跑完成检查并记通过`, data: { intentId: run.intentId } }, d.now());
  }
}

interface Card { key: string; start(): (() => Promise<boolean>) | null }

/** The project's PM hand-back cards; `prefix` sorts them ahead of the project's merge / deploy cards. */
export function* handbackCards(db: Database, project: string, policy: SchedulerConfig["projects"][string], prefix: string,
  d: DeployTickDeps, pace?: TickPace): Generator<Card> {
  const skip = (taskId: string) => !!pace?.skipTask?.(taskId) || schedulerV2SkipTask(db, taskId);
  yield { key: `${prefix}/!/0`, start: () => {
    const samples = handbackSamplesDue(db, project).filter((s) => !skip(s.taskId));
    if (!samples.length) return null;
    return async () => { for (const s of samples) recordHandbackSample(db, s, d.now()); return false; };
  } };
  if (!policy.deploy || verifyAfterResolveMode(project) === "off") return; // the scheduler verifies only against a deployed tree
  for (const run of resolvedVerifyRuns(db, project)) {
    yield { key: `${prefix}/!/1/${String(run.updatedAt).padStart(15, "0")}/${run.intentId}`, start: () =>
      skip(run.taskId) || !due(d, db, run) ? null : async () => { await driveResolvedVerify(d, db, run); return true; } };
  }
}
