/**
 * Ledger → PlannerSnapshot. For an observe card the scheduler owns no intents or sessions, so its own facts are
 * replaced by what PM actually did: the step executors are the sessions, PM's `ledger dispatch` events are the review
 * dispatches. The plan then answers "given reality so far, what would the engine do next" — exactly what the diff needs.
 */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews } from "./ledger-deps.js";
import { getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { currentReview, stepAtStage, stepsOf } from "./ledger-steps.js";
import { getMeta, listDeps, listEvents, listTasks } from "./ledger-store.js";
import type { RegistryAgent } from "./registry.js";
import type { PlannerSnapshot, WorkerRef } from "./scheduler-plan.js";
import { taskWorkerRefs } from "./scheduler-sessions.js";

export interface SnapshotOpts {
  registry: readonly RegistryAgent[];
  maxWorkers: number;
}

const familyOf = (a: RegistryAgent): AuthorFamily | null =>
  a.runtime === "codex" ? "codex" : a.runtime === undefined || a.runtime === "claude-code" ? "claude" : null;

/** Local registry agents only; a peer or human executor has no session the engine could address. */
function localRef(opts: SnapshotOpts, taskId: string, agent: string | null | undefined, sessionId?: unknown): WorkerRef | null {
  const reg = agent ? opts.registry.find((a) => a.name === agent) : undefined;
  const family = reg && familyOf(reg);
  if (!reg || !family) return null;
  const sid = typeof sessionId === "string" && sessionId ? sessionId : reg.sessionId || `registry:${reg.name}`;
  return { agent: reg.name, sessionId: sid, taskId, family, source: "local" };
}

const firstReview = (events: readonly LedgerEvent[]) => events.find((e) => e.kind === "review");

function reviewerOfRound(events: readonly LedgerEvent[], round: number, after: number): string | null {
  const r = events.find((e) => e.kind === "review" && e.data.round === round && e.seq > after);
  return typeof r?.data.reviewer === "string" ? r.data.reviewer : null;
}

/**
 * PM's review dispatches become shadow review intents with their acknowledgement right after them (seq + 0.5 keeps
 * the planner's strict "dispatch < ack < result" ordering without inventing a ledger event).
 */
function shadowReviews(task: LedgerTask, events: readonly LedgerEvent[], fallbackReviewer: WorkerRef | null) {
  const intents: SchedulerIntent[] = [];
  const proofs: PlannerSnapshot["reviewDispatches"][number][] = [];
  for (const e of events) {
    if (e.kind !== "dispatch" || typeof e.data.round !== "number") continue;
    const reviewer = reviewerOfRound(events, e.data.round, e.seq) ?? fallbackReviewer?.agent ?? null;
    const head = typeof e.data.head === "string" ? e.data.head : null;
    const id = `pm-dispatch:${e.seq}`;
    intents.push({ id, taskId: task.id, project: task.project, node: "adversarial_review", action: "review", recipient: reviewer,
      causalSeq: e.seq, eventSeq: e.seq, taskRev: task.rev, specRev: task.specRev, head, templateVersion: 2, status: "done",
      attempts: 1, receipt: "PM 手动派审", reason: "PM 手动派审", createdAt: e.ts, updatedAt: e.ts });
    const review = events.find((r) => r.kind === "review" && r.data.round === e.data.round && r.seq > e.seq);
    if (reviewer && head) {
      proofs.push({ intentId: id, round: e.data.round, head, reviewer,
        reviewerSessionId: typeof review?.data.reviewerSessionId === "string" ? review.data.reviewerSessionId : fallbackReviewer?.sessionId ?? "",
        ackSeq: e.seq + 0.5 });
    }
  }
  return { intents, proofs };
}

function slotFacts(db: Database, project: string, maxWorkers: number) {
  const held = db.query("SELECT resource, taskId FROM scheduler_resources WHERE project = ?").all(project) as { resource: string; taskId: string }[];
  const slots = held.filter((h) => h.resource.startsWith("slot:"));
  const used = new Set(slots.map((h) => h.resource));
  let free: string | null = null;
  for (let i = 0; i < maxWorkers && !free; i++) if (!used.has(`slot:${project}:${i}`)) free = `slot:${project}:${i}`;
  return { held, workerCount: new Set(slots.map((h) => h.taskId)).size, freeWorkerSlot: free };
}

export function observeSnapshot(db: Database, task: LedgerTask, opts: SnapshotOpts): PlannerSnapshot {
  const workflow = getWorkflow(db, task.id);
  const events = listEvents(db, { project: task.project, target: task.id });
  const steps = stepsOf(db, task);
  const bound = taskWorkerRefs(db, task.id);
  const writer = stepAtStage(steps, { stage: task.stage === "fix" ? "fix" : "build", stageBefore: null });
  const author = bound.author ?? (writer?.executorKind === "agent" ? localRef(opts, task.id, writer.executor) : null);
  const first = firstReview(events);
  const reviewStep = currentReview(steps);
  const reviewer = bound.reviewer ?? (typeof first?.data.reviewer === "string"
    ? localRef(opts, task.id, first.data.reviewer, first.data.reviewerSessionId)
    : reviewStep?.executorKind === "agent" ? localRef(opts, task.id, reviewStep.executor) : null);
  const shadow = shadowReviews(task, events, reviewer);
  const real = db.query("SELECT * FROM scheduler_intents WHERE taskId = ? ORDER BY eventSeq").all(task.id) as SchedulerIntent[];
  const slots = slotFacts(db, task.project, opts.maxWorkers);
  const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];
  const digest = typeof task.extra.screenshotsDigest === "string" ? task.extra.screenshotsDigest : null;
  return {
    task, workflow, events, intents: [...real, ...shadow.intents].sort((a, b) => a.eventSeq - b.eventSeq),
    blockedBy: blockedBy(task.id, depViews(listDeps(db, task.project), listTasks(db, task.project))).map((d) => d.from),
    queueFrozen: getMeta(db, task.project).queueFrozen.frozen, fileGlobs: globs,
    heldResources: slots.held, workerCount: slots.workerCount, maxWorkers: opts.maxWorkers, freeWorkerSlot: slots.freeWorkerSlot,
    author, reviewer, reviewDispatches: shadow.proofs, uiGate: { state: "none" }, screenshotsDigest: digest,
  };
}
