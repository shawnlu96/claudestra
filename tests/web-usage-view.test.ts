/**
 * 用量看板纯逻辑（web/features/chat/usage-view.ts）：按 runtime 分行、额度卡数据的容错。
 */

import { describe, test, expect } from "bun:test";
import {
  claudeQuotaSource,
  codexQuotas,
  fmtUsageCell,
  groupUsageRows,
  quotaOrigin,
  windowLabel,
  type StatAgent,
} from "../web/features/chat/usage-view";

const win = (tokens: number, costUsd = 0, reportedCostUsd?: number) => ({ tokens, costUsd, reportedCostUsd });
const agent = (name: string, runtime: string | null | undefined, t: ReturnType<typeof win>, w = t): StatAgent => ({
  name,
  runtime,
  today: t,
  week: w,
});

describe("groupUsageRows", () => {
  test("只有 Claude Code：只出合计一行（不拆出一模一样的第二行）", () => {
    const rows = groupUsageRows([agent("a", "claude-code", win(100, 1)), agent("b", undefined, win(50, 0.5))]);
    expect(rows.map((r) => r.key)).toEqual(["all"]);
    expect(rows[0].today.tokens).toBe(150);
  });

  test("Codex 单独一行，不再算进 Claude Code；缺省 runtime 归 Claude Code", () => {
    const rows = groupUsageRows([
      agent("x", "codex", win(1000)),
      agent("a", "claude-code", win(100, 1)),
      agent("old", null, win(10, 0.1)),
    ]);
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ["all", "全机合计"],
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
    ]);
    const cc = rows.find((r) => r.key === "claude-code")!;
    expect(cc.today.tokens).toBe(110);
    expect(rows.find((r) => r.key === "codex")!.today.tokens).toBe(1000);
  });

  test("三家都有：固定顺序 Claude Code / Codex / Pi，Pi 下面挂「运行时报告的费用」", () => {
    const rows = groupUsageRows([
      agent("p", "pi", win(10, 0, 0.12), win(20, 0, 0.3)),
      agent("x", "codex", win(1000)),
      agent("a", "claude-code", win(100, 1)),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["all", "claude-code", "codex", "pi", "pi:reported"]);
    const rep = rows.find((r) => r.key === "pi:reported")!;
    expect(rep.kind).toBe("reported");
    expect(fmtUsageCell(rep, "today")).toBe("$0.12");
    expect(fmtUsageCell(rep, "week")).toBe("$0.30");
  });

  test("只有 Pi：报告的费用挂在合计下面", () => {
    const rows = groupUsageRows([agent("p", "pi", win(10, 0, 0.5))]);
    expect(rows.map((r) => r.key)).toEqual(["all", "all:reported"]);
  });

  test("老 bridge：没有 reportedCostUsd / 窗口缺失也不炸", () => {
    const rows = groupUsageRows([{ name: "a" }, { name: "b", runtime: "pi", today: { tokens: 5 } }]);
    expect(rows.map((r) => r.key)).toEqual(["all", "claude-code", "pi"]);
    expect(rows[0].today).toEqual({ tokens: 5, costUsd: 0, reportedCostUsd: 0 });
  });
});

describe("fmtUsageCell", () => {
  test("有 token 却没折算出钱（没有牌价）显示「—」，不是 $0.00", () => {
    const [row] = groupUsageRows([agent("x", "codex", win(1_500_000))]);
    expect(fmtUsageCell(row, "today")).toBe("1.5M · —");
  });
  test("正常折算与零用量", () => {
    const [row] = groupUsageRows([agent("a", "claude-code", win(12_345, 1.234))]);
    expect(fmtUsageCell(row, "today")).toBe("12k · $1.23");
    const [zero] = groupUsageRows([agent("a", "claude-code", win(0))]);
    expect(fmtUsageCell(zero, "today")).toBe("0 · $0.00");
  });
});

describe("额度卡数据", () => {
  test("claudeQuotaSource 认 bridge 的来源标记", () => {
    expect(claudeQuotaSource("statusline cache")).toBe("statusline");
    expect(claudeQuotaSource("statusline cache (stale)")).toBe("statusline-stale");
    expect(claudeQuotaSource("Settings Status Config Usage\nCurrent session")).toBe("status-panel");
    expect(claudeQuotaSource(undefined)).toBeNull();
  });

  test("codexQuotas：老 bridge 没有 quotas → 空；未知 source 不画", () => {
    expect(codexQuotas(undefined)).toEqual([]);
    expect(codexQuotas({})).toEqual([]);
    const q = { source: "codex-rollout", windows: [] };
    expect(codexQuotas([q, { source: "future-thing" }, null])).toEqual([q]);
  });

  test("windowLabel 与 quotaOrigin", () => {
    expect(windowLabel("5h", false)).toBe("5 小时窗口");
    expect(windowLabel("7d", true)).toBe("7d window");
    expect(windowLabel("primary", false)).toBe("primary");
    expect(quotaOrigin({ source: "codex-rollout", agent: "agent-codex", sessionId: "01a0d336-6344" })).toBe("codex · 01a0d336");
    expect(quotaOrigin({ source: "codex-rollout", cwd: "/Users/x/repos/demo/", sessionId: "abc" })).toBe("demo · abc");
  });
});
