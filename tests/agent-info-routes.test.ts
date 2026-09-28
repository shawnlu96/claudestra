/**
 * /api/v1/agents/:name/{info,external} 的鉴权与「共享中关闭须确认」分支（src/bridge/agent-info-routes.ts）。
 * registry / principals 用注入的假数据，runManager 用记录器——不碰真实状态文件，也不起 bridge。
 */
import { describe, expect, spyOn, test } from "bun:test";
import { agentListExtras, handleAgentInfoRoutes, type AgentInfoIo } from "../src/bridge/agent-info-routes";
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

describe("agent-info-routes：POST label", () => {
  test("全权 token → runManager label <name> <text>；label 不是字符串 → 400；peer / scoped → 403 且不调 manager", async () => {
    const rec = recorder({ ok: true, label: "我的前端" });
    expect((await json(await call(owner, "/agents/open/label", req("POST", { label: "我的前端" }), rec.run))).status).toBe(200);
    expect(rec.calls).toEqual([["label", "open", "我的前端"]]);
    expect((await json(await call(owner, "/agents/open/label", req("POST", { label: 3 }), rec.run))).status).toBe(400);
    expect((await json(await call(peerStar, "/agents/open/label", req("POST", { label: "x" }), rec.run))).status).toBe(403);
    expect((await json(await call(scoped, "/agents/open/label", req("POST", { label: "x" }), rec.run))).status).toBe(403);
    expect(rec.calls).toHaveLength(1);
  });
});

describe("agentListExtras（GET /agents 的附加字段）", () => {
  test("external / label 人人可见；sharedPeers 只给全权非 peer（谁在共享是 owner 的事）", async () => {
    const own = await agentListExtras(owner, io);
    expect(own("agent-open", { external: true, label: "L" })).toMatchObject({ external: true, label: "L", sharedPeers: 2, sharedWith: ["A", "B"] });
    expect(own("agent-priv", {})).toMatchObject({ external: false, label: null, sharedPeers: 1, sharedWith: ["B"] }); // "*" peer 也算
    for (const p of [peerStar, scoped]) {
      const x = (await agentListExtras(p, io))("agent-open", { external: true });
      expect(x.external).toBe(true);
      expect(x.sharedPeers).toBeUndefined();
      expect(x.sharedWith).toBeUndefined(); // peer 名单同一道门：peer / 受限 token 看不到谁在共享
    }
  });
  test("进行中的值守随列表下发（按去前缀的名字对）；已结束的不发；peer 看不到", async () => {
    const until = "2026-09-28T02:00:00.000Z";
    const withMissions = {
      ...io,
      readMissions: async () => ({
        open: { agent: "open", goal: "g", until, createdAt: until, status: "active" as const, nudges: 2, fastTurns: 0, resumeAt: until },
        priv: { agent: "priv", goal: "g", until, createdAt: until, status: "done" as const, nudges: 5, fastTurns: 0 },
      }),
    };
    const own = await agentListExtras(owner, withMissions);
    expect(own("agent-open", {}).mission).toEqual({ goal: "g", until, nudges: 2, resumeAt: until });
    expect(own("agent-priv", {}).mission).toBeUndefined();
    expect((await agentListExtras(peerStar, withMissions))("agent-open", {}).mission).toBeUndefined();
  });
  test("排队中的消息数按频道对上；没排队不带字段；peer 看不到", async () => {
    const withHeld = { ...io, heldCounts: () => ({ "c-open": 3 }) };
    const own = await agentListExtras(owner, withHeld);
    expect(own("agent-open", { channelId: "c-open" }).queued).toBe(3);
    expect(own("agent-priv", { channelId: "c-priv" }).queued).toBeUndefined();
    expect((await agentListExtras(peerStar, withHeld))("agent-open", { channelId: "c-open" }).queued).toBeUndefined();
  });
  test("派发关系：parent 输出裸名，大总管输出 master；task 原样给", async () => {
    const own = await agentListExtras(owner, io);
    expect(own("agent-t1", { parent: "agent-open", task: "T1 沙箱" })).toMatchObject({ parent: "open", task: "T1 沙箱" });
    expect(own("agent-t2", { parent: "master" }).parent).toBe("master");
    const none = own("agent-priv", {});
    expect("parent" in none || "task" in none).toBe(false); // 普通 agent 不带这两个键
  });
  test("parent 只在调用方看得到派发者时下发：scope 外的派发者名不泄露，task 照给", async () => {
    const x = (await agentListExtras(scoped, io))("agent-open", { parent: "agent-boss", task: "T" });
    expect(x.parent).toBeUndefined();
    expect(x.task).toBe("T");
    expect((await agentListExtras(scoped, io))("agent-open", { parent: "agent-priv" }).parent).toBe("priv");
    // "*" 不含大总管：scope 里没显式列 master 就不下发 parent=master
    const star: Principal = { id: "token:tok_star", role: "external", agents: ["*"], createdAt: now };
    expect((await agentListExtras(star, io))("agent-open", { parent: "master" }).parent).toBeUndefined();
  });
  test("peer 拿不到 parent 与 task（即便派发者在它的 scope 里）", async () => {
    const x = (await agentListExtras(peerStar, io))("agent-open", { parent: "agent-priv", task: "T" });
    expect(x.parent).toBeUndefined();
    expect(x.task).toBeUndefined();
  });
  test("ledgerTask（台账执行中的任务）只给 canReadLedger，与 T4 的 parent / task 并存；别人连库都不查", async () => {
    let calls = 0;
    const withLedger = { ...io, ledgerTasks: () => (calls++, new Map([["t8c", { id: "T8c", stage: "review" as const, round: 2 }]])) };
    const own = await agentListExtras(owner, withLedger);
    expect(own("agent-t8c", { parent: "agent-open", task: "T8c 读接口" })).toMatchObject({ parent: "open", task: "T8c 读接口", ledgerTask: { id: "T8c", stage: "review", round: 2 } });
    expect(own("t8c", {}).ledgerTask).toEqual({ id: "T8c", stage: "review", round: 2 }); // 裸名也对得上
    expect("ledgerTask" in own("agent-open", {})).toBe(false);
    expect(calls).toBe(1); // 一次列表只查一次库
    const partialOwner: Principal = { ...owner, agents: ["t8c"], manage: true, credential: "dev_p" };
    for (const p of [scoped, peerStar, partialOwner]) {
      expect((await agentListExtras(p, withLedger))("agent-t8c", {}).ledgerTask).toBeUndefined();
    }
    expect(calls).toBe(1);
  });
  test("读台账出错：列表照常出，只是不带 ledgerTask；库坏着时反复刷列表只报一次，恢复再报一次", async () => {
    const broken = { ...io, ledgerTasks: () => { throw new Error("database is locked"); } };
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const logs = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i++) {
        const x = (await agentListExtras(owner, broken))("agent-t8c", { task: "T" });
        expect(x.task).toBe("T");
        expect(x.ledgerTask).toBeUndefined();
      }
      expect(errors).toHaveBeenCalledTimes(1);
      const ok = { ...io, ledgerTasks: () => new Map() };
      await agentListExtras(owner, ok);
      await agentListExtras(owner, ok);
      expect(logs.mock.calls.filter((c) => String(c[0]).includes("恢复")).length).toBe(1);
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });
});
