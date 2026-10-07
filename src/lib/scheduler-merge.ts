/**
 * Durable merge journal: uncertain external effects freeze the queue instead of replaying commands.
 * The scheduler stops at `merged`; deployment stays with the PM (docs/design/scheduler-engine.md, 分期 T68g).
 */
import type { Database } from "bun:sqlite";
import { isManager, mustTask, type WriteCtx } from "./ledger-checks.js";
import { getIntent, getWorkflow, type TaskWorkflow, type SchedulerIntent } from "./ledger-scheduler.js";
import { getEventByDedup, getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { currentReviewFacts, type ReviewFacts } from "./scheduler-review.js";
import { getSchedulerSession } from "./scheduler-sessions.js";
import { currentPooledReviewer } from "./scheduler-pool-facts.js";
import { canTransition, nextTaskState, type LedgerTask } from "./ledger-stages.js";
import { actorMayConfigure, settleIntent } from "./ledger-scheduler-settle.js";
import { parseRequiredChecks } from "./scheduler-config.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { exemptVerdict } from "./scheduler-review-swap.js";
import { cancelMergeRun, closeMergeRun, manualCancel } from "./scheduler-merge-conflict.js";
import { autoCarryEvidence, carryChainOf } from "./review-main-carry-manual-auto.js";
import { isSlotTurn, turnMergeSlot } from "./scheduler-merge-train-hold.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";
import { MANUAL_MERGE_NODE, manualRunDrift, manualRunReviewer, manualUnsentAtSend } from "./manual-merge-queue-facts.js";
import { poolReviewRefusal } from "./pool-review-proof.js";
import { readyCarryPrior } from "./scheduler-merge-ready-carry.js";
import { sendSourceRefusal } from "./review-main-carry-send-source.js";
import { uiCarryPlan, type UiCarryPlan } from "./scheduler-ui-carry.js";
import { handoffGateRefusal } from "./handoff-gate.js";

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
  /** Absent only when a read-only client sees a database its writer has not migrated yet. */
  unknownSince?: number | null;
  createdAt: number;
  updatedAt: number;
  /** Never stored. The merge driver sets it on the run of its last recheck before the merge call (scheduler-merge-driver.ts
   *  claimAndMerge): the one read that must still treat the committed `merging` claim as unsent (manual-merge-queue-facts.ts). */
  beforeSend?: true;
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
  // prepare, not query: a cached `SELECT *` keeps its column list, so the scheduler's long-lived reader would never see a
  // column a newer CLI migrated in (unknownSince → the UNKNOWN limit silently stops). tests/scheduler-merge-mergestate.test.ts.
  return db.prepare("SELECT * FROM scheduler_merges WHERE intentId = ?").get(intentId) as MergeRun | null;
}

/** Re-read the ledger before every external effect; a PM pause or changed head invalidates the old run. */
export function mergeRunDrift(db: Database, run: MergeRun, now = Date.now()): string | null {
  const task = mustTask(db, run.taskId), workflow = getWorkflow(db, run.taskId), intent = getIntent(db, run.intentId);
  const manual = intent?.node === MANUAL_MERGE_NODE; // a PM's manual merge request holds the run (manual-merge-queue.ts)
  if (!workflow || workflow.mode !== (manual ? "manual" : "auto") || workflow.specRev !== task.specRev || intent?.status !== "submitted") {
    return "流程被暂停、规格已变或合并意图不再有效";
  }
  const request = manual ? manualRunDrift(db, intent, now, run.phase, run.beforeSend === true) : null;
  if (request) return request;
  if (task.headSHA !== run.reviewedHead) return "任务 head 已变化，旧审查失效";
  if (task.pr !== run.prRef || task.branch !== run.expectedBranch) return "任务 PR 或分支已变化";
  if (task.stage !== "merge") return `任务阶段已从 merge 变为 ${task.stage}`;
  if (getMeta(db, run.project).queueFrozen.frozen) return "项目合并队列已冻结";
  if (["ready", "updating", "await_ci", "merging"].includes(run.phase)) {
    const review = currentReviewFacts(task, listEvents(db, { project: run.project, target: run.taskId }), (a) => actorMayConfigure(db, a, task.project));
    if (review.kind !== "facts" || !["pass", "changes"].includes(review.facts.verdict) ||
      review.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1")) return "当前 head 的审查结论已不合格";
    // The screenshot approval is re-read like the review: withdrawn, replaced or bound to an older head, the run stops before GitHub.
    const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, now) : null;
    if (ui) return `UI 截图验收已失效：${ui}`;
    const gate = run.phase === "merging" ? null : handoffGateRefusal(db, task, intent.createdAt); // merging: already sent to GitHub
    if (gate) return gate;
    if (run.beforeSend && !manual) return sendSourceRefusal(db, run, task, workflow, mergeReviewProof); // MCRY6: the pinned source, re-proved
  }
  return null;
}

