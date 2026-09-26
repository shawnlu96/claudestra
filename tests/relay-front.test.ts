/**
 * front（src/relay/front.ts）：中继自己的页面 + 隧道。真实 Bun.serve（port 0，trustProxy）+ 裸协议假实例。
 * 浏览器侧用 fetch 打 127.0.0.1，用 x-forwarded-host 指定主机名（fetch 不让改 Host）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RELAY_BASE_HEADER } from "../src/lib/relay-protocol.ts";
import { createRelay, type Relay } from "../src/relay/server.ts";
import { keyFromSeed, seedOf, TestClient } from "./relay-test-client.ts";

let relay: Relay;
let http: string;
let mini: TestClient;
type Frame = Record<string, unknown>;

beforeAll(async () => {
  relay = createRelay({
    base: "relay.test", port: 0, db: ":memory:", trustProxy: true, version: "9.9.9-test", frontHeadTimeoutMs: 400, sweepMs: 50,
    limits: { streamIdleMs: 400, authPerIpPerMinute: 1000, idleTimeoutMs: 60_000 },
    log: () => {},
  });
  http = `http://127.0.0.1:${relay.port}`;
  mini = await TestClient.connect(`ws://127.0.0.1:${relay.port}/v1/ws`, keyFromSeed(seedOf(101)), { name: "Mini", slug: "mini" });
});
afterAll(() => relay.stop());

const at = (host: string, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  fetch(`${http}${path}`, { ...init, redirect: "manual", headers: { "x-forwarded-host": host, "x-forwarded-for": "203.0.113.9", ...(init.headers ?? {}) } });
const b64 = (s: string) => Buffer.from(s).toString("base64");
const text = (b: unknown) => Buffer.from(String(b), "base64").toString();
/** 读到下一个非空块（HTTP 分块传输允许夹空块，不算数据） */
async function readChunk(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): Promise<string | null> {
  while (true) {
    const { done, value } = await reader.read();
    if (done) return null;
    if (value && value.length) return new TextDecoder().decode(value);
  }
}

/** 假实例：收到下一条 req 就按 reply 回（隧道请求不带 to） */
async function answer(reply: (req: Frame) => void): Promise<Frame> {
  const req = await mini.next((f) => f.t === "req");
  reply(req);
  return req;
}

