/**
 * S2F9 · when the planner takes a center-projected fact (shared-ledger-v2-projection-facts.ts) in place of home evidence. Both
 * must hold: the card routes central (S2D's schedulerV2Route), and the event is the projection writer's own center fact (its
 * actor, source marker and center-fact: key; the write gate admits no other writer of that shape). Anything else reads exactly as
 * before. A recognized review stands in for the home dispatch receipt and reviewer session: the center already checked those.
 */
import type { LedgerEvent, LedgerTask, ReviewVerdict } from "./ledger-stages.js";
import type { AuthorFamily } from "./ledger-scheduler.js";
import type { ReviewFacts } from "./scheduler-review.js";
import { CENTER_FACT_KEY, CENTER_FACT_SOURCE } from "./shared-ledger-v2-projection-facts.js";
import { PROJECTION_ACTOR } from "./shared-ledger-v2-write-gate.js";

/** The explicit stand-in for a home reviewer session a center review never has. */
const CENTER_REVIEWER_SESSION = "center-projection";

/**
 * Injected (importing scheduler-v2-pass here would close a dependency cycle through the planner): shared-ledger-v2-projection.ts
 * registers S2D's schedulerV2Route when loaded. Unset = no card is central, which is also what the route says without that wiring.
 */
let routed: (taskId: string) => boolean = () => false;
export function configureCenterFactRoute(fn: ((taskId: string) => boolean) | null): void { routed = fn ?? (() => false); }

type FactTask = Pick<LedgerTask, "round" | "headSHA" | "specRev"> & { id?: string };
const marked = (e: LedgerEvent): boolean => e.actor === PROJECTION_ACTOR && e.data.source === CENTER_FACT_SOURCE
  && !!e.dedupKey?.startsWith(CENTER_FACT_KEY);

/** A review fact stays current only while the card's latest projection event still states its evidence (absent / gone = revoked). */
const backed = (e: LedgerEvent, events: readonly LedgerEvent[]): boolean => events.findLast((x) => x.actor === PROJECTION_ACTOR
  && x.kind === "task" && x.data.op === "center-projection")?.data.centerReviewDigest === e.data.evidenceDigest && !!e.data.evidenceDigest;

/**
 * A center fact this card may act on: marked, about this round / head and still backed by the latest snapshot (review) or this
 * specRev (restate), and the card routes central.
 */
function isCenterProjected(e: LedgerEvent, task: FactTask, events: readonly LedgerEvent[]): boolean {
  if (!marked(e) || !task.id) return false;
  const current = e.kind === "review" ? e.data.round === task.round && e.data.head === task.headSHA && backed(e, events)
    : e.kind === "stage" && e.data.from === "spec" && e.data.to === "restate" && e.data.specRev === task.specRev;
  if (!current) return false;
  try { return routed(task.id); } catch { return false; } // an unreadable route never grants center authority
}

/**
 * The review currentReviewFacts reads for this round: when its latest review is a center fact, the round's center fact the latest
 * snapshot backs (a restored center may back an earlier one again after another review landed); otherwise that latest review as is.
 */
export function centerReviewOf(latest: LedgerEvent, task: FactTask, events: readonly LedgerEvent[]): LedgerEvent {
  if (!marked(latest)) return latest;
  return events.findLast((e) => e.kind === "review" && e.data.round === task.round && marked(e) && isCenterProjected(e, task, events)) ?? latest;
}

/** Review facts of a recognized center review; null = not one (the caller then reads the event exactly as before). */
export function centerReviewFacts(review: LedgerEvent, task: FactTask, events: readonly LedgerEvent[]): ReviewFacts | null {
  if (review.kind !== "review" || !isCenterProjected(review, task, events)) return null;
  const d = review.data, verdict = d.verdict, family = d.reviewerFamily;
  if (!["pass", "changes", "block"].includes(String(verdict)) || !["claude", "codex"].includes(String(family))
    || typeof d.reviewer !== "string" || !d.reviewer || typeof d.path !== "string") return null;
  return { eventSeq: review.seq, round: task.round, head: d.head as string, verdict: verdict as ReviewVerdict, reviewer: d.reviewer,
    reviewerSessionId: CENTER_REVIEWER_SESSION, reviewerFamily: family as AuthorFamily, reportPath: d.path, findings: [] };
}

/** reviewStep / mergeReviewGate: these facts came from a recognized center review, so no home receipt or session is asked for. */
export function centerReviewed(s: { task: FactTask; events: readonly LedgerEvent[] }, facts: Pick<ReviewFacts, "eventSeq">): boolean {
  const e = s.events.find((x) => x.seq === facts.eventSeq);
  return !!e && e.kind === "review" && isCenterProjected(e, s.task, s.events);
}

/** restateGate: a projected spec→restate fact only counts for a central card; any other record reads as before. */
export const restateRecordOk = (e: LedgerEvent, task: FactTask): boolean => !marked(e) || isCenterProjected(e, task, []);
