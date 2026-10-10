import { describe, expect, test } from "bun:test";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { convergeReview, NEAR_OP } from "../src/lib/review-converge.js";
import { NEAR_COUNTED_OP, nearCountedP1 } from "../src/lib/scheduler-review-near.js";
import { countsAsP1, currentReviewFacts, DOWNGRADE_OP, p1AnyStreak, p1FindingStreak, type ReviewFinding } from "../src/lib/scheduler-review.js";

// i28-CONV7: the same near-marker P1 two rounds running. The near records are the ones CONV6's convergeReview really produces
// for each mode, laid out as convergeFollowUp writes them ({ op, round, head, reportPath, ...near }).
const H1 = "a".repeat(40), H2 = "b".repeat(40);
const F1 = { findingId: "F1", family: "gate", severity: "P1", probe: "[验收线 1、2;PM 定 4] src/lib/a.ts:10" } as const;
const ev = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>): LedgerEvent =>
  ({ seq, ts: seq, actor: "scheduler", project: "p", target: "T1", kind, data, text: "", dedupKey: null });
const review = (seq: number, round: number, head: string, rows: readonly object[] = [F1]) => ev(seq, "review", { round, head, reviewer: "agent-rv",
  reviewerSessionId: "rv-session", reviewerFamily: "codex", path: "report.md", verdict: "changes", findings: rows, p0: 0, p1: rows.length, p2: 0 });
const ROUNDS = [[1, H1, 10], [2, H2, 30]] as const;

/** Both rounds reviewed; each round's near records as `mode` leaves them (off: none). */
function history(mode: RecoveryMode, rows: readonly object[] = [F1]): LedgerEvent[] {
  const events = [ev(1, "task", { op: "new" })];
  for (const [round, head, seq] of ROUNDS) {
    events.push(ev(seq, "deliver", { round, headSHA: head }), review(seq + 5, round, head, rows));
    const read = currentReviewFacts({ round, headSHA: head, specRev: 1 }, events);
    if (read.kind !== "facts") throw new Error(`fixture: ${JSON.stringify(read)}`);
    const d = convergeReview(events, read.facts, null, () => mode).downgrade;
    (d?.near ?? []).forEach((n, i) => events.push(ev(seq + 6 + i, "scheduler", { op: NEAR_OP, round, head, reportPath: "report.md", ...n })));
  }
  return events;
}
const streaks = (events: readonly LedgerEvent[]) => [p1FindingStreak(events, F1, 2), p1AnyStreak(events, 2)];
/** The round-2 record rewritten; round 1's stays counted. */
const withRound2 = (patch: Record<string, unknown>) => history("on").map((e) =>
  e.data.op === NEAR_OP && e.data.round === 2 ? { ...e, data: { ...e.data, ...patch } } : e);

describe("near-marker P1s counted under on join the P1 streak", () => {
  test("the op is CONV6's, and the fixture carries its real record", () => {
    expect(NEAR_COUNTED_OP).toBe(NEAR_OP);
    expect(history("on").filter((e) => e.data.op === NEAR_OP).map((e) => e.data)).toEqual(ROUNDS.map(([round, head]) =>
      ({ op: NEAR_OP, round, head, reportPath: "report.md", findingId: "F1", basis: "acceptance:1", mode: "on", counted: true })));
  });

  test("acceptance 1: two rounds with the counted record → streak 2", () => {
    const events = history("on");
    expect(streaks(events)).toEqual([2, 2]);
    expect([1, 2].map((round) => countsAsP1(events, round, F1))).toEqual([true, true]);
  });

  test("acceptance 1: the same rounds under observe / off read as before the change (not counted)", () => {
    for (const mode of ["observe", "off"] as const) {
      const events = history(mode);
      expect(events.filter((e) => e.data.op === NEAR_OP).map((e) => e.data.counted)).toEqual(mode === "observe" ? [false, false] : []);
      expect([mode, streaks(events), countsAsP1(events, 1, F1), countsAsP1(events, 2, F1)]).toEqual([mode, [0, 0], false, false]);
    }
  });

  test("the record decides, not the live switch: there is no switch to read here, and no record means no count", () => {
    expect(streaks(history("on").filter((e) => e.data.op !== NEAR_OP))).toEqual([0, 0]);
    expect(streaks(history("on").filter((e) => !(e.data.op === NEAR_OP && e.data.round === 1)))).toEqual([1, 1]);
  });

  test("acceptance 2: a record that does not fit this finding, round or head, or is not 「已按 P1 计」, does not count", () => {
    const bad: [string, Record<string, unknown>][] = [["findingId", { findingId: "F2" }], ["round", { round: 3 }], ["head", { head: H1 }],
      ["on but scoped out", { counted: false }], ["observe", { mode: "observe", counted: false }], ["mode", { mode: "observe" }],
      ["counted not boolean", { counted: "true" }], ["op", { op: "review_near" }]];
    for (const [name, patch] of bad) {
      const events = withRound2(patch);
      expect([name, streaks(events), countsAsP1(events, 2, F1), countsAsP1(events, 1, F1)]).toEqual([name, [0, 0], false, true]);
    }
    const notScheduler = history("on").map((e) => e.data.op === NEAR_OP && e.data.round === 2 ? { ...e, kind: "note" as const } : e);
    expect(streaks(notScheduler)).toEqual([0, 0]);
  });

  test("acceptance 2: a counted near P1 the planner demoted, or arbitration overturned, does not count", () => {
    const demoted = [...history("on"), ev(50, "scheduler", { op: DOWNGRADE_OP, round: 2, head: H2, findingIds: ["F1"] })];
    expect([streaks(demoted), countsAsP1(demoted, 2, F1), countsAsP1(demoted, 1, F1)]).toEqual([[0, 0], false, true]);
    const overturned = [...history("on"), ev(50, "scheduler", { op: "finding_dispute", findingId: "F1", family: "gate", specRev: 1 }),
      ev(51, "scheduler", { op: "arbitration_result", findingId: "F1", family: "gate", specRev: 1, disputeSeq: 50, verdict: "overturned", round: 2 })];
    expect([streaks(overturned), countsAsP1(overturned, 2, F1), countsAsP1(overturned, 1, F1)]).toEqual([[0, 0], false, true]);
    const upheld = overturned.map((e) => e.seq === 51 ? { ...e, data: { ...e.data, verdict: "upheld" } } : e);
    expect(streaks(upheld)).toEqual([2, 2]);
  });

  test("only a P1 row counts, and strict markers are untouched by near records", () => {
    const events = history("on");
    expect(countsAsP1(events, 2, { ...F1, severity: "P2" })).toBe(false);
    expect(nearCountedP1(events, 2, "F1")).toBe(true);
    expect(nearCountedP1(events, 3, "F1")).toBe(false);
    const strict: ReviewFinding = { findingId: "S1", family: "strict", severity: "P1", probe: "[验收线 2] src/lib/b.ts:1" };
    for (const mode of ["on", "observe", "off"] as const) {
      const mixed = history(mode, [F1, strict]);
      expect([mode, p1FindingStreak(mixed, strict, 2), p1FindingStreak(mixed, F1, 2), p1AnyStreak(mixed, 2)]).toEqual([mode, 2, mode === "on" ? 2 : 0, 2]);
    }
  });
});