/**
 * The current head's passing review by this card's cross-family reviewer session, or a refusal. One rule for every road out of
 * `merge`: the merge run (beginMergeRun) and the repository-owner handoff (scheduler-merge-handoff.ts).
 */
export function mergeReviewProof(db: Database, task: LedgerTask, workflow: TaskWorkflow, manual?: { intent: SchedulerIntent; now: number }): ReviewFacts {
  const review = currentReviewFacts(task, listEvents(db, { project: task.project, target: task.id }), (a) => actorMayConfigure(db, a, task.project));
  // A pooled round never writes scheduler_sessions; a local row may be an earlier round's, so this round's pool order wins.
  const reviewer = manual ? manualRunReviewer(db, manual.intent, manual.now)
    : currentPooledReviewer(db, task) ?? getSchedulerSession(db, task.id, "reviewer");
  if (review.kind !== "facts" || !reviewer || review.facts.reviewer !== reviewer.agent ||
    review.facts.reviewerSessionId !== reviewer.sessionId || review.facts.reviewerFamily !== reviewer.family ||
    (review.facts.reviewerFamily === (remoteHeadFamily(db, task) ?? workflow.authorFamily) && (manual || !exemptVerdict(db, task, review.facts))) ||
    !["pass", "changes"].includes(review.facts.verdict) ||
    review.facts.findings.some((f) => f.severity === "P0" || f.severity === "P1")) {
    throw new LedgerError("conflict", "当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1");
  }
  const pool = manual ? null : poolReviewRefusal(db, task, workflow, review.facts);
  if (pool) throw new LedgerError("conflict", pool);
  return review.facts;
}

/** Recheck the original review, intended head and project merge lock under BEGIN IMMEDIATE. */
export function beginMergeRun(db: Database, ctx: WriteCtx, intentId: string, requiredChecks: readonly string[]): { run: MergeRun; duplicate: boolean } {
  return tx(db, () => {
    const intent = getIntent(db, intentId);
    if (!intent || intent.action !== "merge") throw new LedgerError("not_found", "没有合并调度意图");
    const task = mustTask(db, intent.taskId), workflow = getWorkflow(db, task.id);
    if (!canWrite(db, ctx.actor, task.project)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能执行合并队列");
    const old = getMergeRun(db, intentId);
    const checks = parseRequiredChecks(requiredChecks);
    if (!checks) throw new LedgerError("invalid", "合并队列必须指定 1–20 个 CI 必过检查名");
    if (old) {
      if (old.requiredChecks !== checks.join(",")) throw new LedgerError("dedup_mismatch", "本卡合并检查清单已固定");
      return { run: old, duplicate: true };
    }
    const manual = intent.node === MANUAL_MERGE_NODE, now = ctx.now ?? Date.now();
    if (intent.status !== "submitted" || task.stage !== "merge" || workflow?.mode !== (manual ? "manual" : "auto") ||
      workflow.specRev !== task.specRev || task.rev !== intent.taskRev || !sha(task.headSHA) || task.headSHA !== intent.head) {
      throw new LedgerError("conflict", "合并意图、阶段、规格、任务版本或完整 head 不一致");
    }
    // Same gate as the merge intent's write (requireReviewedMerge), re-read here: PM acceptance, or the owner's for ownerVisual.
    const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, now) : null;
    if (ui) throw new LedgerError("conflict", ui);
    if (getMeta(db, task.project).queueFrozen.frozen) throw new LedgerError("conflict", "项目合并队列已冻结");
    const gate = handoffGateRefusal(db, task, intent.createdAt); // an intent planned before the hold went on is exempt from it
    if (gate) throw new LedgerError("conflict", gate);
    const lock = db.query("SELECT 1 FROM scheduler_resources WHERE project=? AND resource=? AND intentId=?")
      .get(task.project, `merge:${task.project}`, intentId);
    if (!lock) throw new LedgerError("conflict", "本意图未占项目合并槽");
    const review = mergeReviewProof(db, task, workflow, manual ? { intent, now } : undefined);
    if (!task.pr || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(task.pr) || !task.branch) {
      throw new LedgerError("invalid", "自动合并只接受完整 GitHub PR URL");
    }
    db.prepare(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`).run(intentId, task.id, task.project, task.pr, task.branch, task.headSHA, checks.join(","), now, now);
    insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${intentId}:merge:ready` }, {
      project: task.project, target: task.id, kind: "scheduler", text: "合并队列已核对审查与 head",
      data: { op: "merge_phase", intentId, phase: "ready", head: task.headSHA, pr: task.pr, reviewSeq: review.eventSeq },
    }, true);
    return { run: getMergeRun(db, intentId) as MergeRun, duplicate: false };
  });
}

