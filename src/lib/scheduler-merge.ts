/**
 * Durable merge journal: uncertain external effects freeze the queue instead of replaying commands.
 * The scheduler stops at `merged`; deployment stays with the PM (docs/design/scheduler-engine.md, 分期 T68g).
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow } from "./ledger-scheduler.js";
import { getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { currentReviewFacts } from "./scheduler-review.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { canTransition, nextTaskState } from "./ledger-stages.js";
import { settleIntent } from "./ledger-scheduler-write.js";

export type MergePhase = "ready" | "updating" | "await_review" | "await_ci" | "merging" | "merged" | "unknown" | "resolved";
export interface MergeRun {
  intentId: string;
  taskId: string;
  project: string;
  prRef: string;
  expectedBranch: string;
  reviewedHead: string;
  requiredChecks: string;
  phase: MergePhase;
  rev: number;
  mergeSha: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

const sha = (v: string | null | undefined): v is string => !!v && /^[a-f0-9]{40}$/i.test(v);
const text = (v: string | undefined, label: string): string => {
  const s = v?.trim() ?? "";
  if (!s || s.length > 600 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s)) throw new LedgerError("invalid", `${label} 要是单行且不超过 600 字`);
  return s;
};
const canWrite = (db: Database, actor: string, project: string): boolean =>
  actor === "scheduler" || (actor !== getMeta(db, project).team?.dispatcher && isManager(db, actor, { project, agent: null }));

export function getMergeRun(db: Database, intentId: string): MergeRun | null {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return null;
  return db.query("SELECT * FROM scheduler_merges WHERE intentId = ?").get(intentId) as MergeRun | null;
}

/** Re-read the ledger before every external effect; a PM pause or changed head invalidates the old run. */
export function mergeRunDrift(db: Database, run: MergeRun): string | null {
  const task = mustTask(db, run.taskId), workflow = getWorkflow(db, run.taskId), intent = getIntent(db, run.intentId);
  if (!workflow || workflow.mode !== "auto" || workflow.specRev !== task.specRev || intent?.status !== "submitted") {
    return "流程被暂停、规格已变或合并意图不再有效";
  }
  if (task.headSHA !== run.reviewedHead) return "任务 head 已变化，旧审查失效";
  if (task.pr !== run.prRef || task.branch !== run.expectedBranch) return "任务 PR 或分支已变化";
  if (task.stage !== "merge") return `任务阶段已从 merge 变为 ${task.stage}`;
  if (getMeta(db, run.project).queueFrozen.frozen) return "项目合并队列已冻结";
  if (["ready", "updating", "await_ci", "merging"].includes(run.phase)) {
    const review = currentReviewFacts(task, listEvents(db, { project: run.project, target: run.taskId }));
    if (review.kind !== "facts" || !["pass", "changes"].includes(review.facts.verdict) ||
      review.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1")) return "当前 head 的审查结论已不合格";
  }
  return null;
}

/** Recheck the original review, intended head and project merge lock under BEGIN IMMEDIATE. */
export function beginMergeRun(db: Database, ctx: WriteCtx, intentId: string, requiredChecks: readonly string[]): { run: MergeRun; duplicate: boolean } {
  return tx(db, () => {
    const intent = getIntent(db, intentId);
    if (!intent || intent.action !== "merge") throw new LedgerError("not_found", "没有合并调度意图");
    const task = mustTask(db, intent.taskId), workflow = getWorkflow(db, task.id);
    if (!canWrite(db, ctx.actor, task.project)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能执行合并队列");
    const old = getMergeRun(db, intentId);
    const checks = [...new Set(requiredChecks)];
    if (!checks.length || checks.length > 20 || checks.some((x) => !/^[\w .:/-]{1,80}$/.test(x))) {
      throw new LedgerError("invalid", "合并队列必须指定 1–20 个 CI 必过检查名");
    }
    if (old) {
      if (old.requiredChecks !== checks.join(",")) throw new LedgerError("dedup_mismatch", "本卡合并检查清单已固定");
      return { run: old, duplicate: true };
    }
    if (intent.status !== "submitted" || task.stage !== "merge" || workflow?.mode !== "auto" ||
      workflow.specRev !== task.specRev || task.rev !== intent.taskRev || !sha(task.headSHA) || task.headSHA !== intent.head) {
      throw new LedgerError("conflict", "合并意图、阶段、规格、任务版本或完整 head 不一致");
    }
    if (workflow.template === "ui") throw new LedgerError("conflict", "UI 截图 owner 许可须由 ask 适配器复核后才能自动合并");
    if (getMeta(db, task.project).queueFrozen.frozen) throw new LedgerError("conflict", "项目合并队列已冻结");
    const lock = db.query("SELECT 1 FROM scheduler_resources WHERE project=? AND resource=? AND intentId=?")
      .get(task.project, `merge:${task.project}`, intentId);
    if (!lock) throw new LedgerError("conflict", "本意图未占项目合并槽");
    const review = currentReviewFacts(task, listEvents(db, { project: task.project, target: task.id }));
    const reviewer = getSchedulerSession(db, task.id, "reviewer");
    if (review.kind !== "facts" || !reviewer || review.facts.reviewer !== reviewer.agent ||
      review.facts.reviewerSessionId !== reviewer.sessionId || review.facts.reviewerFamily !== reviewer.family ||
      review.facts.reviewerFamily === workflow.authorFamily ||
      !["pass", "changes"].includes(review.facts.verdict) ||
      review.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1")) {
      throw new LedgerError("conflict", "当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1");
    }
    if (!task.pr || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(task.pr) || !task.branch) {
      throw new LedgerError("invalid", "自动合并只接受完整 GitHub PR URL");
    }
    const now = ctx.now ?? Date.now();
    db.prepare(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`).run(intentId, task.id, task.project, task.pr, task.branch, task.headSHA, checks.join(","), now, now);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${intentId}:merge:ready` }, {
      project: task.project, target: task.id, kind: "scheduler", text: "合并队列已核对审查与 head",
      data: { op: "merge_phase", intentId, phase: "ready", head: task.headSHA, pr: task.pr, reviewSeq: review.facts.eventSeq },
    }, true);
    return { run: getMergeRun(db, intentId) as MergeRun, duplicate: false };
  });
}

const NEXT: Record<MergePhase, readonly MergePhase[]> = {
  ready: ["updating", "await_ci", "unknown"], updating: ["await_review", "await_ci", "unknown"],
  await_review: [], await_ci: ["merging", "unknown"], merging: ["merged", "unknown"],
  merged: [], unknown: [], resolved: [],
};

/** A phase claim is committed before the corresponding external call; receipts move it forward after observing reality. */
export function advanceMergeRun(db: Database, ctx: WriteCtx, input: {
  intentId: string; from: MergePhase; to: MergePhase; rev: number; receipt?: string; mergeSha?: string; newHead?: string;
}): MergeRun {
  return tx(db, () => {
    const row = getMergeRun(db, input.intentId);
    if (!row) throw new LedgerError("not_found", "没有合并运行记录");
    if (!canWrite(db, ctx.actor, row.project)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能推进合并队列");
    if (row.phase !== input.from || row.rev !== input.rev || !NEXT[input.from]?.includes(input.to)) {
      throw new LedgerError("conflict", `合并步骤当前 ${row.phase}@${row.rev}，不能从 ${input.from}@${input.rev} 推 ${input.to}`);
    }
    const drift = mergeRunDrift(db, row);
    if (drift && input.to !== "unknown" && input.to !== "await_review") throw new LedgerError("conflict", `合并运行已失效：${drift}`);
    const receipt = input.receipt ? text(input.receipt, "回执") : null;
    if (["await_ci", "merged", "unknown", "await_review"].includes(input.to) && !receipt) {
      throw new LedgerError("invalid", `${input.to} 需要可核对回执或原因`);
    }
    if (input.to === "merged" && !sha(input.mergeSha)) throw new LedgerError("invalid", "合并提交必须是完整 SHA");
    if (input.to === "await_review" && (!sha(input.newHead) || input.newHead === row.reviewedHead)) {
      throw new LedgerError("invalid", "更新分支后必须提供不同的完整 head");
    }
    const now = ctx.now ?? Date.now();
    if (input.to === "await_review") {
      const task = mustTask(db, row.taskId);
      if (task.stage !== "merge" || task.headSHA !== row.reviewedHead || !canTransition(task, "review", "pm").ok) {
        throw new LedgerError("conflict", "分支更新时任务阶段或旧 head 已变");
      }
      const next = nextTaskState(task, "review");
      db.prepare("UPDATE tasks SET headSHA=?, stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
        .run(input.newHead as string, next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
      db.prepare("UPDATE scheduler_intents SET status='cancelled', receipt=?, updatedAt=? WHERE id=?")
        .run(`head changed to ${input.newHead}`, now, row.intentId);
      db.prepare("DELETE FROM scheduler_resources WHERE intentId=?").run(row.intentId);
      insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage", text: "分支更新后重新审查新 head",
        data: { from: "merge", to: "review", round: next.round, specRev: next.specRev, head: input.newHead } }, false);
    }
    db.prepare("UPDATE scheduler_merges SET phase=?, rev=rev+1, mergeSha=COALESCE(?,mergeSha), reason=?, updatedAt=? WHERE intentId=?")
      .run(input.to, input.to === "merged" ? input.mergeSha ?? null : null, ["unknown", "await_review"].includes(input.to) ? receipt : null, now, row.intentId);
    if (input.to === "unknown") db.prepare("INSERT INTO meta (project,key,value) VALUES (?, 'queueFrozen', ?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value")
      .run(row.project, JSON.stringify({ frozen: true, reason: `合并结果不明：${receipt}`, since: now }));
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:${input.to}` }, {
      project: row.project, target: row.taskId, kind: "scheduler", text: `合并队列：${input.to}${receipt ? `（${receipt}）` : ""}`,
      data: { op: "merge_phase", intentId: row.intentId, from: row.phase, to: input.to, receipt,
        mergeSha: input.to === "merged" ? input.mergeSha : row.mergeSha },
    }, true);
    return getMergeRun(db, row.intentId) as MergeRun;
  });
}

export const MERGE_RESOLUTIONS = ["done", "failed", "cancelled"] as const;
export type MergeResolution = (typeof MERGE_RESOLUTIONS)[number];

/**
 * The only exit from `unknown`: a human manager who checked GitHub closes the journal with a receipt.
 * The scheduler identity can never do this, otherwise "freeze instead of guessing" would become "guess after a restart".
 * The project queue freeze is left alone on purpose: other unknown runs may remain, so unfreezing stays an explicit `ledger unfreeze`.
 */
export function resolveMergeRun(db: Database, ctx: WriteCtx, input: { intentId: string; outcome: MergeResolution; receipt: string | undefined }): MergeRun {
  return tx(db, () => {
    const row = getMergeRun(db, input.intentId);
    if (!row) throw new LedgerError("not_found", "没有合并运行记录；还没开始合并的意图用 scheduler-settle 结算");
    if (ctx.actor === "scheduler" || !canWrite(db, ctx.actor, row.project)) {
      throw new LedgerError("forbidden", "结果不明的合并只有项目 PM / master / owner 凭外部核对回执能结清");
    }
    if (!MERGE_RESOLUTIONS.includes(input.outcome)) throw new LedgerError("invalid", "--outcome 只能是 done / failed / cancelled");
    const receipt = text(input.receipt, "回执");
    if (row.phase !== "unknown") throw new LedgerError("conflict", `合并运行当前是 ${row.phase}，只有 unknown 需要人工结清`);
    const now = ctx.now ?? Date.now();
    db.prepare("UPDATE scheduler_merges SET phase='resolved', rev=rev+1, reason=?, updatedAt=? WHERE intentId=?")
      .run(`${input.outcome}: ${receipt}`, now, row.intentId);
    const intent = getIntent(db, row.intentId);
    if (intent && (intent.status === "submitted" || intent.status === "unknown")) {
      settleIntent(db, { ...ctx, now }, { id: row.intentId, from: intent.status, to: input.outcome === "done" ? "done" : "cancelled",
        receipt: `merge ${input.outcome}: ${receipt}` });
    }
    // The task stage was not moved by any verified receipt, so the planner must not keep driving it; PM re-enables auto deliberately.
    db.prepare("UPDATE task_workflows SET mode='manual', rev=rev+1, updatedAt=? WHERE taskId=? AND mode='auto'").run(now, row.taskId);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:merge:resolved` }, {
      project: row.project, target: row.taskId, kind: "scheduler", text: `合并队列：人工结清为 ${input.outcome}（${receipt}）`,
      data: { op: "merge_resolve", intentId: row.intentId, from: "unknown", outcome: input.outcome, receipt, manual: true,
        queueFrozen: getMeta(db, row.project).queueFrozen.frozen },
    }, true);
    return getMergeRun(db, row.intentId) as MergeRun;
  });
}
