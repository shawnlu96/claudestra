import { describe, expect, test } from "bun:test";
import { basisFromText, findingBasis } from "../src/lib/review-converge-basis.js";
import { reportBasis, storedBasis } from "../src/lib/review-converge-report.js";
import { convergeReview } from "../src/lib/review-converge.js";
import type { ReviewFacts, ReviewFinding } from "../src/lib/scheduler-review.js";

/**
 * followup-reliability-MIX1: PR624 r1 named unbound-old-failed-turn a regression P1 under 「[回归;验收线 6]」. The public
 * submit schema carries no `basis`, so the report text is the only basis; a mixed marker read as none demoted the P1 as no_basis.
 */
const PR624_REPORT = [
  "# PR624 r1 审查",
  "",
  "## P1 unbound-old-failed-turn [回归;验收线 6]",
  "旧回合失败卡片未绑定到本单就被停单回执,别的单的旧失败也会误停当前单。src/lib/lend-worker-turn.ts 未比对回合归属。",
  "",
  "## P2 card-copy-wording",
  "文案措辞,不影响验收。",
].join("\n");

const facts = (findings: ReviewFinding[]): ReviewFacts => ({ findings, round: 1, head: "e".repeat(40), verdict: "changes", eventSeq: 9,
  reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", reportPath: "/reviews/pr624-r1.md" });

describe("markers that mix several complete labels", () => {
  test("regression with an acceptance line, two acceptance lines, any separator: the first acceptance line wins", () => {
    for (const t of ["[回归;验收线 6] x", "[回归；验收线 6]", "【回归，验收线 6】", "（回归 / 验收线 6）", "［regression; acceptance 6］",
      "[回归 验收线 6]", "[回归、acceptance:6]", "[回归 and 验收线 #6]"]) expect(basisFromText(t)).toBe("acceptance:6");
    for (const t of ["[验收线 2;验收线 6]", "[验收线 2 / 验收线 6]", "[验收线 2 验收线 6]", "[验收线 2，6；验收线 7]", "（验收线 2、6）",
      "[acceptance 2, acceptance 6]", "[验收线 2;回归]"]) expect(basisFromText(t)).toBe("acceptance:2");
    expect(basisFromText("[回归] 后文另有 [验收线 3/4]")).toBe("acceptance:3");
    expect(basisFromText("[回归 / regression]")).toBe("regression");
    expect(basisFromText("（回归）")).toBe("regression");
  });

  test("only a bounded, fully-formed marker counts", () => {
    for (const t of ["回归;验收线 6 没加括号", "这是回归,违反验收线 6", "[验收线 0]", "[回归;验收线 0]", "[验收线 -1]", "[验收线 1000]",
      "[回归; 6]", "[验收线 ]", "[验收线 2; 验收]", "[回归 xx 验收线 6]", "[回归验收线 6]", "[regressions]", "[P1] 参见 #6 与 1、2",
      "[1, 2]", "[回归;验收线 6", "(回归;验收线 6)", "[验收线 2;\n验收线 6]"]) expect(basisFromText(t)).toBeNull();
    // a void marker does not hide a valid one elsewhere
    expect(basisFromText("[验收线 0] 另见 [回归;验收线 6]")).toBe("acceptance:6");
  });

  test("the structured field still outranks any marker", () => {
    expect(findingBasis({ findingId: "F", family: "f", probe: "[回归;验收线 6] x", basis: "regression" })).toBe("regression");
    expect(findingBasis({ findingId: "F", family: "f", probe: "[验收线 2;验收线 6] x", basis: "acceptance:3" })).toBe("acceptance:3");
  });
});

describe("PR624 unbound-old-failed-turn keeps its P1 through the report path", () => {
  const f: ReviewFinding = { findingId: "unbound-old-failed-turn", family: "lend-turn-failure", severity: "P1",
    probe: "src/lib/lend-worker-turn.ts 旧失败回合未绑定本单" };

  test("report extraction → stored basis → converge keeps the P1", () => {
    expect(f.basis).toBeUndefined();
    expect(reportBasis(f, PR624_REPORT)).toBe("acceptance:6");
    const stored: ReviewFinding = { ...f, ...storedBasis(f, PR624_REPORT) };
    expect(stored.basis).toBe("acceptance:6");
    const c = convergeReview([], facts([stored]), null);
    expect(c.downgrade).toBeNull();
    expect(c.facts.findings[0].severity).toBe("P1");
  });

  test("the marker in the finding's own text works the same, and a real no-basis P1 still demotes", () => {
    const own: ReviewFinding = { ...f, probe: `[回归;验收线 6] ${f.probe}` };
    expect(findingBasis(own)).toBe("acceptance:6");
    const bare: ReviewFinding = { findingId: "card-copy-wording", family: "copy", severity: "P1", probe: "文案措辞" };
    const storedBare: ReviewFinding = { ...bare, ...storedBasis(bare, PR624_REPORT) };
    expect(storedBare.basis).toBeUndefined();
    const c = convergeReview([], facts([own, storedBare]), null);
    expect(c.facts.findings.map((x) => x.severity)).toEqual(["P1", "P2"]);
    expect(c.downgrade?.items).toEqual([{ findingId: "card-copy-wording", family: "copy", probe: "文案措辞", why: "no_basis" }]);
  });

  test("a mixed marker stays with its own finding: the next heading and a neighbour's line do not inherit it", () => {
    const report = "## A [回归;验收线 6]\n- A 的说明\n## B\n- B 的说明\n## C [验收线 2;验收线 6]\n- C 的说明";
    expect(reportBasis({ findingId: "A", family: "f", probe: "" }, report)).toBe("acceptance:6");
    expect(reportBasis({ findingId: "B", family: "f", probe: "" }, report)).toBeNull();
    expect(reportBasis({ findingId: "C", family: "f", probe: "" }, report)).toBe("acceptance:2");
  });
});