const NEXT: Record<MergePhase, readonly MergePhase[]> = {
  ready: ["updating", "await_ci", "await_review", "unknown", "resolved"], updating: ["await_review", "await_ci", "unknown", "resolved"],
  await_review: [], await_ci: ["merging", "updating", "await_review", "unknown", "resolved"], merging: ["merged", "unknown"],
  merged: [], unknown: [], resolved: [],
};
/** main moving during CI sends the run back to update-branch; past this many times it is someone else's race to settle. */
export const MAX_CI_REFRESHES = 3;

/** update-branch only merged main in, so the review stays valid; the receipt is the single place the evidence is spelled out. */
export interface CarryEvidence { oldHead: string; newHead: string; mainParent: string; mainHead: string; diffHash: string }
export const carryReceipt = (e: CarryEvidence): string => `沿用审查：原 head ${e.oldHead} → 新 head ${e.newHead}，main 父提交 ${e.mainParent}，` +
  `main 头 ${e.mainHead}，净 diff 一致 sha256=${e.diffHash}，等待 CI`;
const CARRY_RECEIPT = /^沿用审查：原 head ([a-f0-9]{40}) → 新 head ([a-f0-9]{40})，main 父提交 ([a-f0-9]{40})，main 头 ([a-f0-9]{40})，净 diff 一致 sha256=([a-f0-9]{64})，等待 CI$/;
export function parseCarryReceipt(receipt: string): CarryEvidence | null {
  const m = CARRY_RECEIPT.exec(receipt);
  return m ? { oldHead: m[1]!, newHead: m[2]!, mainParent: m[3]!, mainHead: m[4]!, diffHash: m[5]! } : null;
}

/**
 * Re-pin run and task on the carried head in the merge step's own transaction; scheduler-review.ts only honours carries
 * written here (actor scheduler, merge_phase right after), so a PM / peer / executor note can never launder a head.
 */
