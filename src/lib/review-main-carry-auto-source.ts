/**
 * MCRY4: which head the carried PASS's source gate is re-proved at. After one engine carry the task sits on the carried head while
 * the pool order / reviewer session / ticket stay bound to the head the review was written for, so re-running the gate on the
 * current head finds no pooled reviewer and refuses the next pure-main carry. The current head's trusted chain is read first, by the
 * same rule mergeReviewProof reads (currentReviewFacts: this round's latest review, only engine carries paired with their merge_phase
 * and formal PM carries by an actor it accepts, same round / specRev, no delivery after the review); only when it holds is the task
 * projected onto that review's own fixed head, where the unchanged formal gate re-checks source, session, family, order, gen, ticket,
 * request and revocation. A broken chain projects nothing (the gate refuses as before); never "any older PASS".
 * tests/review-main-carry-auto-source*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { actorMayConfigure } from "./ledger-scheduler-settle.js";
import type { LedgerTask } from "./ledger-stages.js";
import { listEvents } from "./ledger-store.js";
import { currentReviewFacts } from "./scheduler-review.js";

/** The task as the source gate must read it: on the head its current round's PASS was written for, reached by a trusted chain. */
export function carrySourceTask(db: Database, task: LedgerTask): LedgerTask {
  const read = currentReviewFacts(task, listEvents(db, { project: task.project, target: task.id }), (a) => actorMayConfigure(db, a, task.project));
  return read.kind === "facts" && read.facts.head !== task.headSHA ? { ...task, headSHA: read.facts.head } : task;
}
