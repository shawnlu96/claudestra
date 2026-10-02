import { describe, expect, test } from "bun:test";
import { basisField, basisFromText, findingBasis } from "../src/lib/review-converge-basis.js";
import { followUpGlobs } from "../src/lib/review-converge-followup-text.js";
import { reportBasis } from "../src/lib/review-converge-report.js";
import { convergeReview } from "../src/lib/review-converge.js";
import type { ReviewFacts, ReviewFinding } from "../src/lib/scheduler-review.js";

/**
 * i28-MT1f2 round 2, findings[0].probe (outsider-voids-live-train) verbatim from the ledger: a real P1 whose probe opens with a
 * two-line marker, demoted as "no basis" before i28-CONV5. Its follow-up globs keep only the real source path.
 */
const MT1F2_R2_PROBE = "[验收线 1、2] /tmp/rv-mt1f2-r2-acceptance.test.ts:existing ready outsider must wait during testing / settling 两个测试均失败。" +
  "T3 已占槽且 ready,因文件与 T1 重叠被正常组车排除;trainProjects 仍允许该项目组车。两轮后都观测到 serial-merge:3,列车提前 void/done," +
  "而期望无串行效果、等待健康列车结束。src/lib/scheduler-merge-train-hold.ts:41-46 无条件 voidTrain;hold-slot.ts:44 只按 phase 判断候选,不能保证槽主真正入选。";

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
    const f: ReviewFinding = { findingId: "outsider-voids-live-train", family: "outsider-voids-live-train", severity: "P1", probe: MT1F2_R2_PROBE };
    expect(findingBasis(f)).toBe("acceptance:1");
    const c = convergeReview([], facts([f]), null);
    expect(c.downgrade).toBeNull();
    expect(c.facts.findings[0].severity).toBe("P1");
    // /tmp, bare hold-slot.ts and void/done drop; with no real path left the card's globs stand
    const exists = (p: string) => p === "src/lib/scheduler-merge-train-hold.ts";
    expect(followUpGlobs([{ probe: MT1F2_R2_PROBE }], ["src/own.ts"], exists)).toEqual(["src/lib/scheduler-merge-train-hold.ts"]);
    expect(followUpGlobs([{ probe: MT1F2_R2_PROBE }], ["src/own.ts"], () => false)).toEqual(["src/own.ts"]);
  });
});