describe("中继自己的页面", () => {
  test("healthz 带 version，不看主机名", async () => {
    const r = await fetch(`${http}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, online: 1, pending: 0, version: "9.9.9-test" });
    expect(r.headers.get("strict-transport-security")).toContain("max-age");
  });

  test("首页：输短码；?e=code 提示无效", async () => {
    const r = await at("relay.test", "/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(await r.text()).toContain("配对码");
    expect(await (await at("relay.test", "/?e=code")).text()).toContain("已过期");
  });

  test("/c/<code>：有效 → 302 到实例 /pair#<code>（fragment 在 Location 里）；无效 → 回首页", async () => {
    relay.directory.putCode("K7PM2XQ9", mini.fp, Date.now() + 60_000);
    const ok = await at("relay.test", "/c/k7pm-2xq9");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("https://mini.relay.test/pair#K7PM2XQ9");
    const bad = await at("relay.test", "/c/ZZZZZZZZ");
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe("/?e=code");
    const form = await at("relay.test", "/c?code=K7PM-2XQ9");
    expect(form.headers.get("location")).toBe("/c/K7PM-2XQ9");
  });

  test("/i：带 cstra_home cookie 直接送到自己的实例 /join；没有则落地页", async () => {
    const r = await at("relay.test", "/i", { headers: { cookie: "a=b; cstra_home=mini; c=d" } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://mini.relay.test/join");
    const bad = await at("relay.test", "/i", { headers: { cookie: "cstra_home=Not%20A%20Slug" } });
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("邀请");
    const none = await at("relay.test", "/i");
    expect(none.status).toBe(200);
  });

  test("未知主机 404；只许 GET", async () => {
    expect((await at("evil.example", "/")).status).toBe(404);
    expect((await at("relay.test", "/", { method: "POST" })).status).toBe(405);
    expect((await at("relay.test", "/nope")).status).toBe(404);
  });
});

describe("隧道", () => {
  test("GET：req 带 from:relay 与转发头；res 回到浏览器，去掉 content-length，补 HSTS", async () => {
    const browser = at("mini.relay.test", "/chat?x=1", { headers: { accept: "text/html", cookie: "cstra_session=abc" } });
    const req = await answer((r) => {
      mini.send({ t: "res", id: r.id, status: 200, headers: { "content-type": "application/json", "content-length": "999", connection: "close" }, body: b64('{"ok":true}') });
    });
    expect(req).toMatchObject({ from: "relay", method: "GET", path: "/chat?x=1", more: false });
    expect(req.to).toBeUndefined();
    const h = req.headers as Record<string, string>;
    expect(h["x-forwarded-host"]).toBe("mini.relay.test");
    expect(h["x-forwarded-proto"]).toBe("https");
    expect(h["x-forwarded-for"]).toBe("203.0.113.9");
    expect(h[RELAY_BASE_HEADER]).toBe("relay.test");
    expect(h.cookie).toBe("cstra_session=abc");
    const r = await browser;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(r.headers.get("strict-transport-security")).toContain("max-age");
    expect(r.headers.get("connection")).not.toBe("close");
  });

  test("POST 带正文：req more:true，正文以 data/end 到达；302 响应原样回", async () => {
    const browser = at("mini.relay.test", "/api/auth/login", { method: "POST", body: "username=a&password=b", headers: { "content-type": "application/x-www-form-urlencoded" } });
    const req = await mini.next((f) => f.t === "req");
    expect(req.more).toBe(true);
    const data = await mini.next((f) => f.t === "data" && f.id === req.id);
    expect(text(data.b64)).toBe("username=a&password=b");
    expect((await mini.next((f) => f.t === "end" && f.id === req.id)).id).toBe(req.id);
    mini.send({ t: "res", id: req.id, status: 303, headers: { location: "/" }, body: "" });
    const r = await browser;
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/");
  });

  test("SSE：res more:true + 首块后浏览器拿到头，之后每个 data 逐块到达，end 收尾", async () => {
    const browser = at("mini.relay.test", "/api/chat/stream");
    // 浏览器（和 Bun.serve）都要等到第一个字节才算响应开始：实例回头之后紧跟第一块
    const req = await answer((r) => {
      mini.send({ t: "res", id: r.id, status: 200, headers: { "content-type": "text/event-stream" }, body: "", more: true });
      mini.send({ t: "data", id: r.id, b64: b64("event: a\n\n") });
    });
    const r = await browser;
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const reader = r.body!.getReader();
    expect(await readChunk(reader)).toBe("event: a\n\n");
    mini.send({ t: "data", id: req.id, b64: b64("event: b\n\n") });
    expect(await readChunk(reader)).toBe("event: b\n\n");
    mini.send({ t: "end", id: req.id });
    expect(await readChunk(reader)).toBeNull();
  });

  test("res more:true 但一个字节都没来就 end → 空正文正常结束；首块随 res 一起来也行", async () => {
    const empty = at("mini.relay.test", "/empty-stream");
    await answer((r) => {
      mini.send({ t: "res", id: r.id, status: 200, headers: { "x-k": "v" }, body: "", more: true });
      mini.send({ t: "end", id: r.id });
    });
    const e = await empty;
    expect(e.status).toBe(200);
    expect(e.headers.get("x-k")).toBe("v");
    expect(await e.text()).toBe("");
    const inline = at("mini.relay.test", "/inline-first");
    const req = await answer((r) => mini.send({ t: "res", id: r.id, status: 200, headers: {}, body: b64("head-chunk"), more: true }));
    const i = await inline;
    const reader = i.body!.getReader();
    expect(await readChunk(reader)).toBe("head-chunk");
    mini.send({ t: "end", id: req.id });
    expect(await readChunk(reader)).toBeNull();
  });

  test("HEAD 与 204 不带正文", async () => {
    const browser = at("mini.relay.test", "/ping", { method: "HEAD" });
    await answer((r) => mini.send({ t: "res", id: r.id, status: 200, headers: { "x-a": "1" }, body: b64("ignored") }));
    const r = await browser;
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    const b2 = at("mini.relay.test", "/nothing");
    await answer((r) => mini.send({ t: "res", id: r.id, status: 204, headers: {}, body: "" }));
    expect((await b2).status).toBe(204);
  });

  test("浏览器中途放弃 → 实例收到 cancel", async () => {
    const ac = new AbortController();
    const browser = at("mini.relay.test", "/slow", { signal: ac.signal }).catch((e: Error) => e);
    const req = await mini.next((f) => f.t === "req");
    ac.abort();
    expect((await mini.next((f) => f.t === "cancel" && f.id === req.id)).from).toBe("relay");
    expect(await browser).toBeInstanceOf(Error);
  });

  test("实例不回响应头 → 502 timeout，实例收到 cancel；实例回 error 帧 → 502 带错误码", async () => {
    const slow = at("mini.relay.test", "/hang");
    const req = await mini.next((f) => f.t === "req");
    const r = await slow;
    expect(r.status).toBe(502);
    expect(await r.json()).toMatchObject({ ok: false, error: "timeout" });
    expect((await mini.next((f) => f.t === "cancel" && f.id === req.id)).id).toBe(req.id);

    const failing = at("mini.relay.test", "/broken");
    await answer((rq) => mini.send({ t: "error", id: rq.id, code: "local_unreachable", message: "web is down" }));
    const f = await failing;
    expect(f.status).toBe(502);
    expect(await f.json()).toMatchObject({ error: "local_unreachable", message: "web is down" });
  });

  test("流态空闲超时：浏览器那头的流被掐断，实例收到 cancel", async () => {
    const browser = at("mini.relay.test", "/stall");
    const req = await answer((r) => mini.send({ t: "res", id: r.id, status: 200, headers: {}, body: "", more: true }));
    const r = await browser;
    // HTTP 没法在流中间报错，只能断掉：浏览器看到的是提前结束的正文（可能是拒绝，也可能是截断）
    const outcome = await r.text().then((t) => `ended:${t.length}`, () => "rejected");
    expect(outcome).toMatch(/^ended:0$|^rejected$/);
    expect((await mini.next((f) => f.t === "cancel" && f.id === req.id)).id).toBe(req.id);
  });

  test("WebSocket 升级 → 426；不存在的 slug → 404 页；下线的实例 → 503 页", async () => {
    const up = await at("mini.relay.test", "/ws", { headers: { upgrade: "websocket" } });
    expect(up.status).toBe(426);
    const unknown = await at("nobody.relay.test", "/");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("nobody");
    const other = await TestClient.connect(`ws://127.0.0.1:${relay.port}/v1/ws`, keyFromSeed(seedOf(102)), { slug: "sleepy" });
    other.close();
    await other.closed;
    const off = await at("sleepy.relay.test", "/chat");
    expect(off.status).toBe(503);
    expect(await off.text()).toContain("不在线");
  });
});

describe("front 限流与在途上限（§6.1，用小配额验证）", () => {
  let tight: Relay;
  let thttp: string;
  let inst: TestClient;
  const from = (ip: string, host: string, path: string, init: RequestInit = {}) =>
    fetch(`${thttp}${path}`, { ...init, redirect: "manual", headers: { "x-forwarded-host": host, "x-forwarded-for": ip } });

  beforeAll(async () => {
    tight = createRelay({
      base: "tight.test", port: 0, db: ":memory:", trustProxy: true, frontHeadTimeoutMs: 2000, sweepMs: 50,
      limits: { codeLookupPerIpPerMinute: 2, tunnelPerIpPerMinute: 3, maxTunnelInflightPerInstance: 1, authPerIpPerMinute: 1000 },
      log: () => {},
    });
    thttp = `http://127.0.0.1:${tight.port}`;
    inst = await TestClient.connect(`ws://127.0.0.1:${tight.port}/v1/ws`, keyFromSeed(seedOf(201)), { slug: "box" });
  });
  afterAll(() => tight.stop());

  test("短码查询每 IP 限次：第 3 次 429 页，别的地址不受影响；/c?code= 的 302 不计数", async () => {
    tight.directory.putCode("K7PM2XQ9", inst.fp, Date.now() + 60_000);
    expect((await from("198.51.100.1", "tight.test", "/c/K7PM2XQ9")).status).toBe(302);
    expect((await from("198.51.100.1", "tight.test", "/c/ZZZZZZZZ")).status).toBe(302);
    const third = await from("198.51.100.1", "tight.test", "/c/K7PM2XQ9");
    expect(third.status).toBe(429);
    expect(await third.text()).toContain("稍等");
    expect((await from("198.51.100.1", "tight.test", "/c?code=K7PM2XQ9")).status).toBe(302);
    expect((await from("198.51.100.2", "tight.test", "/c/K7PM2XQ9")).status).toBe(302);
  });

  test("隧道请求每 IP 限次：第 4 次 429 带 retry-after，不进实例", async () => {
    // 逐条发、逐条答：在途上限是 1，并发发三条会先撞上 503 而不是这里要测的每 IP 计数
    const one = async (ip: string) => {
      const browser = from(ip, "box.tight.test", "/x");
      const r = await inst.next((f) => f.t === "req");
      inst.send({ t: "res", id: r.id, status: 200, headers: {}, body: "" });
      return (await browser).status;
    };
    for (let i = 0; i < 3; i++) expect(await one("198.51.100.7")).toBe(200);
    const fourth = await from("198.51.100.7", "box.tight.test", "/x");
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("retry-after")).toBe("60");
    expect(await inst.none((f) => f.t === "req")).toBe(true);
    expect(await one("198.51.100.8")).toBe(200);
  });

  test("每实例在途隧道请求上限：第 2 条 503 JSON；第 1 条答完后再来就放行", async () => {
    const pendingReq = from("198.51.100.20", "box.tight.test", "/slow");
    const req = await inst.next((f) => f.t === "req");
    const capped = await from("198.51.100.21", "box.tight.test", "/x");
    expect(capped.status).toBe(503);
    expect(await capped.json()).toEqual({ ok: false, error: "too many concurrent requests" });
    inst.send({ t: "res", id: req.id, status: 200, headers: {}, body: "" });
    expect((await pendingReq).status).toBe(200);
    const after = from("198.51.100.22", "box.tight.test", "/x");
    const r2 = await inst.next((f) => f.t === "req");
    inst.send({ t: "res", id: r2.id, status: 200, headers: {}, body: "" });
    expect((await after).status).toBe(200);
  });
});
