/**
 * 按卡汇总的纯函数（UXUSAGE1 验收线 3，src/lib/usage-task-summary.ts）：按家族合计 = 明细 + 归档，明细部分与逐行结果加总一致；
 * 出借单只给单数并标「用量对方未回传」、没有 token 数；估算占本周额度在输入齐全时按规格第 4 条算，缺任一输入不给。
 */
import { describe, expect, test } from "bun:test";
import type { FamilyPart, TaskUsageFacts } from "../src/lib/usage-query.js";
import { estimateWeekShare, summarizeTaskUsage, weekStartsOf } from "../src/lib/usage-task-summary.js";

const WEEK = 7 * 86_400_000;
const part = (family: string, n: number, firstAt: number, lastAt: number): FamilyPart =>
  ({ family, input: n, cacheCreation: n, cacheRead: n, output: n, reasoning: 0, totalTokens: 4 * n, calls: n, firstAt, lastAt });
const facts = (over: Partial<TaskUsageFacts> = {}): TaskUsageFacts =>
  ({ detail: [], archive: [], sessions: {}, week: {}, detailFrom: null, unarchivedBefore: null, ...over });

describe("[验收线 3] 按家族合计", () => {
  test("合计 = 明细 + 归档；最早 / 最晚取两边；会话数照给", () => {
    const s = summarizeTaskUsage(facts({
      detail: [part("claude", 5, 300, 400), part("codex", 2, 50, 60)], archive: [part("claude", 3, 100, 200)],
      sessions: { claude: 3, codex: 1 }, detailFrom: "2026-09-13",
    }), {}, {});
    expect(s.families.claude).toMatchObject({ totalTokens: 32, calls: 8, sessions: 3, firstAt: 100, lastAt: 400 });
    expect(s.families.claude!.detail.totalTokens).toBe(20);
    expect(s.families.claude!.archived!.totalTokens).toBe(12);
    expect(s.families.codex).toMatchObject({ totalTokens: 8, archived: null, firstAt: 50, lastAt: 60 });
    expect(s).toMatchObject({ totalTokens: 40, calls: 10, hasArchive: true, detailFrom: "2026-09-13", unavailableBefore: null, unavailableNote: null });
  });

  test("没用过的卡：没有家族、合计 0、没有归档；归档上线前清掉的日子如实标出", () => {
    const s = summarizeTaskUsage(facts({ unarchivedBefore: "2026-09-01" }), {}, {});
    expect(s).toMatchObject({ families: {}, totalTokens: 0, hasArchive: false, lent: {}, weekEstimate: {} });
    expect(s.unavailableNote).toBe("早于 2026-09-01 的部分已不可查");
  });
});

test("[验收线 3] 出借单按家族给单数与状态分布、标未回传，不给 token 数", () => {
  const s = summarizeTaskUsage(facts(), { codex: { done: 2, cancelled: 1 }, claude: { claimed: 1 } }, {});
  expect(s.lent).toEqual({
    codex: { orders: 3, byStatus: { done: 2, cancelled: 1 }, tokensReported: false, note: "用量对方未回传" },
    claude: { orders: 1, byStatus: { claimed: 1 }, tokensReported: false, note: "用量对方未回传" },
  });
  expect(JSON.stringify(s.lent)).not.toMatch(/tokens"?:\s*\d/);
});

describe("[验收线 3] 估算占本周额度", () => {
  const quota = { weekUsedPct: 40, resetAt: 10 * WEEK };
  test("输入齐全：本卡本周 ÷ 本机同家族本周 × 已用百分比，取整到 1%", () => {
    expect(estimateWeekShare(quota, { task: 250, machine: 1000 })).toEqual({
      estimatePct: 10, estimateLabel: "约 10%", weekStart: 9 * WEEK, weekUsedPct: 40, taskWeekTokens: 250, machineWeekTokens: 1000,
    });
    expect(estimateWeekShare(quota, { task: 333, machine: 1000 })!.estimatePct).toBe(13); // 13.32 → 13
    expect(estimateWeekShare(quota, { task: 337, machine: 1000 })!.estimatePct).toBe(13); // 13.48 → 13
    expect(estimateWeekShare(quota, { task: 338, machine: 1000 })!.estimatePct).toBe(14); // 13.52 → 14
  });

  test("不足 1% 写「不到 1%」，不写 0", () => {
    for (const task of [0, 24]) expect(estimateWeekShare(quota, { task, machine: 1000 })).toMatchObject({ estimatePct: null, estimateLabel: "不到 1%" });
  });

  test("缺任一输入就不给：没有百分比、没有本机本周 token、本机本周为 0", () => {
    expect(estimateWeekShare(undefined, { task: 1, machine: 10 })).toBeNull();
    expect(estimateWeekShare(quota, undefined)).toBeNull();
    expect(estimateWeekShare(quota, { task: 0, machine: 0 })).toBeNull();
    expect(estimateWeekShare({ weekUsedPct: NaN, resetAt: 1 }, { task: 1, machine: 10 })).toBeNull();
  });

  test("summary 只给额度和本周 token 都有的家族；周起点 = 重置时刻往前 7 天", () => {
    expect(weekStartsOf({ claude: quota })).toEqual({ claude: 9 * WEEK });
    const s = summarizeTaskUsage(facts({ week: { claude: { task: 100, machine: 400 }, codex: { task: 5, machine: 10 } } }), {}, { claude: quota });
    expect(Object.keys(s.weekEstimate)).toEqual(["claude"]);
    expect(s.weekEstimate.claude!.estimateLabel).toBe("约 10%");
  });
});
