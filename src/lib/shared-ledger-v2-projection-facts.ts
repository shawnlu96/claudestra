/**
 * S2F9: center review / restate conclusions → the two local facts the home scheduler reads (kind=review, kind=stage spec→restate).
 * Written only from complete center evidence, never a guessed field: what the center has no value for lands as an explicit
 * center-projection value (reviewerSessionId null, findings unknown, p0–p2 derived from the verdict and marked so). Each fact
 * carries a `center-fact:` dedupKey over its evidence, so re-syncing the same center state writes nothing. The planner accepts
 * them only for a card routed central (scheduler-center-facts.ts).
 */
import type { V2Step, V2Task } from "./shared-ledger-contract-v2-tasks.js";
import { v2ObjectDigest } from "./shared-ledger-contract-v2-integrity.js";
import { stepRow, type ProjectionIdentity } from "./shared-ledger-v2-projection-rows.js";

export const CENTER_FACT_SOURCE = "center-projection";
export const CENTER_FACT_KEY = "center-fact:";

export interface CenterFact { taskId: string; kind: "review" | "stage"; dedupKey: string; text: string; data: Record<string, unknown> }

/** pass = no P0 / P1 (P2 unknown); changes / block carry no countable evidence, so all three stay null. */
const derivedCounts = (verdict: string) => verdict === "pass" ? { p0: 0, p1: 0, p2: null } : { p0: null, p1: null, p2: null };

/**
 * The center's review conclusion of the card's current round, or null unless every piece is present and agrees: verdict,
 * reviewedHead = the card head, a report artifact, and a done/delivered review step of this round by an independent reviewer
 * with the same verdict and a model family.
 */
function centerReviewFact(t: V2Task, steps: readonly V2Step[], id: ProjectionIdentity | undefined): CenterFact | null {
  const { verdict, reviewedHead, reportArtifactId } = t.review;
  if (!verdict || !reviewedHead || !reportArtifactId || t.head === null || reviewedHead !== t.head) return null;
  const s = steps.findLast(x => x.taskId === t.id && x.step === "review" && x.round === t.round);
  if (!s || s.state === "assigned" || s.verdict !== verdict || !s.verified.independentReviewer || !s.claims.family) return null;
  const evidence = { taskId: t.id, round: t.round, head: reviewedHead, verdict, reportArtifactId,
    reviewer: stepRow(s, id).executor, reviewerFamily: s.claims.family };
  const digest = v2ObjectDigest(evidence);
  return { taskId: t.id, kind: "review", dedupKey: `${CENTER_FACT_KEY}review:${t.id}:${digest}`, text: "",
    data: { source: CENTER_FACT_SOURCE, round: t.round, head: reviewedHead, verdict, reviewer: evidence.reviewer,
      reviewerSessionId: null, reviewerFamily: s.claims.family, path: `center-artifact:${reportArtifactId}`, reportArtifactId,
      findings: [], findingsKnown: false, ...derivedCounts(verdict), countsFrom: "verdict", evidenceDigest: digest } };
}

/** The center moved the card into restate: one spec→restate stage fact per specRev, its text the center coordinates only. */
function centerRestateFact(t: V2Task, serverSeq: number): CenterFact | null {
  if (t.stage !== "restate") return null;
  return { taskId: t.id, kind: "stage", dedupKey: `${CENTER_FACT_KEY}stage:${t.id}:${t.specRev}:restate`,
    text: `中心投影：中心已推到 restate（serverSeq ${serverSeq}，task rev ${t.rev}），复述正文在中心`,
    data: { source: CENTER_FACT_SOURCE, from: "spec", to: "restate", specRev: t.specRev, round: t.round, centerTaskRev: t.rev } };
}

export function centerFacts(tasks: readonly V2Task[], steps: readonly V2Step[], serverSeq: number, id: ProjectionIdentity | undefined): CenterFact[] {
  return tasks.flatMap(t => [centerReviewFact(t, steps, id), centerRestateFact(t, serverSeq)].filter((f): f is CenterFact => f !== null));
}
