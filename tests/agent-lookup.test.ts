/**
 * LST-2：manager list 失败（超时 / 崩溃）时，route_to_agent 与 /api/v1 的 agent 查找要报「不可用、可重试」，
 * 不能冒充「目标不存在」；list 成功但确实没有目标时行为不变（no_target / null → 404）。
 */
import { describe, expect, test } from "bun:test";
import { findListedAgent, listForRoute, lookupRouteTarget, routeLookupOrReject } from "../src/bridge/agent-lookup.ts";
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

  test("list 输出 ok:true 却缺 agents 数组（坏输出）→ list_unavailable，不当成空列表报 no_target", () => {
    expect(lookupRouteTarget({ ok: true }, "alpha")).toMatchObject({ rejected: "list_unavailable" });
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

describe("routeLookupOrReject（route_to_agent 入口）", () => {
  const frames = () => {
    const sent: any[] = [];
    return { sent, ws: { send: (d: string) => sent.push(JSON.parse(d)) } };
  };

  test("list 调用本身抛错（spawn 失败）→ 投递前回 list_unavailable 拒绝帧，不冒到外层 catch", async () => {
    const f = frames();
    const r = await routeLookupOrReject(f.ws, "req1", "alpha", async () => { throw new Error("spawn failed"); });
    expect(r).toBeNull();
    expect(f.sent).toEqual([{ type: "response", requestId: "req1", error: expect.stringContaining("spawn failed"), rejected: "list_unavailable" }]);
  });

  test("命中目标不发帧，交回 bridge.ts 继续投递", async () => {
    const f = frames();
    expect(await routeLookupOrReject(f.ws, "req2", "alpha", async () => okList)).toMatchObject({ targetName: "agent-alpha" });
    expect(f.sent).toEqual([]);
  });
});

describe("findListedAgent（/api/v1 findApiAgent）", () => {
  test("list 超时 / 抛错 / 缺 agents → 抛 ListUnavailableError（交给 apiErrorResponse 回 503），不是 null（404）", async () => {
    await expect(findListedAgent(async () => timedOut, "alpha")).rejects.toBeInstanceOf(ListUnavailableError);
    await expect(findListedAgent(async () => { throw new Error("spawn failed"); }, "alpha")).rejects.toBeInstanceOf(ListUnavailableError);
    await expect(findListedAgent(async () => ({ ok: true }), "alpha")).rejects.toBeInstanceOf(ListUnavailableError);
  });

  test("list 成功但没有 → null（路由照旧 404）", async () => {
    expect(await findListedAgent(async () => okList, "charlie")).toBeNull();
  });

  test("名字带不带 agent- 前缀都能找到", async () => {
    expect((await findListedAgent(async () => okList, "alpha"))?.channelId).toBe("c1");
    expect((await findListedAgent(async () => okList, "agent-alpha"))?.channelId).toBe("c1");
  });
});

describe("listForRoute（LSC-1：route_to_agent 等共享缓存有上限）", () => {
  test("缓存迟迟不回：预算到点按「不可用」拒，不冒充 no_target", async () => {
    const t0 = Date.now();
    const r = await listForRoute(() => new Promise(() => {}), 30);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(lookupRouteTarget(r, "alpha")).toMatchObject({ rejected: "list_unavailable" });
  });

  test("预算内回来的名单照常用", async () => {
    expect(await listForRoute(async () => okList, 1_000)).toEqual(okList);
  });
});
