/**
 * PMEMTUNE2 [验收线 3]：跨卡无关降权的先验乘子——平滑、样本不足不降、30 天半衰期、下限 0.2；refs 事件按记忆汇总，wrong 不并进来、本卡自己的不算。
 */
import { describe, expect, test } from "bun:test";
import { FEEDBACK_FLOOR, feedbackPrior, marksByMemory, type FeedbackMark } from "../src/lib/memory-feedback-prior.js";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const marks = (use: FeedbackMark["use"], n: number, daysAgo = 0): FeedbackMark[] => Array.from({ length: n }, () => ({ use, ts: NOW - daysAgo * DAY }));

describe("feedbackPrior [验收线 3]", () => {
  test("别的卡标 irrelevant 5 次、applied 0 次：降权，但不低于 0.2", () => {
    const p = feedbackPrior(marks("irrelevant", 5), NOW);
    expect(p).toBeLessThan(1);
    expect(p).toBeCloseTo(2 / 7, 12); // 平滑 1/7，对「没有信息」的 0.5 折算 → 2/7 ≈ 0.286
    expect(p).toBeGreaterThanOrEqual(FEEDBACK_FLOOR);
    expect(feedbackPrior(marks("irrelevant", 500), NOW)).toBe(0.2);
  });

  test("样本少于 3 次不降权", () => {
    expect(feedbackPrior([], NOW)).toBe(1);
    expect(feedbackPrior(marks("irrelevant", 2), NOW)).toBe(1);
    expect(feedbackPrior(marks("irrelevant", 3), NOW)).toBeLessThan(1);
  });

  test("平滑 (applied + 1) / (applied + irrelevant + 2)，以 0.5 为基准：applied 不少于 irrelevant 的不降", () => {
    expect(feedbackPrior([...marks("applied", 1), ...marks("irrelevant", 3)], NOW)).toBeCloseTo(2 * (2 / 6), 12);
    expect(feedbackPrior([...marks("applied", 2), ...marks("irrelevant", 2)], NOW)).toBe(1);
    expect(feedbackPrior([...marks("applied", 3), ...marks("irrelevant", 1)], NOW)).toBe(1);
    expect(feedbackPrior(marks("applied", 10), NOW)).toBe(1);
  });

  test("30 天前的标记权重减半", () => {
    // 4 条 30 天前的 irrelevant = 2 条今天的：2 × (0 + 1) / (2 + 2)
    expect(feedbackPrior(marks("irrelevant", 4, 30), NOW)).toBeCloseTo(2 / 4, 12);
    expect(feedbackPrior(marks("irrelevant", 6, 30), NOW)).toBeCloseTo(feedbackPrior(marks("irrelevant", 3), NOW), 12);
    // 2 条 30 天前的 applied（= 1 条今天的）对 3 条今天的 irrelevant：2 × 2 / 6
    expect(feedbackPrior([...marks("applied", 2, 30), ...marks("irrelevant", 3)], NOW)).toBeCloseTo(2 * (2 / 6), 12);
    // 越久越不影响：一年前的 10 次无关几乎不降
    expect(feedbackPrior(marks("irrelevant", 10, 365), NOW)).toBeGreaterThan(0.99);
  });
});

describe("marksByMemory", () => {
  const row = (target: string, ts: number, refs: unknown) => ({ target, ts, data: JSON.stringify({ op: "refs", refs }) });

  test("按 memoryId 汇总 applied / irrelevant；wrong、坏行跳过；本卡的不算", () => {
    const m = marksByMemory([
      row("A", 1, [{ id: "m1", use: "irrelevant" }, { id: "m2", use: "applied" }, { id: "m3", use: "wrong", note: "x" }]),
      row("B", 2, [{ id: "m1", use: "irrelevant" }]),
      row("SELF", 3, [{ id: "m1", use: "applied" }]),
      { target: "C", ts: 4, data: "{bad" },
      { target: "C", ts: 5, data: null },
      row("C", 6, "nope"),
    ], "SELF");
    expect(Object.fromEntries(m)).toEqual({
      m1: [{ use: "irrelevant", ts: 1 }, { use: "irrelevant", ts: 2 }],
      m2: [{ use: "applied", ts: 1 }],
    });
  });
});
