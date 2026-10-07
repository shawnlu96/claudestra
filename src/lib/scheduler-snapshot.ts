import { poolSnapshotSlots } from "./scheduler-agent-pool-snapshot.js";
/**
 * Ledger → PlannerSnapshot. For an observe card the scheduler owns no intents or sessions, so its own facts are
 * replaced by what PM actually recorded before the fact: the step executors (with the registry's real session) are the
 * sessions, PM's adversarial `ledger dispatch` events are the review dispatches. A verdict never vouches for itself:
 * who reviewed and which session did it are compared against these earlier facts, not read from the verdict.
 */
import type { Database } from "bun:sqlite";
import { blockedBy, depViews } from "./ledger-deps.js";
import { getWorkflow, type AuthorFamily, type SchedulerIntent } from "./ledger-scheduler.js";
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { currentReview, stepAtStage, stepsOf } from "./ledger-steps.js";
import { getMeta, listDeps, listEvents, listTasks } from "./ledger-store.js";
import type { BorrowEntry } from "./lend-config.js";
import type { RegistryAgent } from "./registry.js";
import type { RemotePolicy } from "./scheduler-config.js";
import type { PlannerSnapshot, WorkerRef } from "./scheduler-plan.js";
import { taskWorkerRefs } from "./scheduler-sessions.js";
import { projectPmUiGate } from "./ledger-ui-approve-verdict.js";
import { ownerVisualOf, projectUiGate } from "./scheduler-ui-gate.js";
import { writeSlotFacts } from "./scheduler-slot-hold-facts.js";
import { newLocalWriteRoom, returnedFix } from "./scheduler-slot-hold.js";
import { handoffGateFacts } from "./handoff-gate.js";

export interface SnapshotOpts {
  registry: readonly RegistryAgent[];
  maxWorkers: number;
  /** Clock for ask expiry; the observe write passes its own ctx.now so a replayed tick sees the same gate. */
  now?: number;
  /** Shared-pool policy and the effective borrow list (auto cards only; absent = never pool). */
  pool?: { remote: RemotePolicy; borrow: readonly BorrowEntry[] };
}

const familyOf = (a: RegistryAgent): AuthorFamily | null =>
  a.runtime === "codex" ? "codex" : a.runtime === undefined || a.runtime === "claude-code" ? "claude" : null;

/** Local registry agents with a real current session only; no session id means no ref, never a made-up one. */
function localRef(opts: SnapshotOpts, taskId: string, agent: string | null | undefined): WorkerRef | null {
  const reg = agent ? opts.registry.find((a) => a.name === agent) : undefined;
  const family = reg && familyOf(reg);
  if (!reg || !family || !reg.sessionId) return null;
  return { agent: reg.name, sessionId: reg.sessionId, taskId, family, source: "local" };
}

/** The review executor PM assigned before `seq` (a step event), never the reviewer a later verdict names. */
function assignedReviewer(events: readonly LedgerEvent[], seq: number): string | null {
  const a = events.findLast((e) => e.kind === "step" && e.data.op === "assign" && e.data.step === "review" && e.seq < seq);
  return a?.data.executorKind === "agent" && typeof a.data.executor === "string" ? a.data.executor : null;
}

/**
 * PM's adversarial dispatches become shadow review intents. PM's dispatch event is the real delivery record, so it is
 * the ack; the shadow intent sits half a step before it. Recipient and session come from the assignment in force at
 * dispatch time; when there was none the intent has no recipient and no proof, so a later verdict stays unproven.
 * A regular (non-adversarial) dispatch is not what the engine would send and yields nothing.
 */
