/**
 * Merge handoff (MHO1, docs/architecture/merge-handoff.md): in a project whose scheduler.json says `mergeHandoff`, the
 * repository owner merges. An auto card in `merge` is handed over with this machine's review evidence instead of entering the
 * merge queue, and moves to live only once GitHub shows its PR merged at the handed-over head. Nothing here talks to GitHub:
 * the auto tick reads the PR (scheduler-merge-handoff-tick.ts) and these writes recheck the ledger in their own transaction.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type AuthorFamily, type TaskWorkflow, type WorkflowTemplate } from "./ledger-scheduler.js";
import { canTransition, nextTaskState, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { mergeReviewProof } from "./scheduler-merge.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

/**
 * What goes with the PR (field list and meaning in the doc). Grouped by kind of proof so a later one (CI, owner acceptance,
 * a peer's countersignature) is a new key next to `review`; a changed meaning bumps `v` instead of reusing a name.
 */
export interface HandoffEvidence {
  v: 1;
  pr: string;
  /** Pinned head: at handoff the PR head, the card's head and the reviewed head are this one commit. */
  head: string;
  specRev: number;
  template: WorkflowTemplate;
  /** Family that wrote the head (a peer's delivery counts as its own family). */
  authorFamily: AuthorFamily;
  review: { round: number; verdict: "pass" | "changes"; reviewerFamily: AuthorFamily; reportPath: string; p2: number; reviewSeq: number };
}

const SHA = /^[a-f0-9]{40}$/i;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;

/** The card's latest entry into `merge`: a handoff belongs to one stay there, a card that comes back hands over again. */
const mergeEntry = (events: readonly LedgerEvent[]): number => events.findLast((e) => e.kind === "stage" && e.data.to === "merge")?.seq ?? 0;

/** This stay's handoff record, or null. */
export function handoffOf(db: Database, task: LedgerTask): LedgerEvent | null {
  const events = listEvents(db, { project: task.project, target: task.id });
  const since = mergeEntry(events);
  return events.findLast((e) => e.seq > since && e.kind === "scheduler" && e.data.op === "merge_handoff") ?? null;
}

/** Scheduler only, auto card in `merge` on this spec, at exactly this full head and PR. */
function handoffCard(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string }): { task: LedgerTask; workflow: TaskWorkflow } {
  if (ctx.actor !== "scheduler") throw new LedgerError("forbidden", "合并交接只由调度服务记");
  const task = mustTask(db, input.taskId), workflow = getWorkflow(db, task.id);
  if (task.stage !== "merge" || workflow?.mode !== "auto" || workflow.specRev !== task.specRev) {
    throw new LedgerError("conflict", "任务不在自动流程的 merge 阶段，或规格版本已变");
  }
  if (!SHA.test(input.head) || task.headSHA !== input.head) throw new LedgerError("conflict", "交接的 head 不是任务当前的完整 head");
  if (!PR_URL.test(input.pr) || task.pr !== input.pr) throw new LedgerError("conflict", "交接的 PR 不是任务上的完整 GitHub PR URL");
  return { task, workflow };
}

/** Write the handoff record once per stay in `merge` and head; a replay returns the first record. */
export function recordMergeHandoff(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string }): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const { task, workflow } = handoffCard(db, ctx, input);
    const events = listEvents(db, { project: task.project, target: task.id });
    const key = `scheduler:merge_handoff:${task.id}:s${mergeEntry(events)}:${input.head}`;
    const prev = getEventByDedup(db, key);
    if (prev) return { event: prev, duplicate: true };
    if (getMeta(db, task.project).queueFrozen.frozen) throw new LedgerError("conflict", "项目合并队列已冻结");
    const now = ctx.now ?? Date.now();
    const ui = workflow.template === "ui" ? uiMergeRefusal(db, task, now) : null;
    if (ui) throw new LedgerError("conflict", ui);
    const review = mergeReviewProof(db, task, workflow);
    if (review.head !== input.head) throw new LedgerError("conflict", "审查结论不是这个 head 的");
    const evidence: HandoffEvidence = { v: 1, pr: input.pr, head: input.head, specRev: task.specRev, template: workflow.template,
      authorFamily: remoteHeadFamily(db, task) ?? workflow.authorFamily,
      review: { round: review.round, verdict: review.verdict as "pass" | "changes", reviewerFamily: review.reviewerFamily, reportPath: review.reportPath,
        p2: review.findings.filter((f) => f.severity === "P2").length, reviewSeq: review.eventSeq } };
    const event = insertEvent(db, { actor: ctx.actor, now, dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `合并交给仓库方：${input.pr} @ ${input.head.slice(0, 12)}`, data: { op: "merge_handoff", evidence } }, true);
    return { event, duplicate: false };
  });
}

/** GitHub shows the handed-over PR merged at the handed-over head: the card moves merge → live with the merge commit. */
export function landMergeHandoff(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string; mergeSha: string }): LedgerTask {
  return tx(db, () => {
    const { task } = handoffCard(db, ctx, input);
    const handoff = handoffOf(db, task), evidence = handoff?.data.evidence as HandoffEvidence | undefined;
    if (evidence?.head !== input.head || evidence.pr !== input.pr) throw new LedgerError("conflict", "这个 PR 和 head 没有交接记录");
    if (!SHA.test(input.mergeSha)) throw new LedgerError("invalid", "合并提交必须是完整 SHA");
    const move = canTransition(task, "live", "pm");
    if (!move.ok) throw new LedgerError("conflict", move.reason);
    const now = ctx.now ?? Date.now(), next = nextTaskState(task, "live");
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
    insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage", text: `仓库方已合并 ${input.mergeSha.slice(0, 12)}，进入 live`,
      data: { from: "merge", to: "live", round: next.round, specRev: next.specRev, head: input.head, mergeSha: input.mergeSha, handoffSeq: handoff!.seq } }, false);
    return mustTask(db, task.id);
  });
}
