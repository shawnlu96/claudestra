import { describe, expect, test } from "bun:test";
import { basisField, basisFromText, findingBasis } from "../src/lib/review-converge-basis.js";
import { reportBasis } from "../src/lib/review-converge-report.js";
import { convergeReview } from "../src/lib/review-converge.js";
import type { ReviewFacts, ReviewFinding } from "../src/lib/scheduler-review.js";

/** i28-MT1f2 round 2: a real P1 whose probe opens with a two-line marker, demoted as "no basis" before i28-CONV5. */
const MT1F2_R2_PROBE = "[验收线 1、2] hold-slot.ts 的占位在 void/done 两条退出路径上都没释放：先跑 /tmp/rv-mt1f2-r2-acceptance.test.ts，" +
  "第二张卡在 src/lib/scheduler-slot-hold.ts 拿不到写槽，验收线 1 的并发用例和验收线 2 的释放用例都失败。";

const facts = (findings: ReviewFinding[]): ReviewFacts => ({ findings, round: 2, head: "d".repeat(40), verdict: "changes", eventSeq: 30,
  reviewer: "rv", reviewerSessionId: "s", reviewerFamily: "codex", reportPath: "/reviews/r.md" });

describe("acceptance markers that name several lines", () => {
  test("four list spellings resolve to the first line", () => {
    for (const t of ["[验收线 1、2] x", "[验收线 1,2] x", "[验收线 1 和 2] x", "[acceptance 1, 2] x"]) expect(basisFromText(t)).toBe("acceptance:1");
    expect(basisFromText("【验收线 3，4、5】 x")).toBe("acceptance:3");
    expect(basisFromText("[验收线 2 and 1] x")).toBe("acceptance:2");
  });

  test("a report heading in the field spelling counts its first line", () => {
    expect(basisFromText("## F1 acceptance:1 and acceptance:2 槽位泄漏")).toBe("acceptance:1");
    expect(reportBasis({ findingId: "F1", family: "f", probe: "" }, "## F1 acceptance:2 and acceptance:1\n说明")).toBe("acceptance:2");
    expect(basisFromText("preacceptance:1")).toBeNull();
  });

  test("single line, regression mark and the structured field behave as before", () => {
    expect(basisFromText("[验收线 1] x")).toBe("acceptance:1");
    expect(basisFromText("[验收线 12] 标题")).toBe("acceptance:12");
    expect(basisFromText("[回归] x")).toBe("regression");
    expect(basisFromText("[回归] 也违反 [验收线 3]")).toBe("acceptance:3");
    expect(basisFromText("[验收线 1、x] 不是编号列表")).toBeNull();
    expect(basisFromText("验收线 1、2 没加括号")).toBeNull();
    expect(basisField("acceptance:2")).toBe("acceptance:2");
    expect(findingBasis({ findingId: "F", family: "f", probe: "[验收线 1、2] x", basis: "regression" })).toBe("regression");
  });

  test("the MT1f2 round-2 probe keeps its P1", () => {
    const f: ReviewFinding = { findingId: "slot-leak", family: "slot-leak", severity: "P1", probe: MT1F2_R2_PROBE };
    expect(findingBasis(f)).toBe("acceptance:1");
    const c = convergeReview([], facts([f]), null);
    expect(c.downgrade).toBeNull();
    expect(c.facts.findings[0].severity).toBe("P1");
  });
});
