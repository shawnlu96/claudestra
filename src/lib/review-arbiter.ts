/** Disputes retain finding identity and binding evidence; ordinary review verdicts cannot impersonate arbitration. */
import type { LedgerEvent } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import type { ReviewFacts, ReviewFinding } from "./scheduler-review.js";
import { normalizedFamily } from "./review-arbiter-identity.js";

export interface FindingDispute { findingId: string; reason: string }
export type ArbitrationVerdict = "upheld" | "overturned";

/** Omitted disputes is the old wire. Explicit malformed data is rejected instead of silently losing an executor's objection. */
export function parseDisputes(raw: unknown): FindingDispute[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) throw new LedgerError("invalid", "disputes 要是最多 100 条的数组");
  const ids = new Set<string>();
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new LedgerError("invalid", "dispute 要是对象");
    const d = item as Record<string, unknown>;
    if (Object.keys(d).some((k) => k !== "findingId" && k !== "reason") || typeof d.findingId !== "string" ||
      !/^[\w.-]{1,80}$/.test(d.findingId) || ids.has(d.findingId) || typeof d.reason !== "string" ||
      !d.reason.trim() || [...d.reason].length > 1000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(d.reason)) {
      throw new LedgerError("invalid", "dispute 要有唯一 findingId 和非空 reason（≤1000 字）");
    }
    ids.add(d.findingId);
    return { findingId: d.findingId, reason: d.reason };
  });
}

export function validateDisputes(disputes: readonly FindingDispute[], facts: ReviewFacts | null,
  events: readonly LedgerEvent[], specRev: number): void {
  for (const dispute of disputes) {
    const finding = facts?.findings.find((f) => f.findingId === dispute.findingId && f.severity === "P1");
    if (!finding) throw new LedgerError("invalid", `dispute ${dispute.findingId} 不是上一轮的 P1`);
    const used = events.some((e) => e.data.op === "finding_dispute" && e.data.specRev === specRev &&
      (e.data.findingId === finding.findingId || typeof e.data.family === "string" && normalizedFamily(e.data.family) === normalizedFamily(finding.family)));
    if (used) throw new LedgerError("conflict", `同一条 ${dispute.findingId} 不能二次 dispute`);
  }
}

export interface ArbitrationResult {
  findingId: string;
  family: string;
  verdict: ArbitrationVerdict;
  disputeSeq: number;
}

/** Only a scheduler-written result paired with its exact dispute may close a P1; arbitrary note events have no authority. */
export function arbitrationResults(events: readonly LedgerEvent[], specRev: number): ArbitrationResult[] {
  const rows: ArbitrationResult[] = [];
  for (const e of events) {
    const d = e.data;
    if (e.kind !== "scheduler" || e.actor !== "scheduler" || d.op !== "arbitration_result" || d.specRev !== specRev ||
      typeof d.findingId !== "string" || typeof d.family !== "string" || typeof d.disputeSeq !== "number" ||
      (d.verdict !== "upheld" && d.verdict !== "overturned")) continue;
    const dispute = events.find((x) => x.seq === d.disputeSeq && x.seq < e.seq && x.data.op === "finding_dispute" &&
      x.data.specRev === specRev && x.data.findingId === d.findingId && x.data.family === d.family);
    if (dispute) rows.push({ findingId: d.findingId, family: d.family, verdict: d.verdict, disputeSeq: d.disputeSeq });
  }
  return rows;
}

/** Closing only the arbitrated identity leaves unrelated P1s and all P0s intact. */
export function mergeArbitration(findings: readonly ReviewFinding[], results: readonly ArbitrationResult[]): ReviewFinding[] {
  return findings.filter((f) => f.severity !== "P1" || results.findLast((r) => r.findingId === f.findingId ||
    normalizedFamily(r.family) === normalizedFamily(f.family))?.verdict !== "overturned");
}

export function arbitratedFacts(events: readonly LedgerEvent[], specRev: number, facts: ReviewFacts): ReviewFacts {
  const findings = mergeArbitration(facts.findings, arbitrationResults(events, specRev));
  return { ...facts, findings, verdict: facts.verdict === "changes" && !findings.length ? "pass" : facts.verdict };
}

export function arbitrationKeepsP1(events: readonly LedgerEvent[], finding: ReviewFinding, round: number): boolean {
  const configuration = events.findLast((e) => e.data.op === "workflow" && typeof e.data.specRev === "number");
  const eligible = events.filter((e) => e.kind === "scheduler" && e.actor === "scheduler" && e.data.op === "arbitration_result" &&
    typeof e.data.specRev === "number" && (!configuration || e.data.specRev === configuration.data.specRev) &&
    (typeof e.data.round !== "number" || e.data.round <= round));
  const results = eligible.flatMap((e) => arbitrationResults(events, e.data.specRev as number)
    .filter((r) => r.disputeSeq === e.data.disputeSeq && r.verdict === e.data.verdict));
  return mergeArbitration([finding], results).length > 0;
}
