/**
 * i28-PMSW2 侧栏 project 菜单「主管 PM」二级页的纯逻辑（web/features/chat/components/project-pm-model.ts）。
 * 菜单真实渲染（显示条件、确认 / 失败流程）见 tests/web-dom-project-pm.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { checkPm, confirmPm, pmPageRows, pmProblemRows, pmProblems, pmRows, runtimeLabel } from "@/features/chat/components/project-pm-model";
import type { PmSwitchResult, ProjectPmView } from "@/lib/api/project-pm";

// API 夹具：执行者形态的 agent 由后端排除，夹具里就没有；网页不再过滤
const VIEW: ProjectPmView = {
  active: "pm-a",
  candidates: [
    { name: "pm-a", runtime: "claude-code", online: true, registered: true },
    { name: "pm-b", runtime: "codex", online: false, registered: true },
    { name: "helper", runtime: "pi", online: true, registered: false },
  ],
};

describe("候选列表", () => {
  test("按 API 返回原样排序渲染，当前 PM 打勾，副标题 runtime + 在线状态", () => {
    expect(pmRows(VIEW)).toEqual([
      { name: "pm-a", current: true, runtime: "Claude", status: "在线" },
      { name: "pm-b", current: false, runtime: "Codex", status: "离线" },
      { name: "helper", current: false, runtime: "Pi", status: "在线" },
    ]);
  });
  test("网页不自己过滤：API 给什么就列什么（含名字像执行者的项）", () => {
    const v: ProjectPmView = { active: null, candidates: [{ name: "lend-x", runtime: "claude-code", online: true, registered: true }] };
    expect(pmRows(v).map((r) => r.name)).toEqual(["lend-x"]);
    expect(pmRows(v)[0].current).toBe(false);
  });
  test("runtime 文案：未知值按 Claude", () => {
    expect(runtimeLabel("claude-code")).toBe("Claude");
    expect(runtimeLabel("codex")).toBe("Codex");
    expect(runtimeLabel("weird")).toBe("Claude");
  });
  test("行数：返回 + 候选（至少一行）+ 确认 / 取消 + 问题", () => {
    expect(pmPageRows(null, null)).toBe(2);
    expect(pmPageRows(VIEW, null)).toBe(4);
    expect(pmPageRows(VIEW, { agent: "pm-b", check: "failed", problems: ["x", "y"] })).toBe(8);
    // 长问题折行：按估算多占半行 / 折行，定位时菜单高度不会被低估
    const long = "peer p1 lacks a PM agent destination in peer-prs";
    expect(pmProblemRows("x")).toBe(1);
    expect(pmProblemRows(long)).toBe(2);
    expect(pmPageRows(VIEW, { agent: "pm-b", check: "failed", problems: [long] })).toBe(8);
  });
});

describe("体检与切换", () => {
  const recorder = (results: PmSwitchResult[]) => {
    const calls: { agent: string; dryRun: boolean }[] = [];
    const events: string[] = [];
    return {
      calls,
      events,
      deps: {
        post: async (agent: string, dryRun: boolean) => {
          calls.push({ agent, dryRun });
          return results.shift()!;
        },
        close: () => events.push("close"),
        flash: (agent: string) => events.push(`flash:${agent}`),
      },
    };
  };
  test("体检问题逐条拆开（后端 \"; \" 与 manager 的「；」）", () => {
    expect(pmProblems("pm-b is offline; peer p1 token t1 lacks pm-b")).toEqual(["pm-b is offline", "peer p1 token t1 lacks pm-b"]);
    expect(pmProblems("a；b")).toEqual(["a", "b"]);
    expect(pmProblems("")).toEqual(["操作失败"]);
  });
  test("体检全绿 → 放行；不全绿 → 列问题、不放行，且只发 dryRun", async () => {
    const ok = recorder([{ ok: true }]);
    expect(await checkPm("pm-b", ok.deps)).toEqual({ agent: "pm-b", check: "ok", problems: [] });
    const bad = recorder([{ ok: false, status: 400, error: "pm-b is offline; dispatcher cannot become active PM" }]);
    expect(await checkPm("pm-b", bad.deps)).toEqual({ agent: "pm-b", check: "failed", problems: ["pm-b is offline", "dispatcher cannot become active PM"] });
    expect([...ok.calls, ...bad.calls].every((c) => c.dryRun)).toBe(true);
    expect([...ok.events, ...bad.events]).toEqual([]);
  });
  test("确认：真 POST 一次，成功后关菜单并提示", async () => {
    const r = recorder([{ ok: true }]);
    expect(await confirmPm("pm-b", r.deps)).toBeNull();
    expect(r.calls).toEqual([{ agent: "pm-b", dryRun: false }]);
    expect(r.events).toEqual(["close", "flash:pm-b"]);
  });
  test("确认失败（403 / 体检不过）：原因留在菜单里，不关菜单、不提示", async () => {
    for (const fail of [
      { ok: false, status: 403, error: "project PM requires manage authorization" },
      { ok: false, status: 400, error: "pm-b is offline" },
    ] as PmSwitchResult[]) {
      const r = recorder([fail]);
      const c = await confirmPm("pm-b", r.deps);
      expect(c?.check).toBe("failed");
      expect(c?.problems.length).toBe(1);
      expect(r.calls.length).toBe(1);
      expect(r.events).toEqual([]);
    }
  });
});
