/** Structured review evidence used by the deterministic planner; free-form report text cannot decide a branch. */
import type { LedgerEvent, LedgerTask, ReviewVerdict } from "./ledger-stages.js";
import type { AuthorFamily } from "./ledger-scheduler.js";

type FindingSeverity = "P0" | "P1" | "P2";
export interface ReviewFinding { findingId: string; family: string; severity: FindingSeverity; probe: string }
export interface ReviewFacts {
  eventSeq: number;
  round: number;
  head: string;
  verdict: ReviewVerdict;
  reviewer: string;
  reviewerSessionId: string;
  reviewerFamily: AuthorFamily;
  reportPath: string;
  findings: ReviewFinding[];
}
export type ReviewRead = { kind: "none" } | { kind: "invalid"; reason: string } | { kind: "facts"; facts: ReviewFacts };

const count = (v: unknown): number | null => Number.isInteger(v) && (v as number) >= 0 ? v as number : null;
const str = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
const familyName = (v: unknown): v is string => typeof v === "string" && /^[\w.-]{1,64}$/.test(v);

function findingsOf(value: unknown): ReviewFinding[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const rows: ReviewFinding[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const findingId = str(r.findingId);
    if (!findingId || !/^[\w.-]{1,80}$/.test(findingId) || ids.has(findingId) || !familyName(r.family) ||
      !["P0", "P1", "P2"].includes(String(r.severity)) || !str(r.probe) || (r.probe as string).length > 4000) return null;
    ids.add(findingId);
    rows.push({ findingId, family: r.family, severity: r.severity as FindingSeverity, probe: r.probe as string });
  }
  return rows;
}

/** Only this round and head may drive the current review branch; a stale report is a hard stop. */
export function currentReviewFacts(task: Pick<LedgerTask, "round" | "headSHA">, events: readonly LedgerEvent[]): ReviewRead {
  const review = events.findLast((e) => e.kind === "review" && e.data.round === task.round);
  if (!review) return { kind: "none" };
  const d = review.data;
  const head = str(d.head), verdict = str(d.verdict), reviewer = str(d.reviewer);
  const reviewerSessionId = str(d.reviewerSessionId), reviewerFamily = str(d.reviewerFamily), reportPath = str(d.path);
  const findings = findingsOf(d.findings);
  if (!head || head !== task.headSHA || !/^[a-f0-9]{40}$/i.test(head)) return { kind: "invalid", reason: "审查结论的完整 head 与任务不一致" };
  if (!verdict || !["pass", "changes", "block"].includes(verdict) || !reviewer || !reviewerSessionId ||
    !reviewerFamily || !["claude", "codex"].includes(reviewerFamily) || !reportPath || !findings) {
    return { kind: "invalid", reason: "审查结论缺结构化字段或报告路径" };
  }
  const counts = ["P0", "P1", "P2"].map((p) => findings.filter((f) => f.severity === p).length);
  if ([d.p0, d.p1, d.p2].some((v, i) => count(v) !== counts[i])) return { kind: "invalid", reason: "P0/P1/P2 计数与逐项结论不一致" };
  return {
    kind: "facts",
    facts: { eventSeq: review.seq, round: task.round, head, verdict: verdict as ReviewVerdict, reviewer,
      reviewerSessionId, reviewerFamily: reviewerFamily as AuthorFamily, reportPath, findings },
  };
}

/** Consecutive review rounds containing the same P1 family; another family or a clean round resets it. */
export function p1FamilyStreak(events: readonly LedgerEvent[], family: string, currentRound: number): number | null {
  const byRound = new Map<number, LedgerEvent>();
  for (const e of events) if (e.kind === "review" && typeof e.data.round === "number" && e.data.round <= currentRound) byRound.set(e.data.round, e);
  let streak = 0;
  for (let round = currentRound; round > 0; round--) {
    const e = byRound.get(round);
    const rows = findingsOf(e?.data.findings);
    if (!e || !rows) return null;
    const head = str(e.data.head);
    const delivered = events.filter((x) => x.kind === "deliver" && x.seq < e.seq).sort((a, b) => a.seq - b.seq).at(-1);
    if (!head || !/^[a-f0-9]{40}$/i.test(head) || delivered?.data.headSHA !== head ||
      ["P0", "P1", "P2"].some((p) => count(e.data[p.toLowerCase()]) !== rows.filter((f) => f.severity === p).length)) return null;
    if (!rows?.some((f) => f.severity === "P1" && f.family === family)) break;
    streak++;
  }
  return streak;
}
