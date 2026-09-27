/**
 * /api/v1/agents/:name/{info,external} 的鉴权与「共享中关闭须确认」分支（src/bridge/agent-info-routes.ts）。
 * registry / principals 用注入的假数据，runManager 用记录器——不碰真实状态文件，也不起 bridge。
 */
import { describe, expect, test } from "bun:test";
import { handleAgentInfoRoutes, type AgentInfoIo } from "../src/bridge/agent-info-routes";
import type { Principal } from "../src/lib/principals";

const now = "2026-09-27T00:00:00.000Z";
const owner: Principal = { id: "token:tok_owner", role: "owner", agents: ["*", "master"], createdAt: now };
const scoped: Principal = { id: "token:tok_scoped", role: "external", agents: ["open", "priv"], createdAt: now };
/** 老版本能给 peer 签 "*"：光看 isFullScope 它是「全权」，但 peer 不该看到本机路径 / sessionId */
const peerStar: Principal = { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: now };

const io: AgentInfoIo = {
  readRegistryAgents: async () => [
    { name: "agent-open", external: true, cwd: "/tmp/open", sessionId: "s1", channelId: "c1", status: "active", purpose: "demo" },
    { name: "agent-priv", external: false },
  ],
  readPrincipals: async () => ({
    principals: [
      { id: "token:tok_a", role: "external", agents: ["open"], peer: "A", createdAt: now },
      { id: "token:tok_b", role: "external", agents: ["*"], peer: "B", createdAt: now },
      { id: "token:tok_c", role: "external", agents: ["open"], peer: "C", disabled: true, createdAt: now },
      { id: "token:tok_d", role: "external", agents: ["open"], createdAt: now },
    ],
  }),
};

