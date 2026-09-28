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
  usageTableData,
  weekColumnNote,
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
      ["all", "agent 当前会话"],
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

describe("groupUsageRows：有全机合计（新 bridge）", () => {
  const machine = (today: number, week: number, byRuntime?: Record<string, [number, number]>) => ({
    today: { tokens: today },
    week: { tokens: week },
    byRuntime: byRuntime
      ? Object.fromEntries(Object.entries(byRuntime).map(([k, [t, w]]) => [k, { today: { tokens: t }, week: { tokens: w } }]))
      : undefined,
  });

  test("这台机器合计 → agent 当前会话 → 其他会话 = 合计 − agent", () => {
    const rows = groupUsageRows([agent("a", "claude-code", win(100), win(300))], machine(1000, 5000, { "claude-code": [1000, 5000] }));
    expect(rows.map((r) => [r.key, r.label])).toEqual([
      ["all", "这台机器合计"],
      ["agents", "agent 当前会话"],
      ["others", "其他会话"],
    ]);
    const others = rows.find((r) => r.key === "others")!;
    expect(others.today.tokens).toBe(900);
    expect(others.week.tokens).toBe(4700);
  });

  test("其他会话不为负（合计与 agent 行不是同一时刻算的）", () => {
    const rows = groupUsageRows([agent("a", "claude-code", win(500, 2), win(900, 3))], machine(400, 800));
    const others = rows.find((r) => r.key === "others")!;
    expect(others.today).toEqual({ tokens: 0, costUsd: 0, reportedCostUsd: 0 });
    expect(others.week.tokens).toBe(0);
  });

  test("多个 runtime：按全机的 byRuntime 分行，不是按 agent", () => {
    const rows = groupUsageRows([agent("a", "claude-code", win(1))], machine(30, 60, { codex: [10, 20], "claude-code": [20, 40] }));
    expect(rows.map((r) => r.key)).toEqual(["all", "claude-code", "codex", "agents", "others"]);
    expect(rows[0].week.tokens).toBe(60);
    expect(rows.find((r) => r.key === "codex")!.week.tokens).toBe(20);
  });

  test("没有 agent（全在终端里开的）也有合计与其他会话", () => {
    const rows = groupUsageRows([], machine(10, 20));
    expect(rows.find((r) => r.key === "others")!.week.tokens).toBe(20);
  });
});

describe("weekColumnNote", () => {
  test("周额度周期写起点（本地时间），滚动写近 7 天，老 bridge 空", () => {
    const start = new Date(2026, 8, 23, 6, 0).getTime();
    expect(weekColumnNote({ weekStart: start, weekSource: "quota" }, false)).toBe("自 9/23 06:00");
    expect(weekColumnNote({ weekStart: start, weekSource: "quota" }, true)).toBe("since 9/23 06:00");
    expect(weekColumnNote({ weekStart: start, weekSource: "rolling" }, false)).toBe("近 7 天");
    expect(weekColumnNote(undefined, false)).toBe("");
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
    const [big] = groupUsageRows([agent("a", "claude-code", win(3_287_900_000, 2142.2))]);
    expect(fmtUsageCell(big, "today")).toBe("3.29B · $2142.20");
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

describe("usageTableData", () => {
  test("老 bridge 没有 machine / window；形态不对的一律当没有", () => {
    expect(usageTableData({})).toEqual({ agents: [], machine: null, window: null });
    expect(usageTableData({ agents: "x", machine: [1], window: 3 })).toEqual({ agents: [], machine: null, window: null });
    const m = { today: { tokens: 1 } };
    expect(usageTableData({ agents: [], machine: m, window: { weekStart: 1 } }).machine).toBe(m);
  });
});