function carryReview(db: Database, ctx: WriteCtx, row: MergeRun, newHead: string, receipt: string, now: number, chainRaw?: string): { seq: number; ui: UiCarryPlan } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "沿用审查只许调度服务身份写");
  const ev = parseCarryReceipt(receipt);
  if (!ev || ev.oldHead !== row.reviewedHead || ev.newHead !== newHead) throw new LedgerError("invalid", "沿用审查回执缺证据或 head 对不上");
  const task = mustTask(db, row.taskId);
  if (task.stage !== "merge" || task.headSHA !== row.reviewedHead) throw new LedgerError("conflict", "沿用审查时任务阶段或旧 head 已变");
  // MCRY2: from ready the head was moved before this attempt began: only the previous attempt's own update-branch carries
  const priorIntent = row.phase === "ready" ? readyCarryPrior(db, row, task, getMergeRun) : null;
  const carried = autoCarryEvidence(db, task, ev, chainRaw, mergeReviewProof, undefined, { intent: getIntent(db, row.intentId), now });
  const ui = uiCarryPlan(db, task, row.intentId, ev, now); // UICAR2: pre-move card, the receipt re-proved where the touched list is read
  db.prepare("UPDATE tasks SET headSHA=?, rev=rev+1, updatedAt=? WHERE id=?").run(newHead, now, task.id);
  db.prepare("UPDATE scheduler_merges SET reviewedHead=? WHERE intentId=?").run(newHead, row.intentId);
  return { ui, seq: insertEvent(db, { actor: ctx.actor, now, dedupKey: `scheduler:${row.intentId}:carry:${row.rev}` }, {
    project: row.project, target: row.taskId, kind: "scheduler", text: `沿用审查到新 head ${newHead.slice(0, 12)}`,
    data: { op: "review_carry", intentId: row.intentId, from: row.reviewedHead, to: newHead, round: task.round, specRev: task.specRev,
      mainParent: ev.mainParent, mainHead: ev.mainHead, diffHash: ev.diffHash, ...carried, ...(priorIntent ? { priorIntent } : {}) },
  }, true).seq };
}

const ciRefreshes = (db: Database, row: MergeRun): number => (db.query(`SELECT COUNT(*) AS n FROM events WHERE target=? AND kind='scheduler'
  AND json_extract(data,'$.op')='merge_phase' AND json_extract(data,'$.intentId')=? AND json_extract(data,'$.from')='await_ci'
  AND json_extract(data,'$.to')='updating'`).get(row.taskId, row.intentId) as { n: number }).n;

export const MERGE_UNKNOWN_WAIT = "GitHub 合并状态：UNKNOWN，等待计算";
export const MERGE_UNKNOWN_CLEAR = "GitHub 合并状态：结束 UNKNOWN 等待";

/** Same-phase observations use the existing manager step (lease + CAS), without claiming an external effect. */
function observeMergeState(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string | undefined): MergeRun {
  if (!["ready", "updating", "await_ci"].includes(row.phase) || (![MERGE_UNKNOWN_WAIT, MERGE_UNKNOWN_CLEAR].includes(receipt ?? "") && !isSlotTurn(receipt))) {
    throw new LedgerError("invalid", "同阶段只接受活动合并的 UNKNOWN 等待观察");
  }
  const drift = mergeRunDrift(db, row, ctx.now ?? Date.now());
  if (drift) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
  const now = ctx.now ?? Date.now();
  if (isSlotTurn(receipt)) { turnMergeSlot(db, ctx, row, receipt, now); return getMergeRun(db, row.intentId) as MergeRun; } // i28-MT1f2f2: lend the slot to a live train / take it back
  const since = receipt === MERGE_UNKNOWN_WAIT ? row.unknownSince ?? now : null;
  if (since !== row.unknownSince) {
    db.prepare("UPDATE scheduler_merges SET unknownSince=?, rev=rev+1, updatedAt=? WHERE intentId=?").run(since, now, row.intentId);
  }
  return getMergeRun(db, row.intentId) as MergeRun;
}