function shadowReviews(task: LedgerTask, events: readonly LedgerEvent[], bound: WorkerRef | null, opts: SnapshotOpts) {
  const intents: SchedulerIntent[] = [];
  const proofs: PlannerSnapshot["reviewDispatches"][number][] = [];
  for (const e of events) {
    if (e.kind !== "dispatch" || typeof e.data.round !== "number" || e.data.reviewer !== "adversarial") continue;
    const ref = bound ?? localRef(opts, task.id, assignedReviewer(events, e.seq));
    const head = typeof e.data.head === "string" ? e.data.head : null;
    const id = `pm-dispatch:${e.seq}`;
    intents.push({ id, taskId: task.id, project: task.project, node: "adversarial_review", action: "review", recipient: ref?.agent ?? null,
      causalSeq: e.seq - 0.5, eventSeq: e.seq - 0.5, taskRev: task.rev, specRev: task.specRev, head, templateVersion: 2, status: "done",
      attempts: 1, receipt: "PM 手动派审", reason: "PM 手动派审", createdAt: e.ts, updatedAt: e.ts });
    if (ref && head) proofs.push({ intentId: id, round: e.data.round, head, reviewer: ref.agent, reviewerSessionId: ref.sessionId, ackSeq: e.seq });
  }
  return { intents, proofs };
}

function slotFacts(db: Database, task: LedgerTask, events: readonly LedgerEvent[], maxWorkers: number) {
  const { held, slots, workerCount, waitingFix } = writeSlotFacts(db, task.project);
  const used = new Set(slots.map((h) => h.resource));
  let free: string | null = null;
  if (returnedFix(task, events) || newLocalWriteRoom(workerCount, maxWorkers, waitingFix)) {
    for (let i = 0; i < maxWorkers && !free; i++) if (!used.has(`slot:${task.project}:${i}`)) free = `slot:${task.project}:${i}`;
  }
  return { held, workerCount, freeWorkerSlot: free };
}

/** Current state only: registry sessions, steps, bindings, asks and resources have no history, so no past replay. */
export function observeSnapshot(db: Database, task: LedgerTask, opts: SnapshotOpts): PlannerSnapshot {
  const workflow = getWorkflow(db, task.id);
  const events = listEvents(db, { project: task.project, target: task.id });
  const steps = stepsOf(db, task);
  const bound = taskWorkerRefs(db, task.id);
  const writer = stepAtStage(steps, { stage: task.stage === "fix" ? "fix" : "build", stageBefore: null });
  const author = bound.author ?? (writer?.executorKind === "agent" ? localRef(opts, task.id, writer.executor) : null);
  const reviewStep = currentReview(steps);
  const reviewer = bound.reviewer ?? (reviewStep?.executorKind === "agent" ? localRef(opts, task.id, reviewStep.executor) : null);
  const shadow = shadowReviews(task, events, bound.reviewer, opts);
  const real = db.query("SELECT * FROM scheduler_intents WHERE taskId = ? ORDER BY eventSeq").all(task.id) as SchedulerIntent[];
  const slots = opts.pool?.remote.agents ? poolSnapshotSlots(db, task, opts.pool.remote.agents) : slotFacts(db, task, events, opts.maxWorkers);
  const globs = Array.isArray(task.extra.fileGlobs) ? task.extra.fileGlobs.filter((g): g is string => typeof g === "string") : [];
  const digest = typeof task.extra.screenshotsDigest === "string" ? task.extra.screenshotsDigest : null;
  return {
    task, workflow, events, intents: [...real, ...shadow.intents].sort((a, b) => a.eventSeq - b.eventSeq),
    blockedBy: blockedBy(task.id, depViews(listDeps(db, task.project), listTasks(db, task.project))).map((d) => d.from),
    queueFrozen: getMeta(db, task.project).queueFrozen.frozen, fileGlobs: globs,
    heldResources: slots.held, workerCount: slots.workerCount, maxWorkers: opts.maxWorkers, freeWorkerSlot: slots.freeWorkerSlot,
    author, reviewer, reviewDispatches: shadow.proofs, uiGate: projectUiGate(db, task, opts.now ?? Date.now()), screenshotsDigest: digest,
    pmUiGate: projectPmUiGate(db, task, events), ownerVisual: ownerVisualOf(db, task, events),
    handoffGate: task.stage === "merge" ? handoffGateFacts(db, task) : null,
  };
}
