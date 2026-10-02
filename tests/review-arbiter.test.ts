import { expect, test } from "bun:test";
import { arbitrationResults, mergeArbitration, parseDisputes, validateDisputes } from "../src/lib/review-arbiter.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import type { ReviewFinding } from "../src/lib/scheduler-review.js";

const finding: ReviewFinding = { findingId: "race", family: "locking", severity: "P1", probe: "test" };
const event = (seq: number, data: Record<string, unknown>, actor = "scheduler"): LedgerEvent =>
  ({ seq, ts: seq, actor, project: "p", target: "T", kind: "scheduler", data, text: "", dedupKey: null });
const dispute = event(1, { op: "finding_dispute", findingId: "race", family: "locking", specRev: 1 });
const result = (verdict: string, actor = "scheduler") => event(2, { op: "arbitration_result", findingId: "race", family: "locking", specRev: 1,
  disputeSeq: 1, verdict }, actor);

test("legacy omission and Unicode length are supported; malformed or duplicate objections fail", () => {
  expect(parseDisputes(undefined)).toEqual([]);
  expect(parseDisputes([{ findingId: "race", reason: "😀".repeat(1000) }])).toHaveLength(1);
  for (const raw of [null, {}, [{ findingId: "race", reason: " " }], [{ findingId: "race", reason: "a".repeat(1001) }],
    [{ findingId: "race", reason: "ok", surprise: true }], [{ findingId: "race", reason: "ok" }, { findingId: "race", reason: "again" }]]) {
    expect(() => parseDisputes(raw)).toThrow();
  }
});

test("unpaired, foreign actor, wrong revision and wrong identity cannot close findings", () => {
  expect(arbitrationResults([result("overturned")], 1)).toEqual([]);
  expect(arbitrationResults([dispute, result("overturned", "worker")], 1)).toEqual([]);
  expect(arbitrationResults([dispute, result("overturned")], 2)).toEqual([]);
  expect(arbitrationResults([dispute, { ...result("overturned"), data: { ...result("overturned").data, family: "other" } }], 1)).toEqual([]);
});

test("overturned closes only that P1; upheld keeps it, and P0 stays blocking", () => {
  const rows = [finding, { ...finding, findingId: "other", family: "different" }, { ...finding, severity: "P0" as const }];
  expect(mergeArbitration(rows, arbitrationResults([dispute, result("overturned")], 1))).toEqual(rows.slice(1));
  expect(mergeArbitration(rows, arbitrationResults([dispute, result("upheld")], 1))).toEqual(rows);
  expect(() => validateDisputes([{ findingId: "race", reason: "wrong" }], null, [], 1)).toThrow("不是上一轮");
});

test("renamed findings retain arbitration identity and cannot be disputed twice in the same spec", () => {
  const renamed = { ...finding, findingId: "renamed", family: "Lock_ing" };
  const facts = { findings: [renamed], round: 3, head: "a".repeat(40), eventSeq: 3, verdict: "changes" as const,
    reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex" as const, reportPath: "/r.md" };
  expect(() => validateDisputes([{ findingId: "renamed", reason: "again" }], facts, [dispute], 1)).toThrow("不能二次");
  expect(() => validateDisputes([{ findingId: "renamed", reason: "new spec" }], facts, [dispute], 2)).not.toThrow();
  expect(mergeArbitration([renamed], arbitrationResults([dispute, result("overturned")], 1))).toEqual([]);
});
