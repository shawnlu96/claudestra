import { describe, expect, test } from "bun:test";
import type { LedgerEvent } from "../src/lib/ledger-stages.js";
import { basisField, basisFromText, findingBasis } from "../src/lib/review-converge-basis.js";
import { BASIS_LINE, convergeOrderLines, scopeLine } from "../src/lib/review-converge-order.js";
import { reportBasis, storedBasis } from "../src/lib/review-converge-report.js";
import { diffDirs, fixDiffOf } from "../src/lib/review-converge-scope.js";
import { convergeFindings, convergeReview, fixWarning, MAX_REVIEW_ROUND, roundCap, touchesDiff } from "../src/lib/review-converge.js";
import { currentReviewFacts, DOWNGRADE_OP, type ReviewFacts, type ReviewFinding } from "../src/lib/scheduler-review.js";
import { parseVerdictWire, WIRE_LIMITS } from "../src/lib/order-wire.js";

const H1 = "c".repeat(40), H2 = "d".repeat(40);
const event = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>): LedgerEvent =>
  ({ seq, ts: seq, actor: "scheduler", project: "p", target: "T1", kind, data, text: "", dedupKey: null });
const finding = (findingId: string, over: Partial<ReviewFinding> = {}): ReviewFinding =>
  ({ findingId, family: findingId, severity: "P1", probe: "src/untouched.ts:2", ...over });
