import { describe, expect, test } from "bun:test";
import { createSessionInfo, createThought, createToolTracker } from "../src/lib/acp/tui/live.ts";

// 底栏里正在发生的：工具（段 + 紧跟的原始更新配对）、思考预览、状态栏信息

describe("工具配对", () => {
  test("工具段挂起 → 紧跟的 tool_call 带来 id 和 kind → 结果段配同 id 的 tool_call_update 定稿", () => {
    const t = createToolTracker(() => 0);
    t.start("Bash", "ls");
    expect(t.update({ sessionUpdate: "tool_call", toolCallId: "c1", kind: "execute", status: "in_progress" })).toEqual([]);
    expect(t.running()).toMatchObject([{ id: "c1", kind: "execute", status: "running" }]);
    t.result("  ⎿ 3 行输出");
    expect(t.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" }))
      .toEqual([{ tool: { id: "c1", name: "Bash", arg: "ls", kind: "execute", status: "ok", since: 0 }, result: "  ⎿ 3 行输出" }]);
    expect(t.running()).toEqual([]);
  });

  test("并行的两个工具：后启动的先结束，按 id 配对不串", () => {
    const t = createToolTracker(() => 0);
    t.start("Bash", "a");
    t.update({ sessionUpdate: "tool_call", toolCallId: "a", status: "in_progress" });
    t.start("Bash", "b");
    t.update({ sessionUpdate: "tool_call", toolCallId: "b", status: "in_progress" });
    t.result("  ⎿ ✗ b 挂了");
    const [done] = t.update({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed" });
    expect(done).toMatchObject({ tool: { arg: "b", status: "fail" } });
    expect(t.running().map((x) => x.arg)).toEqual(["a"]);
  });

  test("没有更新跟着的结果段配最早那个在跑的；回合结束还挂着的按未完成落下", () => {
    const t = createToolTracker(() => 0);
    t.start("Read", "x");
    t.start("Read", "y");
    t.result("  ⎿ 无输出");
    expect(t.orphans()).toMatchObject([{ tool: { arg: "x", status: "ok" } }]);
    expect(t.endTurn()).toMatchObject([{ tool: { arg: "y", status: "lost" } }]);
    expect(t.running()).toEqual([]);
  });

  test("一条更新里起头又结束（tool_call 直接 completed）也配得上", () => {
    const t = createToolTracker(() => 0);
    t.start("Bash", "true");
    t.result("  ⎿ 无输出");
    expect(t.update({ sessionUpdate: "tool_call", toolCallId: "z", status: "completed" })).toMatchObject([{ tool: { arg: "true", status: "ok" } }]);
  });
});

describe("思考预览", () => {
  test("只显示最后一整行，半行不显示（可能是半个密钥）", () => {
    const th = createThought();
    th.add("先看 diff。\n再看测");
    expect(th.preview()).toBe("先看 diff。");
    th.add("试。\n");
    expect(th.preview()).toBe("再看测试。");
  });

  test("跨行的密钥规则也打得上码（Bearer 换行接长串）", () => {
    const th = createThought();
    th.add(`Authorization: Bearer\n${"a1B2c3D4e5".repeat(4)}\n`);
    expect(th.preview()).not.toContain("a1B2c3D4e5a1B2");
  });
});

describe("状态栏信息：只认标准事件", () => {
  test("用量、配置、压缩中；同样的值不算变化", () => {
    const i = createSessionInfo();
    expect(i.update({ sessionUpdate: "usage_update", used: 1000, size: 4000 })).toBe(true);
    expect(i.update({ sessionUpdate: "usage_update", used: 1000, size: 4000 })).toBe(false);
    expect(i.update({ sessionUpdate: "config_option_update", configOptions: [
      { id: "model", currentValue: "openai/gpt-5", options: [{ value: "openai/gpt-5" }] },
      { id: "reasoning_effort", currentValue: "high", options: [{ value: "high" }] }] })).toBe(true);
    expect(i.update({ sessionUpdate: "compaction_update", compactionId: "k", status: "in_progress" })).toBe(true);
    expect(i.get()).toEqual({ compacting: true, ctx: { used: 1000, size: 4000 }, model: "openai/gpt-5", effort: "high" });
    i.update({ sessionUpdate: "compaction_update", compactionId: "k", status: "completed" });
    expect(i.get().compacting).toBe(false);
  });
});
