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
import { taskWorkerRefs } from "./scheduler-sessions.js";
import { observeSnapshot, type SnapshotOpts } from "./scheduler-snapshot.js";

type ReviewProof = PlannerSnapshot["reviewDispatches"][number];

/** Round = the round the card entered review with before this intent was planned; no receipt or no round = no proof. */
function reviewProofs(db: Database, events: readonly LedgerEvent[], intents: readonly SchedulerIntent[], reviewer: WorkerRef | null): ReviewProof[] {
  if (!reviewer) return [];
  const out: ReviewProof[] = [];
  for (const i of intents) {
    if (i.action !== "review" || i.recipient !== reviewer.agent || !i.head || (i.status !== "submitted" && i.status !== "done")) continue;
    const ack = getEventByDedup(db, `scheduler:${i.id}:submitted`);
    const entered = events.findLast((e) => e.kind === "stage" && e.data.to === "review" && e.seq < i.eventSeq);
    if (!ack || typeof entered?.data.round !== "number") continue;
    out.push({ intentId: i.id, round: entered.data.round, head: i.head, reviewer: reviewer.agent, reviewerSessionId: reviewer.sessionId, ackSeq: ack.seq });
  }
  return out;
}

export function autoSnapshot(db: Database, task: LedgerTask, opts: SnapshotOpts, exclude?: string): PlannerSnapshot {
  const base = observeSnapshot(db, task, opts);
  const bound = taskWorkerRefs(db, task.id);
  const intents = base.intents.filter((i) => !i.id.startsWith("pm-dispatch:") && i.id !== exclude);
  return { ...base, author: bound.author, reviewer: bound.reviewer, intents, reviewDispatches: reviewProofs(db, base.events, intents, bound.reviewer) };
}