const facts = (findings: ReviewFinding[], round = 3): ReviewFacts => ({ findings, round, head: H2, verdict: "changes", eventSeq: 30,
  reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", reportPath: "/reviews/r.md" });
const prev = [event(20, "review", { round: 2, head: H1, findings: [finding("open", { basis: "acceptance:1" })] })];
const diff = { from: H1, to: H2, files: ["src/changed.ts"] };

const wire = (findings: object[]) => ({ v: 1, orderId: "T1:review:r3", head: H2, verdict: "changes", p0: 0, p1: findings.length, p2: 0,
  findings: findings.map((f) => ({ description: "旧版说明", ...f })), reportPath: "/reviews/r.md" });

describe("P1 basis and old verdicts", () => {
  test("structured field and per-finding legacy markers; unmarked findings are not evidence", () => {
    expect(basisField("acceptance:2")).toBe("acceptance:2");
    expect(basisField("acceptance:0")).toBeNull();
    expect(basisFromText("[验收线 12] 标题")).toBe("acceptance:12");
    expect(findingBasis({ ...finding("one"), description: "[回归] 报告摘要" })).toBe("regression");
    expect(storedBasis(finding("one"), "## one\n[验收线 3] 重现\n## two\n[回归] 其他问题")).toEqual({ basis: "acceptance:3" });
    expect(reportBasis(finding("one"), "## one\n没有依据\n## two [回归]\n其他问题")).toBeNull();
    expect(reportBasis(finding("one"), "## someone [回归]")).toBeNull();
    expect(storedBasis(finding("one", { basis: "acceptance:1" }), "one [回归]")).toEqual({ basis: "acceptance:1" });
  });

  test("wire accepts absent, structured and description-marked basis without weakening unknown-field validation", () => {
    for (const f of [finding("old"), finding("new", { basis: "regression" }), { ...finding("marker"), description: "[验收线 1] x" }]) {
      const r = parseVerdictWire(wire([f]));
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(r.error);
      expect(findingBasis(r.value.findings[0])).toBe(f.findingId === "old" ? null : f.findingId === "new" ? "regression" : "acceptance:1");
    }
    expect(parseVerdictWire(wire([{ ...finding("bad"), basis: "why" }])).ok).toBe(false);
    expect(parseVerdictWire(wire([{ ...finding("bad"), surprise: true }])).ok).toBe(false);
  });

  test("no basis demotes only P1 and preserves the stored verdict; merge gates see the persisted demotion", () => {
    const f = facts([finding("unbound"), finding("p0", { severity: "P0" }), finding("p2", { severity: "P2" })], 1);
    const c = convergeReview([], f, null);
    expect(c.facts.findings.map((x) => x.severity)).toEqual(["P2", "P0", "P2"]);
    expect(c.downgrade?.items).toMatchObject([{ findingId: "unbound", why: "no_basis" }]);
    expect(f.findings[0].severity).toBe("P1");
    const events = [event(30, "review", { ...f, path: f.reportPath, p0: 1, p1: 1, p2: 1 }),
      event(31, "scheduler", { op: DOWNGRADE_OP, round: 1, findingIds: ["unbound"] })];
    const read = currentReviewFacts({ round: 1, headSHA: H2, specRev: 1 }, events);
    expect(read.kind === "facts" && read.facts.findings[0].severity).toBe("P2");
    expect(convergeFindings(events, f, null).items).toEqual([]);
  });
});

describe("round 3 scope", () => {
  test("only new non-regression findings outside the fix diff are downgraded", () => {
    const rows = [finding("outside", { basis: "acceptance:1" }), finding("inside", { basis: "acceptance:2", probe: "src/changed.ts:8" }),
      finding("regression", { basis: "regression" }), finding("open", { basis: "acceptance:1" }), finding("no-path", { basis: "acceptance:1", probe: "no file" })];
    const result = convergeFindings(prev, facts(rows), diff);
    expect(result.items.map((x) => [x.findingId, x.why])).toEqual([["outside", "outside_diff"], ["no-path", "outside_diff"]]);
    expect(convergeFindings(prev, facts(rows, 2), diff).items).toEqual([]);
    const sameFamily = finding("new-issue", { family: "open", basis: "acceptance:1" });
    expect(convergeFindings(prev, facts([sameFamily]), diff).items[0].why).toBe("outside_diff");
    for (const unknown of [null, { ...diff, from: H2 }, { ...diff, to: H1 }]) expect(convergeFindings(prev, facts(rows), unknown).items).toEqual([]);
    expect(touchesDiff("src/changed.ts:8", diff.files)).toBe(true);
    expect(touchesDiff("src/unchanged.ts", diff.files)).toBe(false);
  });

  test("scope survives loss of git history after the transition to merge", () => {
    const f = facts([finding("outside", { basis: "acceptance:1" })]);
    const saved = [...prev, event(31, "scheduler", { op: DOWNGRADE_OP, round: 3, findingIds: ["outside"] })];
    expect(convergeFindings(saved, f, null).findings[0].severity).toBe("P2");
  });

  test("both order paths use bounded lines, and missing previous head still tells round 3 reviewers the scope", () => {
    expect(convergeOrderLines(2, prev, H2)).toEqual([BASIS_LINE]);
    expect(scopeLine(3, prev, H2)).toContain(`${H1.slice(0,12)}..${H2.slice(0,12)}`);
    expect(convergeOrderLines(3, [], H2)[1]).toContain("只审修复");
    for (const line of convergeOrderLines(3, prev, H2)) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(WIRE_LIMITS.line);
  });

  test("diff computation fails conservatively, retries missing objects and caches successful SHA pairs", () => {
    expect(Array.isArray(diffDirs("T1"))).toBe(true);
    const events = [...prev, event(30, "review", { round: 3, head: H2 })];
    const task = { id: "T1", round: 3 };
    expect(fixDiffOf(task, events, () => null, ["missing"])).toBeNull();
    const tried: string[] = [];
    expect(fixDiffOf(task, events, (dir) => { tried.push(dir); return dir === "found" ? diff.files : null; }, ["missing", "found"])).toEqual(diff);
    expect(tried).toEqual(["missing", "found"]);
    expect(fixDiffOf(task, events, () => { throw new Error("must use cache"); }, ["found"])).toEqual(diff);
    expect(fixDiffOf({ ...task, round: 2 }, events, () => [], [])).toBeNull();
  });
});

test("round cap and warnings replace four-round escalation; only an explicit PM resume releases this verdict", () => {
  expect(MAX_REVIEW_ROUND).toBe(8);
  expect(roundCap([], { round: 7, eventSeq: 30 })).toBeNull();
  expect(roundCap([], { round: 8, eventSeq: 30 })?.code).toBe("review_round_cap");
  expect(roundCap([event(31, "scheduler", { op: "workflow_resume", manual: true })], { round: 8, eventSeq: 30 })).toBeNull();
  expect(roundCap([event(31, "scheduler", { op: "workflow_resume", auto: true })], { round: 8, eventSeq: 30 })).not.toBeNull();
  expect(fixWarning(1, 4, "fallback")).toBeNull();
  expect(fixWarning(2, 2, "fallback")).toContain("同一条 P1 已连续 2 轮");
  expect(fixWarning(1, 7, "fallback")).toContain("第 8 轮");
});
