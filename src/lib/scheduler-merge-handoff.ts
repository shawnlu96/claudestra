/**
 * Merge handoff (MHO1, docs/architecture/merge-handoff.md): in a project whose scheduler.json says `mergeHandoff`, the
 * repository owner merges. An auto card in `merge` is handed over with this machine's review evidence instead of entering the
 * merge queue, and moves to live only once GitHub shows its PR merged at the handed-over head, or at one reached from it only by
 * merging main in (each hop a carry record). Nothing here talks to GitHub: the auto tick reads the PR
 * (scheduler-merge-handoff-tick.ts) and these writes recheck the ledger in their own transaction.
 */
import type { Database } from "bun:sqlite";
import { mustTask, type WriteCtx } from "./ledger-checks.js";
import { getWorkflow, type AuthorFamily, type TaskWorkflow, type WorkflowTemplate } from "./ledger-scheduler.js";
import { canTransition, nextTaskState, type LedgerEvent, type LedgerTask } from "./ledger-stages.js";
import { getEventByDedup, getMeta, LedgerError, listEvents } from "./ledger-store.js";
import { insertEvent, tx } from "./ledger-tx.js";
import { releaseFinishedCardLeases } from "./ledger-scheduler-lease.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { mergeReviewProof } from "./scheduler-merge.js";
import { uiMergeRefusal } from "./scheduler-ui-merge-refusal.js";

/**
 * What goes with the PR (field list and meaning in the doc). Grouped by kind of proof so a later one (CI, owner acceptance,
 * a peer's countersignature) is a new key next to `review`; a changed meaning bumps `v` instead of reusing a name.
 */
interface HandoffEvidence {
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
const CARRY_OP = "merge_handoff_carry";
/** How a carry was proved (scheduler-main-merge-carry.ts): the new tree is git's clean merge, or the net diff is byte-identical. */
const CARRY_BASIS = ["auto-merge", "net-diff"] as const;
const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;

/** The card's latest entry into `merge`: a handoff belongs to one stay there, a card that comes back hands over again. */
const mergeEntry = (events: readonly LedgerEvent[]): number => events.findLast((e) => e.kind === "stage" && e.data.to === "merge")?.seq ?? 0;

/** This stay's handoff and the PR head it follows now: the handed head, moved on by each carry recorded after it. */
export interface HandoffFollow { event: LedgerEvent; evidence: HandoffEvidence; head: string; carrySeq: number | null }
export function handoffOf(db: Database, task: LedgerTask): HandoffFollow | null {
  const events = listEvents(db, { project: task.project, target: task.id });
  const since = mergeEntry(events);
  const event = events.findLast((e) => e.seq > since && e.kind === "scheduler" && e.data.op === "merge_handoff");
  if (!event) return null;
  const evidence = event.data.evidence as HandoffEvidence;
  let head = evidence.head, carrySeq: number | null = null;
  // only the scheduler's own carries, each starting where the last ended (recordHandoffCarry checks it in its transaction)
  for (const e of events) {
    if (e.seq <= event.seq || e.kind !== "scheduler" || e.actor !== "scheduler" || e.data.op !== CARRY_OP || e.data.handoffSeq !== event.seq) continue;
    if (e.data.from === head && typeof e.data.to === "string" && SHA.test(e.data.to)) [head, carrySeq] = [e.data.to, e.seq];
  }
  return { event, evidence, head, carrySeq };
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

/**
 * After the handoff the owner merged main into the PR (update-branch): the parents and that only main came in were checked
 * against the head followed so far (scheduler-main-merge-carry.ts), so this machine's review still covers the PR. The card's own
 * head stays the reviewed one; the PR head followed moves on, and a replay returns the first record.
 */
export function recordHandoffCarry(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string; from: string; to: string;
  mainParent: string; mainHead: string; diffHash: string; basis: string }): { event: LedgerEvent; duplicate: boolean } {
  return tx(db, () => {
    const { task } = handoffCard(db, ctx, input);
    const follow = handoffOf(db, task);
    if (follow?.evidence.head !== input.head || follow.evidence.pr !== input.pr) throw new LedgerError("conflict", "这个 PR 和 head 没有交接记录");
    if (![input.from, input.to, input.mainParent, input.mainHead].every((s) => SHA.test(s)) || !/^[a-f0-9]{64}$/.test(input.diffHash)) {
      throw new LedgerError("invalid", "新 head、main 父提交、main 头要是完整 SHA，净 diff 要是 sha256");
    }
    if (!(CARRY_BASIS as readonly string[]).includes(input.basis)) throw new LedgerError("invalid", `--basis 只能是 ${CARRY_BASIS.join(" / ")}`);
    const key = `scheduler:${CARRY_OP}:${task.id}:h${follow.event.seq}:${input.from}:${input.to}`;
    const prev = getEventByDedup(db, key);
    if (prev) return { event: prev, duplicate: true };
    if (follow.head !== input.from || input.from === input.to) throw new LedgerError("conflict", `交接后跟的 PR head 是 ${follow.head.slice(0, 12)}，不是 ${input.from.slice(0, 12)}`);
    const event = insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: key }, { project: task.project, target: task.id, kind: "scheduler",
      text: `交接后 PR 只合入了 main：${input.from.slice(0, 12)} → ${input.to.slice(0, 12)}，${input.basis === "auto-merge" ? "新 head 就是自动合并结果" : "净 diff 不变"}，继续跟`,
      data: { op: CARRY_OP, handoffSeq: follow.event.seq, from: input.from, to: input.to, mainParent: input.mainParent,
        mainHead: input.mainHead, diffHash: input.diffHash, basis: input.basis } }, true);
    return { event, duplicate: false };
  });
}

/** GitHub shows the handed-over PR merged at the head the handoff follows: the card moves merge → live with the merge commit. */
export function landMergeHandoff(db: Database, ctx: WriteCtx, input: { taskId: string; head: string; pr: string; mergeSha: string }): LedgerTask {
  return tx(db, () => {
    const { task } = handoffCard(db, ctx, input);
    const follow = handoffOf(db, task);
    if (follow?.evidence.head !== input.head || follow.evidence.pr !== input.pr) throw new LedgerError("conflict", "这个 PR 和 head 没有交接记录");
    if (!SHA.test(input.mergeSha)) throw new LedgerError("invalid", "合并提交必须是完整 SHA");
    const move = canTransition(task, "live", "pm");
    if (!move.ok) throw new LedgerError("conflict", move.reason);
    const now = ctx.now ?? Date.now(), next = nextTaskState(task, "live");
    db.prepare("UPDATE tasks SET stage=?, stageBefore=?, round=?, specRev=?, rev=rev+1, updatedAt=? WHERE id=?")
      .run(next.stage, next.stageBefore, next.round, next.specRev, now, task.id);
    // head = the PR head GitHub merged; a carried one names the reviewed head and the last carry it was reached by
    const carried = follow.carrySeq === null ? {} : { handedHead: follow.evidence.head, carrySeq: follow.carrySeq };
    insertEvent(db, { actor: ctx.actor, now }, { project: task.project, target: task.id, kind: "stage", text: `仓库方已合并 ${input.mergeSha.slice(0, 12)}，进入 live`,
      data: { from: "merge", to: "live", round: next.round, specRev: next.specRev, head: follow.head, mergeSha: input.mergeSha, handoffSeq: follow.event.seq, ...carried } }, false);
    // same release as every other move to live (ledger-write.ts): merged code no longer needs the card's file locks
    releaseFinishedCardLeases(db, task.id);
    return mustTask(db, task.id);
  });
}
