/**
 * 推送网关（docs/relay/protocol.md §3.5）：帧校验、SSRF 规则、限流、投递结果 → push-ack 的映射；
 * 端到端：真实中继（createRelay）+ 裸协议客户端发 push 帧；真实 web-push 打本地自签名 TLS 服务器（allowPrivateEndpoints）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushEndpointProblem } from "../src/lib/push-endpoint.ts";
import { asPush, asPushAck, asWebPushSubscription, LIMITS, PUSH_MAX_PAYLOAD_CHARS } from "../src/lib/relay-protocol.ts";
import { loadOrCreateVapidKeys, readVapidKeys } from "../src/lib/web-push.ts";
import { PushGateway } from "../src/relay/push.ts";
import { createRelay, type Relay } from "../src/relay/server.ts";
import { keyFromSeed, seedOf, TestClient } from "./relay-test-client.ts";
import { selfSignedCert, webPushTestSubscription } from "./push-test-helpers.ts";

const SUB = { endpoint: "https://web.push.apple.com/QAbc", keys: { p256dh: "BPubKey", auth: "authKey" } };
const payload = JSON.stringify({ title: "a", body: "b" });

describe("帧校验", () => {
  test("asWebPushSubscription：https + 两把密钥；http / 缺键 / 非对象都拒", () => {
    expect(asWebPushSubscription(SUB)).toEqual(SUB);
    expect(asWebPushSubscription({ ...SUB, endpoint: "http://web.push.apple.com/x" })).toBeNull();
    expect(asWebPushSubscription({ endpoint: SUB.endpoint, keys: { p256dh: "x" } })).toBeNull();
    expect(asWebPushSubscription({ endpoint: "not a url", keys: SUB.keys })).toBeNull();
    expect(asWebPushSubscription("x")).toBeNull();
  });
  test("asPush：webpush / apns 形状；payload 上限按字符；ttl / badge 非法即拒；未知 kind 拒", () => {
    expect(asPush({ t: "push", id: "p1", kind: "webpush", subscription: SUB, payload, ttl: 60 })).toEqual({ t: "push", id: "p1", kind: "webpush", subscription: SUB, payload, ttl: 60 });
    expect(asPush({ t: "push", id: "p1", kind: "webpush", subscription: SUB, payload })).toEqual({ t: "push", id: "p1", kind: "webpush", subscription: SUB, payload });
    expect(asPush({ t: "push", id: "p2", kind: "apns", token: "AB".repeat(32), payload, badge: 2.7 })).toEqual({ t: "push", id: "p2", kind: "apns", token: "ab".repeat(32), payload, badge: 2 });
    expect(asPush({ t: "push", id: "p3", kind: "webpush", subscription: SUB, payload: "x".repeat(PUSH_MAX_PAYLOAD_CHARS) })).not.toBeNull();
    expect(asPush({ t: "push", id: "p3", kind: "webpush", subscription: SUB, payload: "x".repeat(PUSH_MAX_PAYLOAD_CHARS + 1) })).toBeNull();
    expect(asPush({ t: "push", id: "p4", kind: "webpush", subscription: SUB, payload: "" })).toBeNull();
    expect(asPush({ t: "push", id: "p5", kind: "webpush", subscription: SUB, payload, ttl: -1 })).toBeNull();
    expect(asPush({ t: "push", id: "p6", kind: "apns", token: "zz", payload })).toBeNull();
    expect(asPush({ t: "push", id: "p7", kind: "sms", payload })).toBeNull();
    expect(asPush({ t: "push", id: "bad id!", kind: "webpush", subscription: SUB, payload })).toBeNull();
    expect(asPush({ t: "req", id: "p8", kind: "webpush", subscription: SUB, payload })).toBeNull();
  });
  test("asPushAck：ok 必须是布尔；status / gone / error 可选", () => {
    expect(asPushAck({ t: "push-ack", id: "a", ok: true, status: 201 })).toEqual({ t: "push-ack", id: "a", ok: true, status: 201 });
    expect(asPushAck({ t: "push-ack", id: "a", ok: false, status: 410, gone: true, error: "x" })).toEqual({ t: "push-ack", id: "a", ok: false, status: 410, gone: true, error: "x" });
    expect(asPushAck({ t: "push-ack", id: "a", ok: false, gone: "yes" })).toEqual({ t: "push-ack", id: "a", ok: false });
    expect(asPushAck({ t: "push-ack", id: "a", ok: "true" })).toBeNull();
    expect(asPushAck({ t: "push-ack", ok: true })).toBeNull();
  });
});

describe("endpoint 的 SSRF 规则", () => {
  const bad = [
    "http://web.push.apple.com/x", "ftp://push.example/x", "https://user:pw@push.example/x", "not a url",
    "https://localhost/x", "https://a.localhost/x", "https://127.0.0.1:8080/x", "https://127.9.9.9/x", "https://10.1.2.3/x",
    "https://172.16.0.1/x", "https://172.31.255.254/x", "https://192.168.1.1/x", "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/x", "https://0.0.0.0/x", "https://224.0.0.1/x", "https://255.255.255.255/x",
    "https://2130706433/x", "https://0x7f.0.0.1/x", "https://[::1]/x", "https://[::]/x", "https://[fe80::1]/x", "https://[fd00::1]/x",
    "https://[fc00::1]/x", "https://[::ffff:10.0.0.1]/x", "https://[::ffff:7f00:1]/x", "https://[64:ff9b::a00:1]/x", "https://[ff02::1]/x",
  ];
  const good = [
    "https://web.push.apple.com/QAbc", "https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://8.8.8.8/x", "https://172.32.0.1/x", "https://[2606:4700::1111]/x", "https://[::ffff:8.8.8.8]/x",
  ];
  test("拒：非 https、带凭据、localhost、回环 / 私网 / 链路本地 / CGNAT / 组播 / 保留、各种 IPv4 写法、IPv6 与映射地址", () => {
    for (const e of bad) expect(pushEndpointProblem(e), e).not.toBeNull();
  });
  test("放：公网域名与公网 IP 字面量", () => {
    for (const e of good) expect(pushEndpointProblem(e), e).toBeNull();
  });
  test("allowPrivate 只放私网，不放 http", () => {
    expect(pushEndpointProblem("https://127.0.0.1:9/x", { allowPrivate: true })).toBeNull();
    expect(pushEndpointProblem("http://127.0.0.1:9/x", { allowPrivate: true })).toBe("scheme");
  });
});

describe("PushGateway（注入假后端）", () => {
  const logs: string[] = [];
  const sent: Array<{ endpoint: string; payload: string; ttl: number }> = [];
  let webStatus = 201;
  let webThrow = false;
  const apnsCalls: Array<{ token: string; badge?: number }> = [];
  const gw = new PushGateway({
    perFpPerMinute: 3, log: (_l, m) => void logs.push(m),
    vapidPublicKey: "PUB",
    webPush: async (sub, p, { ttl }) => {
      if (webThrow) throw new Error("ECONNRESET");
      sent.push({ endpoint: sub.endpoint, payload: p, ttl });
      return webStatus;
    },
    apns: {
      send: async (token, msg) => {
        apnsCalls.push({ token, badge: msg.badge });
        return token.startsWith("dead") ? { ok: false, status: 410, reason: "Unregistered" } : { ok: true, status: 200 };
      },
    },
  });
  const frame = (over: Record<string, unknown> = {}) => ({ t: "push", id: "p", kind: "webpush", subscription: SUB, payload, ...over });

  test("capabilities：有公钥 + apns", () => {
    expect(gw.capabilities()).toEqual({ vapidPublicKey: "PUB", apns: true });
  });
  test("Web Push 的 fp 按发送方钉死：机器自报的 fp（含路径注入）被覆盖；payload 不是 JSON 对象 → payload_invalid", async () => {
    const got: string[] = [];
    const g = new PushGateway({ perFpPerMinute: 10, log: () => {}, vapidPublicKey: "PUB", webPush: async (_s, p) => (got.push(p), 201), apns: null });
    const evil = JSON.stringify({ title: "x", agent: "a", fp: "9109-17c6-8e77-dfff/api/v1/restart-all?x=" });
    expect(await g.handle("fp-z", frame({ id: "pf1", payload: evil }))).toMatchObject({ ok: true });
    expect(JSON.parse(got[0]).fp).toBe("fp-z");
    expect(await g.handle("fp-z", frame({ id: "pf2", payload: "not json" }))).toMatchObject({ ok: false, error: "payload_invalid" });
    expect(await g.handle("fp-z", frame({ id: "pf3", payload: "[1,2]" }))).toMatchObject({ ok: false, error: "payload_invalid" });
    expect(got).toHaveLength(1);
  });
  test("201 → ok；404 / 410 → gone；500 → upstream_error；网络异常 → send_failed；ttl 缺省 3600；日志不含 payload", async () => {
    expect(await gw.handle("fp-a", frame({ id: "p1" }))).toEqual({ t: "push-ack", id: "p1", ok: true, status: 201 });
    expect(sent[0]).toEqual({ endpoint: SUB.endpoint, payload: JSON.stringify({ title: "a", body: "b", fp: "fp-a" }), ttl: 3600 }); // fp 由中继按发送方钉
    webStatus = 410;
    expect(await gw.handle("fp-a", frame({ id: "p2", ttl: 5 }))).toEqual({ t: "push-ack", id: "p2", ok: false, status: 410, gone: true });
    expect(sent[1].ttl).toBe(5);
    webStatus = 404;
    expect(await gw.handle("fp-a", frame({ id: "p3" }))).toMatchObject({ ok: false, status: 404, gone: true });
    expect(logs.join("\n")).not.toContain("title");
  });
  test("第 4 次同 fp 一分钟内 → rate_limited；换 fp 不受影响；sweep 后仍在窗口内", async () => {
    expect(await gw.handle("fp-a", frame({ id: "p4" }))).toEqual({ t: "push-ack", id: "p4", ok: false, error: "rate_limited" });
    webStatus = 500;
    expect(await gw.handle("fp-b", frame({ id: "p5" }))).toEqual({ t: "push-ack", id: "p5", ok: false, status: 500, error: "upstream_error" });
    gw.sweep(Date.now());
    expect(await gw.handle("fp-a", frame({ id: "p6" }))).toMatchObject({ error: "rate_limited" });
    webThrow = true;
    expect(await gw.handle("fp-b", frame({ id: "p7" }))).toEqual({ t: "push-ack", id: "p7", ok: false, error: "send_failed" });
    webThrow = false;
  });
  test("坏帧：有 id → ack frame_invalid；无 id → null；私网 endpoint → endpoint_forbidden（不消耗后端）", async () => {
    expect(await gw.handle("fp-c", { t: "push", id: "x", kind: "nope" })).toEqual({ t: "push-ack", id: "x", ok: false, error: "frame_invalid" });
    expect(await gw.handle("fp-c", { t: "push", kind: "webpush" })).toBeNull();
    const before = sent.length;
    expect(await gw.handle("fp-c", frame({ id: "x2", subscription: { ...SUB, endpoint: "https://192.168.0.5/x" } }))).toEqual({ t: "push-ack", id: "x2", ok: false, error: "endpoint_forbidden" });
    expect(sent.length).toBe(before);
  });
  test("apns：payload 解析成消息、帧级 badge 覆盖；410 Unregistered → gone；payload 不是消息 → payload_invalid", async () => {
    const msg = JSON.stringify({ title: "t", body: "b", agent: "a", url: "/chat", ts: 1, tag: "x", badge: 9 });
    expect(await gw.handle("fp-d", { t: "push", id: "a1", kind: "apns", token: "ab".repeat(32), payload: msg, badge: 3 })).toEqual({ t: "push-ack", id: "a1", ok: true, status: 200 });
    expect(apnsCalls[0]).toEqual({ token: "ab".repeat(32), badge: 3 });
    const dead = await gw.handle("fp-d", { t: "push", id: "a2", kind: "apns", token: `dead${"0".repeat(60)}`, payload: msg });
    expect(dead).toEqual({ t: "push-ack", id: "a2", ok: false, status: 410, gone: true, error: "Unregistered" });
    expect(apnsCalls[1].badge).toBe(9);
    expect(await gw.handle("fp-d", { t: "push", id: "a3", kind: "apns", token: "ab".repeat(32), payload: "{\"nope\":1}" })).toEqual({ t: "push-ack", id: "a3", ok: false, error: "payload_invalid" });
  });
  test("没配后端：webpush_unavailable / apns_unavailable；capabilities 相应为空", async () => {
    const bare = new PushGateway({ perFpPerMinute: 10, log: () => {}, webPush: null, apns: null });
    expect(bare.capabilities()).toEqual({ apns: false });
    expect(await bare.handle("f", frame({ id: "n1" }))).toEqual({ t: "push-ack", id: "n1", ok: false, error: "webpush_unavailable" });
    expect(await bare.handle("f", { t: "push", id: "n2", kind: "apns", token: "ab".repeat(32), payload })).toEqual({ t: "push-ack", id: "n2", ok: false, error: "apns_unavailable" });
  });
});

describe("端到端：真实中继 + 真实 web-push 打本地 TLS 假推送服务", () => {
  let relay: Relay;
  let pushSrv: ReturnType<typeof Bun.serve>;
  const got: Array<{ path: string; headers: Record<string, string>; bodyLen: number }> = [];
  let nextStatus = 201;
  const dir = mkdtempSync(join(tmpdir(), "relay-push-"));

  beforeAll(async () => {
    const tls = await selfSignedCert(dir);
    pushSrv = Bun.serve({
      port: 0, hostname: "127.0.0.1", tls,
      async fetch(req) {
        const u = new URL(req.url);
        got.push({ path: u.pathname, headers: Object.fromEntries(req.headers.entries()), bodyLen: (await req.arrayBuffer()).byteLength });
        return new Response(null, { status: nextStatus });
      },
    });
    const vapid = loadOrCreateVapidKeys(join(dir, "vapid.json"));
    relay = createRelay({
      base: "relay.test", port: 0, db: ":memory:", trustProxy: true, log: () => {},
      limits: { authPerIpPerMinute: 1000, idleTimeoutMs: 60_000, pushPerFpPerMinute: 2 },
      push: { vapid: { ...vapid, subject: "mailto:t@relay.test" }, allowPrivateEndpoints: true, insecureTls: true },
    });
  });
  afterAll(() => {
    relay.stop();
    pushSrv.stop(true);
  });

  test("welcome 带 push 能力；/app-config.json 带 vapidPublicKey；密钥文件 0600 且可重读", async () => {
    const vapid = readVapidKeys(join(dir, "vapid.json"))!;
    expect(vapid.publicKey.length).toBeGreaterThan(40);
    expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
    expect(loadOrCreateVapidKeys(join(dir, "vapid.json"))).toEqual(vapid); // 第二次读同一把，不重新生成
    const c = await TestClient.connect(`ws://127.0.0.1:${relay.port}/v1/ws`, keyFromSeed(seedOf(301)), { name: "P", slug: "p" });
    expect(c.welcome?.push).toEqual({ vapidPublicKey: vapid.publicKey, apns: false });
    const cfg = await (await fetch(`http://127.0.0.1:${relay.port}/app-config.json`, { headers: { "x-forwarded-host": "relay.test" } })).json();
    expect(cfg).toMatchObject({ mode: "relay", relayBase: "relay.test", vapidPublicKey: vapid.publicKey });
    c.close();
  });

  test("push 帧经中继投到假推送服务：加密正文 + VAPID 头 + TTL；201 → ok，410 → gone；第 3 帧 rate_limited", async () => {
    const c = await TestClient.connect(`ws://127.0.0.1:${relay.port}/v1/ws`, keyFromSeed(seedOf(302)), { name: "Q", slug: "q" });
    const sub = webPushTestSubscription(`https://127.0.0.1:${pushSrv.port}/push/one`);
    c.send({ t: "push", id: "e1", kind: "webpush", subscription: sub, payload, ttl: 120 });
    expect(await c.next((f) => f.t === "push-ack" && f.id === "e1")).toEqual({ t: "push-ack", id: "e1", ok: true, status: 201 });
    expect(got[0].path).toBe("/push/one");
    expect(got[0].headers["content-encoding"]).toBe("aes128gcm");
    expect(got[0].headers["ttl"]).toBe("120");
    expect(got[0].headers["authorization"]).toMatch(/^vapid t=/);
    expect(got[0].bodyLen).toBeGreaterThan(payload.length); // 加密后比明文长（盐 + 记录头 + tag）
    nextStatus = 410;
    c.send({ t: "push", id: "e2", kind: "webpush", subscription: sub, payload });
    expect(await c.next((f) => f.t === "push-ack" && f.id === "e2")).toEqual({ t: "push-ack", id: "e2", ok: false, status: 410, gone: true });
    c.send({ t: "push", id: "e3", kind: "webpush", subscription: sub, payload });
    expect(await c.next((f) => f.t === "push-ack" && f.id === "e3")).toEqual({ t: "push-ack", id: "e3", ok: false, error: "rate_limited" });
    // 没 id 的坏 push → error 帧而不是 ack；未认证前发 push → 按业务帧拒
    c.send({ t: "push", kind: "webpush" });
    expect(await c.next((f) => f.t === "error")).toMatchObject({ code: "frame_invalid" });
    c.close();
  });

  test("协议默认值：pushPerFpPerMinute = 60", () => {
    expect(LIMITS.pushPerFpPerMinute).toBe(60);
  });
});
