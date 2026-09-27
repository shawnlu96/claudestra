/**
 * Pi 的 usage.cost（运行时报告的费用）：翻译时保留，统计时与牌价折算分开记、互不重叠。
 */

import { describe, test, expect } from "bun:test";
import { scanStatsWindow } from "../src/lib/agent-stats.js";
import { piLineToClaudeShape, piUsageToClaude } from "../src/lib/pi-session.js";

describe("piUsageToClaude 保留 usage.cost", () => {
  test("Pi 的 cost 对象取 total，放进 runtime_reported_cost_usd", () => {
    const u = piUsageToClaude({
      input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    })!;
    expect(u.runtime_reported_cost_usd).toBe(0.003);
    expect(u.input_tokens).toBe(10);
  });

  test("裸数字也认；0 是有效的报告值", () => {
    expect(piUsageToClaude({ input: 1, cost: 0.5 })!.runtime_reported_cost_usd).toBe(0.5);
    expect(piUsageToClaude({ input: 1, cost: { total: 0 } })!.runtime_reported_cost_usd).toBe(0);
  });

  test("没有 / 认不出 cost → 不带这个字段（统计照牌价折算）", () => {
    expect("runtime_reported_cost_usd" in piUsageToClaude({ input: 1 })!).toBe(false);
    expect("runtime_reported_cost_usd" in piUsageToClaude({ input: 1, cost: { total: "3" } })!).toBe(false);
    expect("runtime_reported_cost_usd" in piUsageToClaude({ input: 1, cost: -1 })!).toBe(false);
  });
});

describe("scanStatsWindow：报告的费用与牌价折算分开", () => {
  const now = new Date().toISOString();
  const dayTs = Date.now() - 60_000;
  const weekTs = dayTs - 86400_000;
  const piLine = (model: string, cost?: object) =>
    JSON.stringify({
      type: "message",
      timestamp: now,
      message: { role: "assistant", model, usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost }, content: [] },
    });

  test("带报告值的记录只记报告值；没带的按牌价折算", () => {
    const lines = [
      piLine("claude-sonnet-4-5", { total: 0.25 }), // 报告了：不再按 sonnet 牌价 $3 估
      piLine("claude-sonnet-4-5"), // 没报告：按牌价 $3
      piLine("glm-5.3-flash", { total: 0.01 }), // 没牌价的模型，报告值照记
    ];
    const { stats } = scanStatsWindow(lines, dayTs, weekTs, "pi");
    expect(stats.week.reportedCostUsd).toBeCloseTo(0.26, 9);
    expect(stats.week.costUsd).toBeCloseTo(3, 9);
    expect(stats.today.reportedCostUsd).toBeCloseTo(0.26, 9);
    expect(stats.week.requests).toBe(3);
  });

  test("翻译后的 assistant 行带着报告值（下游 jsonl-cost 等不认它也不受影响）", () => {
    const rec = piLineToClaudeShape(piLine("m", { total: 1.5 }))!;
    expect(rec.message.usage.runtime_reported_cost_usd).toBe(1.5);
  });

  test("Claude Code 行没有报告值：reportedCostUsd 恒 0", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: now,
      message: { model: "claude-sonnet-4-5", usage: { input_tokens: 1_000_000 } },
    });
    const { stats } = scanStatsWindow([line], dayTs, weekTs);
    expect(stats.week.reportedCostUsd).toBe(0);
    expect(stats.week.costUsd).toBeCloseTo(3, 9);
  });
});
