/**
 * Durable deploy journal (T68g): after the merge journal reaches `merged`, the scheduler deploys through a one-shot launchd job.
 * A phase claim is committed before each external effect. `deployed` / `unknown` need a checked "the job is gone" (liveness=dead,
 * also a table CHECK), so an unknown deploy never overlaps a live one and does not hold off updates; its exit is the PM's
 * `scheduler-merge-resolve`. The merge intent stays submitted (holding the project merge slot) until the deploy ends.
 * Tests: tests/scheduler-deploy.test.ts.
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { getMeta, LedgerError } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { canTransition, nextTaskState } from "./ledger-stages.js";
import { settleIntent } from "./ledger-scheduler-settle.js";
import { getMergeRun, type MergeResolution } from "./scheduler-merge.js";
import { DEPLOY_IN_FLIGHT, type DeployPhase } from "./ledger-deploy-schema.js";

export interface DeployRun {
  intentId: string; taskId: string; project: string; prRef: string; mergeSha: string;
  phase: DeployPhase; rev: number; label: string | null;
  outcome: "success" | "failed" | "unknown" | null; liveness: "dead" | null;
  receipt: string | null; reason: string | null; deployedAt: number | null; createdAt: number; updatedAt: number;
}

export const DEPLOY_LABEL_PREFIX = "com.claudestra.scheduler.deploy.";
const text = (v: string | undefined, label: string): string => {
  const s = v?.trim() ?? "";
  if (!s || s.length > 600 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s)) throw new LedgerError("invalid", `${label} 要是单行且不超过 600 字`);
  return s;
};
const hasTable = (db: Database) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get();

export function getDeployRun(db: Database, intentId: string): DeployRun | null {
  return hasTable(db) ? db.query("SELECT * FROM scheduler_deploys WHERE intentId = ?").get(intentId) as DeployRun | null : null;
}

/** Runs whose job may still be alive, oldest first: updates wait, and no second deploy starts anywhere. */
export function inFlightDeploys(db: Database): DeployRun[] {
  if (!hasTable(db)) return [];
  return db.query(`SELECT * FROM scheduler_deploys WHERE phase IN (${DEPLOY_IN_FLIGHT.map(() => "?").join(",")}) ORDER BY createdAt, intentId`)
    .all(...DEPLOY_IN_FLIGHT) as DeployRun[];
}

export const deployInFlight = (db: Database): boolean => inFlightDeploys(db).length > 0;

/** Why this merged run must not start deploying now; null = it may. Rechecked right before the job is submitted. */
export function deployDrift(db: Database, intentId: string): string | null {
  const run = getMergeRun(db, intentId), intent = getIntent(db, intentId);
  if (!run || run.phase !== "merged" || !run.mergeSha) return "合并运行不在 merged 或缺合并提交";
  const task = mustTask(db, run.taskId), workflow = getWorkflow(db, run.taskId);
  if (intent?.status !== "submitted" || !workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev) return "流程被暂停、规格已变或合并意图不再有效";
  if (task.stage !== "merge" || task.headSHA !== run.reviewedHead) return `任务阶段（${task.stage}）或 head 已变`;
  if (getMeta(db, run.project).queueFrozen.frozen) return "项目合并队列已冻结";
  return null;
}

/** Claim before submit. Only the scheduler starts a deploy; a manager deploys by hand and moves the stage itself. */
export function beginDeployRun(db: Database, ctx: WriteCtx, intentId: string): { run: DeployRun; duplicate: boolean } {
  return tx(db, () => {
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "自动部署只由调度服务发起；人工部署照旧 ledger deploy");
    const old = getDeployRun(db, intentId);
    if (old) return { run: old, duplicate: true };
    const drift = deployDrift(db, intentId);
    if (drift) throw new LedgerError("conflict", `不能开始部署：${drift}`);
    if (deployInFlight(db)) throw new LedgerError("busy", "已有部署在途");
    const run = getMergeRun(db, intentId)!, now = ctx.now ?? Date.now();
    db.prepare(`INSERT INTO scheduler_deploys (intentId, taskId, project, prRef, mergeSha, phase, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?)`).run(intentId, run.taskId, run.project, run.prRef, run.mergeSha, now, now);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${intentId}:deploy:claimed` }, {
      project: run.project, target: run.taskId, kind: "scheduler", text: `自动部署：已占位，部署 ${run.mergeSha!.slice(0, 12)}`,
      data: { op: "deploy_phase", intentId, phase: "claimed", mergeSha: run.mergeSha },
    }, true);
    return { run: getDeployRun(db, intentId) as DeployRun, duplicate: false };
  });
}

const NEXT: Record<DeployPhase, readonly DeployPhase[]> = { claimed: ["running", "unknown"], running: ["deployed", "unknown"], deployed: [], unknown: [], resolved: [] };

export interface DeployStep {
  intentId: string; from: DeployPhase; to: DeployPhase; rev: number; receipt?: string; label?: string;
  outcome?: "success" | "failed" | "unknown"; liveness?: "dead";
}

/** Moves the card to live on a verified deploy (the planner then asks for `verify`) and frees the merge slot. */
function markDeployed(db: Database, ctx: WriteCtx, row: DeployRun, receipt: string, now: number): void {
  const task = mustTask(db, row.taskId), merge = getMergeRun(db, row.intentId);
  const movable = task.stage === "merge" && task.headSHA === merge?.reviewedHead && canTransition(task, "live", "pm").ok;
  if (movable) {
    const next = nextTaskState(task, "live");
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
    insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage", text: "自动部署完成，进入 live",
      data: { from: "merge", to: "live", round: next.round, specRev: next.specRev } }, false);
  }
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:deploy:event` }, { project: task.project, target: task.id, kind: "deploy",
    text: movable ? "自动部署完成" : `自动部署完成，任务已在 ${task.stage}，阶段不动`, data: { version: row.mergeSha, rollbackPoint: null, auto: true, receipt } }, false);
  const intent = getIntent(db, row.intentId);
  if (intent?.status === "submitted") settleIntent(db, { ...ctx, now }, { id: row.intentId, from: "submitted", to: "done", receipt: `merge+deploy ${row.mergeSha}` });
}

