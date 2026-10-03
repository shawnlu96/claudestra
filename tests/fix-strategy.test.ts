import { expect, test } from "bun:test";
import { fixHistory, fixStrategy } from "../src/lib/fix-strategy.js";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import type { ReviewFacts, ReviewFinding } from "../src/lib/scheduler-review.js";

const finding: ReviewFinding = { findingId: "race", family: "locking", severity: "P1", probe: "bun test tests/race.test.ts", basis: "acceptance:1" };
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>): LedgerEvent =>
  ({ seq, ts: seq, actor: "scheduler", project: "p", target: "T", kind, data, text: "", dedupKey: null });
function history(rounds: number): LedgerEvent[] {
  return Array.from({ length: rounds }, (_, n) => [event(n * 2 + 1, "deliver", { headSHA: String(n + 1).repeat(40) }),
    event(n * 2 + 2, "review", { head: String(n + 1).repeat(40), round: n + 1, findings: [finding], p0: 0, p1: 1, p2: 0, path: `/r${n + 1}.md` })]).flat();
}
const facts = (round: number): ReviewFacts => ({ round, findings: [finding], head: String(round).repeat(40), eventSeq: round * 2,
  verdict: "changes", reviewer: "rv", reviewerSessionId: "review", reviewerFamily: "codex", reportPath: `/r${round}.md` });

test("two rounds replace context; four switch either author's family", () => {
  expect(fixStrategy(history(1), facts(1), "claude")?.mode).toBe("continue");
  expect(fixStrategy(history(2), facts(2), "claude")).toMatchObject({ mode: "fresh_session", family: "claude" });
  for (const family of ["claude", "codex"] as const) {
    expect(fixStrategy(history(4), facts(4), family)).toMatchObject({ mode: "other_family", family: family === "claude" ? "codex" : "claude" });
  }
});

test("missing delivery proof cannot authorize session replacement", () => {
  expect(fixStrategy(history(2).filter((e) => e.seq !== 1), facts(2), "claude")).toBeNull();
});

test("history contains unabridged reports, per-round diff material and probes; read failures propagate", async () => {
  const strategy = fixStrategy(history(2), facts(2), "claude")!;
  const rows = await fixHistory(history(2), strategy, async (p) => `original ${p}`, async (a, b) => `${a}..${b}`);
  expect(rows.map((r) => r.report)).toEqual(["original /r1.md", "original /r2.md"]);
  expect(rows[1].diffSummary).toBe(`${"1".repeat(40)}..${"2".repeat(40)}`);
  expect(rows[0].probes).toEqual([finding.probe]);
  await expect(fixHistory(history(2), strategy, async () => "", async () => "diff")).rejects.toThrow("报告为空");
});