/** A phase claim is committed before the corresponding external call; receipts move it forward after observing reality. */
export function advanceMergeRun(db: Database, ctx: WriteCtx, input: {
  intentId: string; from: MergePhase; to: MergePhase; rev: number; receipt?: string; mergeSha?: string; newHead?: string;
}): MergeRun {
  return tx(db, () => {
    const row = getMergeRun(db, input.intentId);
    if (!row) throw new LedgerError("not_found", "没有合并运行记录");
    if (!canWrite(db, ctx.actor, row.project)) throw new LedgerError("forbidden", "只有项目 PM / master / owner 能推进合并队列");
    if (row.phase !== input.from || row.rev !== input.rev || (input.from !== input.to && !NEXT[input.from]?.includes(input.to))) {
      throw new LedgerError("conflict", `合并步骤当前 ${row.phase}@${row.rev}，不能从 ${input.from}@${input.rev} 推 ${input.to}`);
    }
    if (input.from === input.to) return observeMergeState(db, ctx, row, input.receipt);
    if (input.to === "resolved") { // before any merge was sent: a conflict / red CI goes back to fix, a manual switch ends it; no freeze
      closeMergeRun(db, ctx, row, input.receipt, mergeRunDrift(db, row, ctx.now ?? Date.now()));
      return getMergeRun(db, row.intentId) as MergeRun;
    }
    // Every road to unknown passes here: once the PM took the card over and no merge was sent, whatever made the driver
    // give up (a refused claim, a red optional check, a drift) ends the run as cancelled instead of freezing the queue.
    if (input.to === "unknown" && (manualCancel(db, row) || manualUnsentAtSend(db, row, input.receipt))) {
      cancelMergeRun(db, ctx, row, text(input.receipt, "回执"));
      return getMergeRun(db, row.intentId) as MergeRun;
    }
    const drift = mergeRunDrift(db, row, ctx.now ?? Date.now());
    // Only updating → await_review follows an update this attempt sent; from ready a drift (PM switch) is refused, so the driver's unknown cancels.
    if (drift && input.to !== "unknown" && !(input.to === "await_review" && input.from === "updating")) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
    const chain = carryChainOf(input.receipt); if (chain) input = { ...input, receipt: chain.base }; // MAINP2 chain after the receipt
    const receipt = input.receipt ? text(input.receipt, "回执") : null;
    if (["await_ci", "merged", "unknown", "await_review"].includes(input.to) && !receipt) {
      throw new LedgerError("invalid", `${input.to} 需要可核对回执或原因`);
    }
    if (input.to === "merged" && !sha(input.mergeSha)) throw new LedgerError("invalid", "合并提交必须是完整 SHA");
    if ((input.to === "await_review" || (input.to === "await_ci" && input.newHead)) && (!sha(input.newHead) || input.newHead === row.reviewedHead)) {
      throw new LedgerError("invalid", "更新分支后必须提供不同的完整 head");
    }
    if (input.from === "await_ci" && input.to === "updating" && ciRefreshes(db, row) >= MAX_CI_REFRESHES) {
      throw new LedgerError("conflict", `等 CI 期间 main 已前进 ${MAX_CI_REFRESHES} 次，不再自动更新`);
    }
    const now = ctx.now ?? Date.now();
    const carry = input.to === "await_ci" && input.newHead ? carryReview(db, ctx, row, input.newHead, receipt as string, now, chain?.raw) : null;
    const carrySeq = carry?.seq ?? null;
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
    db.prepare("UPDATE scheduler_merges SET phase=?, rev=rev+1, mergeSha=COALESCE(?,mergeSha), reason=?, unknownSince=NULL, updatedAt=? WHERE intentId=?")
      .run(input.to, input.to === "merged" ? input.mergeSha ?? null : null, ["unknown", "await_review"].includes(input.to) ? receipt : null, now, row.intentId);
    if (input.to === "unknown") db.prepare("INSERT INTO meta (project,key,value) VALUES (?, 'queueFrozen', ?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value")
      .run(row.project, JSON.stringify({ frozen: true, reason: `合并结果不明：${receipt}`, since: now }));
    // updating / await_ci can recur in one run (main moved during CI); later visits are keyed by the run revision.
    const key = `scheduler:${row.intentId}:merge:${input.to}`;
    insertEvent(db, { actor: ctx.actor, now, dedupKey: getEventByDedup(db, key) ? `${key}:${row.rev}` : key }, {
      project: row.project, target: row.taskId, kind: "scheduler", text: `合并队列：${input.to}${receipt ? `（${receipt}）` : ""}`,
      data: { op: "merge_phase", intentId: row.intentId, from: row.phase, to: input.to, receipt,
        mergeSha: input.to === "merged" ? input.mergeSha : row.mergeSha, ...(carrySeq ? { carrySeq } : {}), ...(carry?.ui.note ? { note: carry.ui.note } : {}) },
    }, true);
    carry?.ui.commit(carry.seq); // UICAR2: right after the carry's merge_phase (scheduler-ui-carry-read.ts reads it at carrySeq + 2)
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
    db.prepare("UPDATE scheduler_merges SET phase='resolved', rev=rev+1, reason=?, unknownSince=NULL, updatedAt=? WHERE intentId=?")
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
