/**
 * Closure history for a review-evidence bundle (format: ledger/docs/review-evidence-v1). Pure; the producer (review-evidence.ts)
 * and the local self-check (review-evidence-verify.ts) both read it, so the rule lives once.
 * A finding is followed by findingId through later completed rounds that carry structured findings: our review orders hand
 * the previous structured round's findings back for re-check (review-order.ts prevReview), so the first later round that does
 * not re-raise it is the review confirming closure. A chain still raised in the last structured round is open (P0/P1) or
 * retained (P2). Closure is never inferred from a round without structured findings. tests/review-evidence.test.ts.
 */
import type { ReviewFinding } from "./scheduler-review.js";

export interface EvidenceRound {
  reviewId: string;
  round: number;
  head: string;
  /** null = the ledger holds no structured findings for this round (legacy / CLI record): it can neither raise nor close */
  findings: readonly ReviewFinding[] | null;
  findingsArtifact: string | null;
  reportArtifact: string | null;
  /** Finding ids the planner treated as P2 that round (review_downgrade event), with that event's seq */
  downgraded?: { seq: number; ids: readonly string[] } | null;
}

export interface Closure {
  reviewId: string;
  findingId: string;
  disposition: "closed" | "retained";
  confirmingReviewId: string;
  /** Head the confirming review saw; null when it is the same head the finding was raised on (no code change) */
  fixCommit: string | null;
  evidenceArtifacts: string[];
  explanation: string;
  /** retained only: the ledger record that tracks it further (a planner downgrade), or null when none exists */
  followup: { ledgerEventSeq: number } | null;
}

export interface OpenCounts { p0: number; p1: number; p2: number }
export interface OpenFinding { reviewId: string; findingId: string; severity: ReviewFinding["severity"] }

const ids = (...xs: (string | null)[]): string[] => xs.filter((x): x is string => !!x);

/** Completed rounds in chronological order → closures for every finding that has one. */
export function computeClosures(rounds: readonly EvidenceRound[]): Closure[] {
  const structured = rounds.filter((r) => r.findings);
  const out: Closure[] = [];
  structured.forEach((r, i) => {
    for (const f of r.findings!) {
      let last = r, at = i + 1;
      while (at < structured.length && structured[at].findings!.some((x) => x.findingId === f.findingId)) last = structured[at++];
      const by = structured[at];
      if (by) {
        out.push({ reviewId: r.reviewId, findingId: f.findingId, disposition: "closed", confirmingReviewId: by.reviewId,
          fixCommit: by.head === last.head ? null : by.head, evidenceArtifacts: ids(r.findingsArtifact, by.findingsArtifact, by.reportArtifact),
          explanation: `${by.reviewId} was handed the previous round's findings for re-check and did not re-raise ${f.findingId}` +
            (by.head === last.head ? " (same head: no code change)" : ` at head ${by.head}`), followup: null });
        continue;
      }
      const latest = last.findings!.find((x) => x.findingId === f.findingId)!;
      if (latest.severity !== "P2") continue;
      const seq = last.downgraded?.ids.includes(f.findingId) ? last.downgraded.seq : null;
      out.push({ reviewId: r.reviewId, findingId: f.findingId, disposition: "retained", confirmingReviewId: last.reviewId, fixCommit: null,
        evidenceArtifacts: ids(r.findingsArtifact, last.findingsArtifact, last.reportArtifact),
        explanation: `still raised as P2 by ${last.reviewId}, the last review with structured findings`, followup: seq === null ? null : { ledgerEventSeq: seq } });
    }
  });
  return out;
}

/**
 * Findings with no closure entry, one per findingId (its latest appearance decides the severity). This is the receiver-side
 * reading: it trusts nothing about chains, only that an entry without a closure is unresolved.
 */
export function openFindings(rounds: readonly EvidenceRound[], closures: readonly Pick<Closure, "reviewId" | "findingId">[]): OpenFinding[] {
  const closed = new Set(closures.map((c) => `${c.reviewId}\u0000${c.findingId}`));
  const latest = new Map<string, OpenFinding>();
  for (const r of rounds) {
    for (const f of r.findings ?? []) {
      if (!closed.has(`${r.reviewId}\u0000${f.findingId}`)) latest.set(f.findingId, { reviewId: r.reviewId, findingId: f.findingId, severity: f.severity });
    }
  }
  return [...latest.values()];
}

export function countOpen(open: readonly OpenFinding[], retained: readonly Pick<Closure, "findingId" | "confirmingReviewId">[]): OpenCounts {
  const p2 = new Set([...open.filter((f) => f.severity === "P2").map((f) => f.findingId), ...retained.map((c) => c.findingId)]);
  return { p0: open.filter((f) => f.severity === "P0").length, p1: open.filter((f) => f.severity === "P1").length, p2: p2.size };
}