export function advanceDeployRun(db: Database, ctx: WriteCtx, input: DeployStep): DeployRun {
  return tx(db, () => {
    if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "部署步骤只由调度服务推进；结果不明的由 PM 用 scheduler-merge-resolve 结清");
    const row = getDeployRun(db, input.intentId);
    if (!row) throw new LedgerError("not_found", "没有部署运行记录");
    if (row.phase !== input.from || row.rev !== input.rev || !NEXT[input.from]?.includes(input.to)) {
      throw new LedgerError("conflict", `部署步骤当前 ${row.phase}@${row.rev}，不能从 ${input.from}@${input.rev} 推 ${input.to}`);
    }
    const receipt = input.receipt ? text(input.receipt, "回执") : null;
    if (input.to === "running" && !(input.label?.startsWith(DEPLOY_LABEL_PREFIX) && input.label.length <= 120)) throw new LedgerError("invalid", "running 要带部署任务的 launchd 标签");
    if (input.to === "deployed" || input.to === "unknown") {
      if (input.liveness !== "dead") throw new LedgerError("invalid", `${input.to} 要先确认部署进程已不在（--liveness dead）`);
      if (!receipt) throw new LedgerError("invalid", `${input.to} 需要可核对回执或原因`);
    }
    if (input.to === "deployed" && input.outcome !== "success") throw new LedgerError("invalid", "deployed 的结论只能是 success");
    if (input.to === "unknown" && input.outcome !== "failed" && input.outcome !== "unknown") throw new LedgerError("invalid", "unknown 的结论是 failed 或 unknown");
    const now = ctx.now ?? Date.now();
    db.prepare(`UPDATE scheduler_deploys SET phase=?, rev=rev+1, label=COALESCE(?,label), outcome=COALESCE(?,outcome), liveness=COALESCE(?,liveness),
      receipt=COALESCE(?,receipt), reason=?, deployedAt=?, updatedAt=? WHERE intentId=?`)
      .run(input.to, input.to === "running" ? input.label! : null, input.outcome ?? null, input.liveness ?? null,
        input.to === "deployed" ? receipt : null, input.to === "unknown" ? receipt : row.reason, input.to === "deployed" ? now : row.deployedAt, now, row.intentId);
    if (input.to === "deployed") markDeployed(db, ctx, row, receipt!, now);
    if (input.to === "unknown") db.prepare("INSERT INTO meta (project,key,value) VALUES (?, 'queueFrozen', ?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value")
      .run(row.project, JSON.stringify({ frozen: true, reason: `部署结果不明：${receipt}`, since: now }));
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:deploy:${input.to}` }, {
      project: row.project, target: row.taskId, kind: "scheduler", text: `自动部署：${input.to}${receipt ? `（${receipt}）` : ""}`,
      data: { op: "deploy_phase", intentId: row.intentId, from: row.phase, to: input.to, receipt, label: input.label ?? row.label,
        outcome: input.outcome ?? null, liveness: input.liveness ?? null },
    }, true);
    return getDeployRun(db, row.intentId) as DeployRun;
  });
}

/** Same exit and same rules as an unknown merge: a human manager who checked the machine closes it; the card turns manual. */
export function resolveDeployRun(db: Database, ctx: WriteCtx, input: { intentId: string; outcome: MergeResolution; receipt: string | undefined }): DeployRun {
  return tx(db, () => {
    const row = getDeployRun(db, input.intentId);
    if (!row) throw new LedgerError("not_found", "没有部署运行记录");
    if (ctx.actor === "scheduler" || !isManager(db, ctx.actor, { project: row.project, agent: null }) || ctx.actor === getMeta(db, row.project).team?.dispatcher) {
      throw new LedgerError("forbidden", "结果不明的部署只有项目 PM / master / owner 凭核对回执能结清");
    }
    const receipt = text(input.receipt, "回执");
    if (row.phase !== "unknown") throw new LedgerError("conflict", `部署运行当前是 ${row.phase}，只有 unknown 需要人工结清`);
    const now = ctx.now ?? Date.now();
    db.prepare("UPDATE scheduler_deploys SET phase='resolved', rev=rev+1, reason=?, updatedAt=? WHERE intentId=?").run(`${input.outcome}: ${receipt}`, now, row.intentId);
    const intent = getIntent(db, row.intentId);
    if (intent?.status === "submitted") {
      settleIntent(db, { ...ctx, now }, { id: row.intentId, from: "submitted", to: input.outcome === "done" ? "done" : "cancelled", receipt: `deploy ${input.outcome}: ${receipt}` });
    }
    // No verified receipt moved the stage, so the planner must not keep driving the card; the PM re-enables auto deliberately.
    db.prepare("UPDATE task_workflows SET mode='manual', rev=rev+1, updatedAt=? WHERE taskId=? AND mode='auto'").run(now, row.taskId);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:deploy:resolved` }, {
      project: row.project, target: row.taskId, kind: "scheduler", text: `自动部署：人工结清为 ${input.outcome}（${receipt}）`,
      data: { op: "deploy_resolve", intentId: row.intentId, from: "unknown", outcome: input.outcome, receipt, manual: true,
        queueFrozen: getMeta(db, row.project).queueFrozen.frozen },
    }, true);
    return getDeployRun(db, row.intentId) as DeployRun;
  });
}
