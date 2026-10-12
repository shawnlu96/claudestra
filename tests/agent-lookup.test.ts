/**
 * LST-2：manager list 失败（超时 / 崩溃）时，route_to_agent 与 /api/v1 的 agent 查找要报「不可用、可重试」，
 * 不能冒充「目标不存在」；list 成功但确实没有目标时行为不变（no_target / null → 404）。
 */
import { describe, expect, test } from "bun:test";
import { findListedAgent, lookupRouteTarget } from "../src/bridge/agent-lookup.ts";
import { interpretManagerRun, ListUnavailableError } from "../src/lib/run-manager.ts";

const timedOut = interpretManagerRun({ cmd: "list", out: "", err: "", exitCode: null, timedOut: true, budgetMs: 15_000 });
const okList = { ok: true, agents: [{ name: "agent-alpha", channelId: "c1" }, { name: "agent-bravo", channelId: "c2" }] };

describe("lookupRouteTarget（route_to_agent）", () => {
  test("list 超时 → list_unavailable，不是 no_target", () => {
    const r = lookupRouteTarget(timedOut, "alpha");
    expect(r).toMatchObject({ rejected: "list_unavailable" });
    expect((r as { error: string }).error).toContain("超时");
  });

  test("list 无输出 / 非 JSON 失败同样是 list_unavailable", () => {
    expect(lookupRouteTarget(undefined, "alpha")).toMatchObject({ rejected: "list_unavailable" });
    expect(lookupRouteTarget({ ok: false, error: "exit=1" }, "alpha")).toMatchObject({ rejected: "list_unavailable" });
  });

  test("list 成功但目标不存在 → no_target（行为不变）", () => {
    expect(lookupRouteTarget(okList, "charlie")).toEqual({ error: "Agent 'agent-charlie' 不存在或未在 registry 中", rejected: "no_target" });
  });

  test("命中目标：带不带 agent- 前缀都行，agents 原样给出（补 fromName 用）", () => {
    for (const raw of ["bravo", "agent-bravo"]) {
      const r = lookupRouteTarget(okList, raw);
      expect(r).toMatchObject({ targetName: "agent-bravo", target: { channelId: "c2" } });
      expect((r as { agents: unknown[] }).agents).toHaveLength(2);
    }
  });
});

describe("findListedAgent（/api/v1 findApiAgent）", () => {
  test("list 超时 → 抛 ListUnavailableError（交给 apiErrorResponse 回 503），不是 null（404）", () => {
    expect(() => findListedAgent(timedOut, "alpha")).toThrow(ListUnavailableError);
  });

  test("list 成功但没有 → null（路由照旧 404）", () => {
    expect(findListedAgent(okList, "charlie")).toBeNull();
  });

  test("名字带不带 agent- 前缀都能找到", () => {
    expect(findListedAgent(okList, "alpha")?.channelId).toBe("c1");
    expect(findListedAgent(okList, "agent-alpha")?.channelId).toBe("c1");
  });
});
