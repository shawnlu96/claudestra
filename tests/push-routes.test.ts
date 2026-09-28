/**
 * 推送 / 未读端点（src/bridge/push/routes.ts）：只给 owner 或过渡期全 scope token；订阅校验 + SSRF；
 * unread / read / reads 的形状按契约 §13.3；未登记时 503；不相干路径返回 null。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Principal } from "../src/lib/principals.js";
import { listApnsDevices, listPushSubscriptions } from "../src/lib/push-store.js";
import { bumpUnread, markAgentRead, onAgentRead } from "../src/lib/unread-store.js";
import { closeWebState, openWebState } from "../src/lib/web-state.js";
import { createPushRoutes, pushRoutes } from "../src/bridge/push/routes.js";
import type { PushSender } from "../src/bridge/push/sender.js";
import type { ExtensionHandler } from "../src/bridge/api-extensions.js";

const owner: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "" };
const legacy: Principal = { id: "token:tok_web", role: "external", name: "web-ui", agents: ["*"], createdAt: "" };
const guest: Principal = { id: "guest:1", role: "external", agents: ["alpha"], createdAt: "" };
const peer: Principal = { id: "token:tok_p", role: "external", agents: ["*"], createdAt: "", peer: "other" };
const noManage: Principal = { ...owner, manage: false };
const sender: PushSender = {
  webPushKeys: () => ["PUB", "OTHER"],
  config: () => ({ mode: "direct", webPush: { vapidPublicKey: "PUB" }, apns: false }),
  sendWebPush: async () => ({ ok: true, gone: false }),
  sendApns: async () => ({ ok: true, gone: false }),
};
let db = openWebState(":memory:");
let handler: ExtensionHandler;
const SUB = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } };

const call = (h: ExtensionHandler, method: string, path: string, body?: unknown, p: Principal = owner, headers: Record<string, string> = {}) => {
  const url = new URL(`http://bridge${path}`);
  const req = new Request(url.toString(), { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return h(req, url, p);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response | null): Promise<{ status: number; body: any }> => ({ status: r!.status, body: await r!.json() });

beforeEach(() => {
  closeWebState(":memory:");
  db = openWebState(":memory:");
  handler = createPushRoutes({ db, sender, liveAgents: async () => ["alpha", "beta"] });
});
afterEach(() => closeWebState(":memory:"));

describe("门", () => {
  test("不相干路径 → null（交给 api-routes）；owner 与全 scope 老 token 放行；guest / peer / manage=false 的凭据 403", async () => {
    expect(await call(handler, "GET", "/api/v1/agents")).toBeNull();
    expect(await call(handler, "GET", "/api/v1/agents/alpha/messages")).toBeNull();
    expect((await call(handler, "GET", "/api/v1/push/config"))!.status).toBe(200);
    expect((await call(handler, "GET", "/api/v1/push/config", undefined, legacy))!.status).toBe(200);
    for (const p of [guest, peer, noManage]) {
      expect((await call(handler, "GET", "/api/v1/unread", undefined, p))!.status).toBe(403);
      expect((await call(handler, "POST", "/api/v1/agents/alpha/read", {}, p))!.status).toBe(403);
    }
  });
  test("已登记的 handler 在 configurePushRoutes 之前：自己的路径 503，别的 null", async () => {
    expect(await json(await call(pushRoutes, "GET", "/api/v1/push/config"))).toMatchObject({ status: 503, body: { error: "push not initialized" } });
    expect(await call(pushRoutes, "GET", "/api/v1/agents")).toBeNull();
  });
});

describe("guest 设备的 Web Push 订阅（T11b：只收指派给自己的「待你处理」）", () => {
  const guestDev: Principal = { ...guest, credential: "dev_g1" };
  const ownerDev: Principal = { ...owner, credential: "dev_o" };
  test("guest 设备：能看 config、订阅（记成 guest + principal + 凭据）；未读、已读、APNs 仍 403；没设备凭据的 guest、peer 连订阅也不行", async () => {
    expect((await call(handler, "GET", "/api/v1/push/config", undefined, guestDev))!.status).toBe(200);
    expect((await call(handler, "POST", "/api/v1/push/subscriptions", { subscription: SUB }, guestDev))!.status).toBe(200);
    expect(listPushSubscriptions(db)).toMatchObject([{ endpoint: SUB.endpoint, audience: "guest", principal: "guest:1", credential: "dev_g1" }]);
    for (const [m, path] of [["GET", "/api/v1/unread"], ["GET", "/api/v1/reads"], ["POST", "/api/v1/agents/alpha/read"], ["POST", "/api/v1/push/apns"]] as const) {
      expect((await call(handler, m, path, {}, guestDev))!.status).toBe(403);
    }
    for (const p of [guest, { ...peer, credential: "dev_p" }]) expect((await call(handler, "POST", "/api/v1/push/subscriptions", { subscription: SUB }, p))!.status).toBe(403);
  });
  test("guest 盖不掉 owner 的订阅、也删不掉", async () => {
    await call(handler, "POST", "/api/v1/push/subscriptions", { subscription: SUB }, ownerDev);
    await call(handler, "POST", "/api/v1/push/subscriptions", { subscription: SUB }, guestDev);
    expect(listPushSubscriptions(db)).toMatchObject([{ audience: "owner", principal: "owner:self", credential: "dev_o" }]);
    expect(await json(await call(handler, "DELETE", "/api/v1/push/subscriptions", { endpoint: SUB.endpoint }, guestDev))).toEqual({ status: 200, body: { ok: true, removed: false } });
    expect(listPushSubscriptions(db)).toHaveLength(1);
  });
});

describe("推送订阅", () => {
  test("config 形状；订阅 upsert（userAgent 优先于头）、SSRF 拒、形状拒；删除", async () => {
    expect(await json(await call(handler, "GET", "/api/v1/push/config"))).toEqual({ status: 200, body: { mode: "direct", webPush: { vapidPublicKey: "PUB" }, apns: false } });
    const post = (body: unknown) => call(handler, "POST", "/api/v1/push/subscriptions", body, owner, { "user-agent": "UA-header" });
    expect(await json(await post({ subscription: SUB, userAgent: "UA-body" }))).toEqual({ status: 200, body: { ok: true } });
    expect(await json(await post({ subscription: { ...SUB, endpoint: "https://web.push.apple.com/def" } }))).toEqual({ status: 200, body: { ok: true } });
    expect(listPushSubscriptions(db).map((s) => s.ua).sort()).toEqual(["UA-body", "UA-header"]);
    // 浏览器报的公钥：本机签得了才认，否则（或不报）按 config 此刻给出的那把记
    const keyOf = async (vapidKey: unknown) => {
      await post({ subscription: SUB, vapidKey });
      return listPushSubscriptions(db).find((s) => s.endpoint === SUB.endpoint)?.vapidKey;
    };
    expect(await keyOf("OTHER")).toBe("OTHER");
    expect(await keyOf("FORGED")).toBe("PUB");
    expect(await keyOf(undefined)).toBe("PUB");
    expect(await json(await post({ subscription: { ...SUB, endpoint: "https://10.0.0.8/x" } }))).toEqual({ status: 400, body: { ok: false, error: "endpoint_forbidden" } });
    expect(await json(await call(handler, "POST", "/api/v1/push/subscriptions", { subscription: { ...SUB, endpoint: "http://web.push.apple.com/x" } }))).toMatchObject({ status: 400 });
    expect(await json(await call(handler, "POST", "/api/v1/push/subscriptions", {}))).toMatchObject({ status: 400 });
    expect(await json(await call(handler, "DELETE", "/api/v1/push/subscriptions", { endpoint: SUB.endpoint }))).toEqual({ status: 200, body: { ok: true, removed: true } });
    expect(await json(await call(handler, "DELETE", "/api/v1/push/subscriptions", { endpoint: SUB.endpoint }))).toEqual({ status: 200, body: { ok: true, removed: false } });
    expect(await json(await call(handler, "DELETE", "/api/v1/push/subscriptions", {}))).toMatchObject({ status: 400 });
    expect(listPushSubscriptions(db)).toHaveLength(1);
  });
  test("APNs：token 校验、登记（返回 configured）、按路径删除", async () => {
    const tok = "AB".repeat(32);
    expect(await json(await call(handler, "POST", "/api/v1/push/apns", { token: tok, device: "iPhone" }))).toEqual({ status: 200, body: { ok: true, configured: false } });
    expect(await json(await call(handler, "POST", "/api/v1/push/apns", { token: "zz" }))).toMatchObject({ status: 400 });
    expect(listApnsDevices(db)).toEqual([{ token: tok.toLowerCase(), principal: "owner:self", credential: null }]); // 登记时的身份：「待你处理」按它过 ask-access
    expect(await json(await call(handler, "DELETE", `/api/v1/push/apns/${tok}`))).toEqual({ status: 200, body: { ok: true, removed: true } });
    expect(listApnsDevices(db)).toEqual([]);
  });
});

describe("未读 / 已读", () => {
  test("GET /unread → {counts}，顺手清掉不在 registry 里的；POST /agents/:name/read 触发 onAgentRead；GET /reads 是 ISO", async () => {
    bumpUnread(db, "alpha", 1); bumpUnread(db, "alpha", 2); bumpUnread(db, "gone", 3); bumpUnread(db, "master", 4);
    expect(await json(await call(handler, "GET", "/api/v1/unread"))).toEqual({ status: 200, body: { counts: { alpha: 2 } } });
    const seen: string[] = [];
    const off = onAgentRead((e) => seen.push(`${e.agent}:${e.hadUnread}`));
    expect(await json(await call(handler, "POST", "/api/v1/agents/agent-alpha/read", {}))).toEqual({ status: 200, body: { ok: true } });
    expect(await json(await call(handler, "POST", `/api/v1/agents/${encodeURIComponent("测试 agent")}/read`))).toMatchObject({ status: 400 });
    expect(await json(await call(handler, "POST", "/api/v1/agents/%00/read"))).toMatchObject({ status: 400 });
    off();
    expect(seen).toEqual(["alpha:true"]);
    expect(await json(await call(handler, "GET", "/api/v1/unread"))).toEqual({ status: 200, body: { counts: {} } });
    markAgentRead(db, "beta", 1700000000000);
    const reads = await json(await call(handler, "GET", "/api/v1/reads"));
    expect(reads.status).toBe(200);
    expect(reads.body.reads.beta).toBe("2023-11-14T22:13:20.000Z");
    expect(typeof reads.body.reads.alpha).toBe("string");
  });
  test("registry 读不到时 /unread 照常返回，不清孤儿", async () => {
    const h = createPushRoutes({ db, sender, liveAgents: async () => { throw new Error("registry broken"); } });
    bumpUnread(db, "gone", 1);
    expect(await json(await call(h, "GET", "/api/v1/unread"))).toEqual({ status: 200, body: { counts: { gone: 1 } } });
  });
});
