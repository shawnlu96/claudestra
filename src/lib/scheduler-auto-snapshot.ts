import { convergenceSnapshot } from "./fix-strategy-plan.js";
/**
 * Auto cards: the planner sees only the engine's own facts. Sessions are the ledger bindings (never a registry guess),
 * intents are the real scheduler_intents rows (PM's manual dispatches are not engine proof), and a review dispatch counts
 * only with its durable `submitted` receipt. `exclude` replays the plan as it stood before one intent existed, which is
 * how a pending intent's full decision (target stage, work order, ask binding) is recovered after a restart.
 */
import type { Database } from "bun:sqlite";
import type { SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { getEventByDedup } from "./ledger-store.js";
import type { PlannerSnapshot, WorkerRef } from "./scheduler-plan.js";
import { remoteHeadFamily } from "./scheduler-head-family.js";
import { currentPooledReviewer, poolAckSeq, poolFacts, poolReviewerOf, strayPoolOrders } from "./scheduler-pool-facts.js";
import { isPoolIntent } from "./scheduler-pool-plan.js";
import { taskWorkerRefs } from "./scheduler-sessions.js";
import { observeSnapshot, type SnapshotOpts } from "./scheduler-snapshot.js";
import { fixDiffOf } from "./review-converge-scope.js";

type ReviewProof = PlannerSnapshot["reviewDispatches"][number];

/**
 * Round = the round the card entered review with before this intent was planned; no receipt or no round = no proof.
 * A pool intent's receipt is the peer's claim note and its reviewer is the one its own answered order recorded.
 */
function reviewProofs(db: Database, events: readonly LedgerEvent[], intents: readonly SchedulerIntent[], reviewer: WorkerRef | null): ReviewProof[] {
  const out: ReviewProof[] = [];
  for (const i of intents) {
    if (i.action !== "review" || !i.head || (i.status !== "submitted" && i.status !== "done")) continue;
    const pooled = isPoolIntent(i);
    const who = pooled ? poolReviewerOf(db, i.id, i.taskId) : reviewer;
    if (!who || i.recipient !== who.agent) continue;
    const ackSeq = pooled ? poolAckSeq(db, i.id) : getEventByDedup(db, `scheduler:${i.id}:submitted`)?.seq ?? null;
    const entered = events.findLast((e) => e.kind === "stage" && e.data.to === "review" && e.seq < i.eventSeq);
    if (!ackSeq || typeof entered?.data.round !== "number") continue;
    out.push({ intentId: i.id, round: entered.data.round, head: i.head, reviewer: who.agent, reviewerSessionId: who.sessionId, ackSeq });
  }
  return out;
}

export function autoSnapshot(db: Database, task: LedgerTask, opts: SnapshotOpts, exclude?: string): PlannerSnapshot {
  const base = observeSnapshot(db, task, opts);
  const bound = taskWorkerRefs(db, task.id);
  const intents = base.intents.filter((i) => !i.id.startsWith("pm-dispatch:") && i.id !== exclude);
  // The current round's verdict came from the pool: that order's peer worker is the reviewer the verdict is checked against.
  const reviewer = currentPooledReviewer(db, task) ?? bound.reviewer;
  // A head a peer delivered was written in that order's family: review placement, reviewer session and gates go across from it.
  const wrote = remoteHeadFamily(db, task);
  const workflow = wrote && base.workflow ? { ...base.workflow, authorFamily: wrote } : base.workflow;
  return convergenceSnapshot({ ...base, workflow, author: bound.author, reviewer, intents, reviewDispatches: reviewProofs(db, base.events, intents, reviewer),
    pool: opts.pool ? poolFacts(db, task, { ...opts.pool, now: opts.now ?? Date.now() }) : null, strayPoolOrders: strayPoolOrders(db, task.id).map((o) => o.orderId),
    fixDiff: fixDiffOf(task, base.events) }); // 第 3 轮起的修复 diff（review-converge-scope.ts）
}