function req(method: string, body?: unknown): Request {
  return new Request("http://bridge.test/api/v1", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** runManager 记录器：默认回 ok，调用参数留在 calls 里 */
function recorder(result: unknown = { ok: true, agent: "open", external: false, removedFromPeers: ["A"], stillSharedWith: ["B"] }) {
  const calls: string[][] = [];
  const run = async (...args: string[]) => {
    calls.push(args);
    return result;
  };
  return { run, calls };
}

const call = (p: Principal, path: string, r: Request, run = recorder().run) => handleAgentInfoRoutes(r, path, p, run, io);
const json = async (res: Response | null) => ({ status: res!.status, body: (await res!.json()) as Record<string, any> });

describe("agent-info-routes：鉴权", () => {
  test("不是这两条路由 → null（交给下一个 handler）", async () => {
    expect(await call(owner, "/agents/open/history", req("GET"))).toBeNull();
    expect(await call(owner, "/agents/open", req("GET"))).toBeNull();
  });
  test("scoped token：info / external 都 403，且不触发 runManager，也不泄露 agent 是否存在", async () => {
    const rec = recorder();
    expect((await json(await call(scoped, "/agents/open/info", req("GET"), rec.run))).status).toBe(403);
    expect((await json(await call(scoped, "/agents/open/external", req("POST", { on: true }), rec.run))).status).toBe(403);
    expect((await json(await call(scoped, "/agents/ghost/info", req("GET"), rec.run))).status).toBe(403);
    expect(rec.calls).toEqual([]);
  });
  test("peer token 即便 scope 是 \"*\" 也 403", async () => {
    const rec = recorder();
    expect((await json(await call(peerStar, "/agents/open/info", req("GET"), rec.run))).status).toBe(403);
    expect((await json(await call(peerStar, "/agents/open/external", req("POST", { on: false, confirm: "open" }), rec.run))).status).toBe(403);
    expect(rec.calls).toEqual([]);
  });
});

describe("agent-info-routes：GET info", () => {
  test("全权 token：回 registry 字段 + 正在共享的 peer（禁用的、非 peer 的 token 不算；\"*\" 算）", async () => {
    const { status, body } = await json(await call(owner, "/agents/open/info", req("GET")));
    expect(status).toBe(200);
    expect(body.agent).toMatchObject({ name: "open", cwd: "/tmp/open", sessionId: "s1", channelId: "c1", external: true, purpose: "demo", runtime: "claude-code" });
    expect(body.agent.sharedWith).toEqual(["A", "B"]);
  });
  test("带 agent- 前缀 / URL 编码的名字都归一到裸名", async () => {
    expect((await json(await call(owner, "/agents/agent-open/info", req("GET")))).body.agent.name).toBe("open");
    expect((await json(await call(owner, "/agents/agent%2Dopen/info", req("GET")))).body.agent.name).toBe("open");
  });
  test("master 400、不存在 404、错误方法 405", async () => {
    expect((await json(await call(owner, "/agents/master/info", req("GET")))).status).toBe(400);
    expect((await json(await call(owner, "/agents/agent-master/info", req("GET")))).status).toBe(400);
    expect((await json(await call(owner, "/agents/ghost/info", req("GET")))).status).toBe(404);
    expect((await json(await call(owner, "/agents/open/info", req("POST", {})))).status).toBe(405);
    expect((await json(await call(owner, "/agents/open/external", req("GET")))).status).toBe(405);
  });
});

describe("agent-info-routes：POST external", () => {
  test("开启不需要确认，直接走 runManager external <name> on", async () => {
    const rec = recorder({ ok: true });
    expect((await json(await call(owner, "/agents/open/external", req("POST", { on: true }), rec.run))).status).toBe(200);
    expect(rec.calls).toEqual([["external", "open", "on"]]);
  });
  test("共享中关闭：没带 / 带错 confirm → 409 needConfirm + sharedWith，runManager 不被调", async () => {
    const rec = recorder();
    const wrong: unknown[] = [undefined, "", "Open", " open", "open ", "agent-open", true];
    for (const confirm of wrong) {
      const body = confirm === undefined ? { on: false } : { on: false, confirm };
      const { status, body: b } = await json(await call(owner, "/agents/open/external", req("POST", body), rec.run));
      expect(status).toBe(409);
      expect(b.needConfirm).toBe(true);
      expect(b.sharedWith).toEqual(["A", "B"]);
    }
    expect(rec.calls).toEqual([]);
  });
  test("confirm 逐字符等于会话名 → 执行，并原样透传 manager 的 removedFromPeers / stillSharedWith", async () => {
    const rec = recorder();
    const { status, body } = await json(await call(owner, "/agents/open/external", req("POST", { on: false, confirm: "open" }), rec.run));
    expect(status).toBe(200);
    expect(rec.calls).toEqual([["external", "open", "off"]]);
    expect(body.removedFromPeers).toEqual(["A"]);
    expect(body.stillSharedWith).toEqual(["B"]);
  });
  test("持 \"*\" 的 peer 也算在共享：关闭任何 agent 都要确认；没有任何 peer 能访问时关闭不需要确认", async () => {
    const rec = recorder({ ok: true });
    const r = await json(await call(owner, "/agents/priv/external", req("POST", { on: false }), rec.run));
    expect(r.status).toBe(409);
    expect(r.body.sharedWith).toEqual(["B"]);
    const noStar: AgentInfoIo = { ...io, readPrincipals: async () => ({ principals: (await io.readPrincipals()).principals.filter((p) => p.peer !== "B") }) };
    expect((await json(await handleAgentInfoRoutes(req("POST", { on: false }), "/agents/priv/external", owner, rec.run, noStar))).status).toBe(200);
    expect(rec.calls).toEqual([["external", "priv", "off"]]);
  });
  test("manager 报错 → 400 透传；坏 JSON → 400 invalid JSON body", async () => {
    const rec = recorder({ ok: false, error: "boom" });
    const r1 = await json(await call(owner, "/agents/priv/external", req("POST", { on: true }), rec.run));
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe("boom");
    const r2 = await json(await call(owner, "/agents/priv/external", req("POST", "{not json")));
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe("invalid JSON body");
  });
});
