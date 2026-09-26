/**
 * 中继 v2 联合端到端：真服务端（src/relay）+ 真客户端库（src/lib/relay-client）+ 真 bridge 入站处理（src/bridge/relay-inbound），
 * 中间没有任何假件——服务端与客户端各自的测试用的是自己的假对端，这里保证两边对同一份协议的理解一致。
 * 假的只有两个「本机服务」：一台当 Web（隧道目标），一台当 peer 入口（/api/v1 目标）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createRelay, type Relay } from "../src/relay/server.ts";
import { connect, RelayError, type RelayClient } from "../src/lib/relay-client.ts";
import { instanceKeySync, keyFingerprint, signedHeaders, type InstanceKey } from "../src/lib/instance-key.ts";
import { makeInboundHandler } from "../src/bridge/relay-inbound.ts";
import { collectBody } from "../src/lib/relay-stream.ts";

const BASE = "relay.test";
const quiet = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let relay: Relay;
let web: Server<undefined>;
let ingress: Server<undefined>;
let a: RelayClient;
let b: RelayClient;
let keyA: InstanceKey;
let keyB: InstanceKey;
let fpA: string;
let fpB: string;

/** 浏览器视角：打中继 front，主机名用 x-forwarded-host（fetch 不让改 Host；服务端 trustProxy） */
const front = (host: string, path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${relay.port}${path}`, {
    ...init,
    redirect: "manual",
    headers: { "x-forwarded-host": host, "x-forwarded-for": "203.0.113.9", ...(init.headers as Record<string, string> | undefined) },
  });

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await sleep(25);
  }
}

beforeAll(async () => {
  relay = createRelay({ base: BASE, port: 0, db: ":memory:", trustProxy: true, log: quiet, frontHeadTimeoutMs: 5000 });
  web = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/hello") {
        const h = (k: string) => req.headers.get(k);
        return Response.json({ host: h("host"), fwdHost: h("x-forwarded-host"), base: h("x-claudestra-relay-base"), proto: h("x-forwarded-proto") });
      }
      if (u.pathname === "/echo") return new Response(await req.arrayBuffer(), { headers: { "content-type": "application/octet-stream" } });
      if (u.pathname === "/redirect") return new Response(null, { status: 302, headers: { location: `http://${req.headers.get("host")}/login` } });
      if (u.pathname === "/sse") {
        const stream = new ReadableStream<Uint8Array>({
          async start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode("data: 1\n\n"));
            await sleep(60);
            c.enqueue(enc.encode("data: 2\n\n"));
            c.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
  ingress = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/v1/agents") return Response.json({ ok: true, from: req.headers.get("x-claudestra-relay-from"), auth: req.headers.get("authorization") });
      if (u.pathname === "/api/v1/peers/redeem" && req.method === "POST") return Response.json({ ok: true, redeemed: true });
      return Response.json({ ok: false }, { status: 404 });
    },
  });
  keyA = instanceKeySync(mkdtempSync(join(tmpdir(), "relay-e2e-a-")))!;
  keyB = instanceKeySync(mkdtempSync(join(tmpdir(), "relay-e2e-b-")))!;
  fpA = keyFingerprint(keyA.publicKey);
  fpB = keyFingerprint(keyB.publicKey);
  const deps = { webBase: `http://127.0.0.1:${web.port}`, ingressBase: () => `http://127.0.0.1:${ingress.port}` };
  const relayUrl = `ws://127.0.0.1:${relay.port}/v1/ws`;
  a = connect({ relayUrl, key: keyA, name: "Mini", slug: "mini", onInbound: makeInboundHandler(deps), log: quiet });
  b = connect({ relayUrl, key: keyB, name: "Alex 的 MBP", slug: "alex", onInbound: makeInboundHandler(deps), log: quiet });
  await waitFor(() => a.info().connected && b.info().connected);
});

afterAll(() => {
  a?.close();
  b?.close();
  relay?.stop();
  web?.stop(true);
  ingress?.stop(true);
});

describe("握手与目录", () => {
  test("两台实例各拿到自己的 slug 与 base", () => {
    expect(a.info()).toMatchObject({ fp: fpA, slug: "mini", base: BASE });
    expect(b.info()).toMatchObject({ fp: fpB, slug: "alex", base: BASE });
  });
});

describe("隧道：浏览器 → front → 实例 → 本机 Web", () => {
  test("GET 带上 x-forwarded-* 与中继 base 头，Host 保留子域名", async () => {
    const r = await front(`mini.${BASE}`, "/hello");
    expect(r.status).toBe(200);
    expect(r.headers.get("strict-transport-security")).toContain("max-age");
    const j = (await r.json()) as Record<string, string>;
    expect(j.fwdHost).toBe(`mini.${BASE}`);
    expect(j.host).toBe(`mini.${BASE}`);
    expect(j.base).toBe(BASE);
    expect(j.proto).toBe("https");
  });

  test("POST 300 KB 正文经 data 帧分块后原样到达并原样返回", async () => {
    const payload = new Uint8Array(300 * 1024).map((_, i) => i % 251);
    const r = await front(`mini.${BASE}`, "/echo", { method: "POST", body: payload, headers: { "content-type": "application/octet-stream" } });
    expect(r.status).toBe(200);
    const back = new Uint8Array(await r.arrayBuffer());
    expect(back.length).toBe(payload.length);
    expect(Buffer.from(back).equals(Buffer.from(payload))).toBe(true);
  });

  test("SSE 流式：两块先后到达，content-type 原样", async () => {
    const r = await front(`mini.${BASE}`, "/sse");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const text = new TextDecoder().decode(await collectBody(r.body, 1 << 20));
    expect(text).toBe("data: 1\n\ndata: 2\n\n");
  });

  test("明文 Web 算出的 http:// Location 被改写成 https://", async () => {
    const r = await front(`mini.${BASE}`, "/redirect");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`https://mini.${BASE}/login`);
  });

  test("实例不在线 503 页、不存在的 slug 404、Upgrade 426", async () => {
    b.close();
    await waitFor(() => !b.info().connected);
    await sleep(50);
    expect((await front(`alex.${BASE}`, "/hello")).status).toBe(503);
    expect((await front(`nobody.${BASE}`, "/hello")).status).toBe(404);
    expect((await front(`mini.${BASE}`, "/hello", { headers: { upgrade: "websocket" } })).status).toBe(426);
    b = connect({
      relayUrl: `ws://127.0.0.1:${relay.port}/v1/ws`, key: keyB, name: "Alex 的 MBP", slug: "alex", log: quiet,
      onInbound: makeInboundHandler({ webBase: `http://127.0.0.1:${web.port}`, ingressBase: () => `http://127.0.0.1:${ingress.port}` }),
    });
    await waitFor(() => b.info().connected);
  });
});

describe("peer：门控、兑换例外、验签、在线状态", () => {
  const signed = (key: InstanceKey, method: string, path: string, body = "") => ({ ...signedHeaders(method, path, body, key), authorization: "Bearer test-token" });

  test("对方没把我列为联系人 → peer_unknown", async () => {
    const p = a.request(fpB, { method: "GET", path: "/api/v1/agents", headers: signed(keyA, "GET", "/api/v1/agents") }, { timeoutMs: 3000 });
    await expect(p).rejects.toBeInstanceOf(RelayError);
    await expect(p).rejects.toMatchObject({ code: "peer_unknown" });
  });

  test("兑换邀请这一条例外放行，并经验签打到对方的 peer 入口", async () => {
    const body = JSON.stringify({ join: "x".repeat(32) });
    const headers = { ...signed(keyA, "POST", "/api/v1/peers/redeem", body), "content-type": "application/json" };
    const r = await a.request(fpB, { method: "POST", path: "/api/v1/peers/redeem", headers, body: new TextEncoder().encode(body) }, { timeoutMs: 3000 });
    expect(r.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(await collectBody(r.body, 1 << 16)))).toEqual({ ok: true, redeemed: true });
  });

  test("对方列了我 → 请求放行，x-claudestra-relay-from 是我的指纹", async () => {
    b.setContacts([fpA]);
    await sleep(100);
    const r = await a.request(fpB, { method: "GET", path: "/api/v1/agents", headers: signed(keyA, "GET", "/api/v1/agents") }, { timeoutMs: 3000 });
    expect(r.status).toBe(200);
    const j = JSON.parse(new TextDecoder().decode(await collectBody(r.body, 1 << 16))) as Record<string, string>;
    expect(j.from).toBe(fpA);
    expect(j.auth).toBe("Bearer test-token");
  });

  test("签名对不上 → bad_signature（中继盖的 from 与签名钥匙不符）", async () => {
    const p = a.request(fpB, { method: "GET", path: "/api/v1/agents", headers: signed(keyB, "GET", "/api/v1/agents") }, { timeoutMs: 3000 });
    await expect(p).rejects.toMatchObject({ code: "bad_signature", origin: "peer" });
  });

  test("路径不在 /api/v1 下 → path_forbidden", async () => {
    const p = a.request(fpB, { method: "GET", path: "/hook", headers: signed(keyA, "GET", "/hook") }, { timeoutMs: 3000 });
    await expect(p).rejects.toMatchObject({ code: "path_forbidden" });
  });

  test("双向联系人才有在线状态", async () => {
    a.setContacts([fpB]);
    await waitFor(() => a.peers().some((p) => p.fp === fpB && p.online === true && p.mutual === true));
    expect(b.peers().find((p) => p.fp === fpA)).toMatchObject({ slug: "mini", online: true });
  });
});

describe("front 页面", () => {
  test("短码 → 302 到实例的 /pair#<code>；坏码回首页", async () => {
    a.putCode("K7PM2XQ9", Math.floor(Date.now() / 1000) + 600);
    await sleep(100);
    const r = await front(BASE, "/c/k7pm-2xq9");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`https://mini.${BASE}/pair#K7PM2XQ9`);
    const bad = await front(BASE, "/c/ZZZZZZZZ");
    expect(bad.status).toBe(302);
    expect(bad.headers.get("location")).toBe("/?e=code");
  });

  test("/i 带 cstra_home cookie 直接送回自己的实例；没有则给落地页", async () => {
    const r = await front(BASE, "/i", { headers: { cookie: "cstra_home=mini" } });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`https://mini.${BASE}/join`);
    const page = await front(BASE, "/i");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
  });

  test("healthz 带版本与在线数", async () => {
    const j = (await (await front(BASE, "/healthz")).json()) as { ok: boolean; online: number; version: string };
    expect(j.ok).toBe(true);
    expect(j.online).toBe(2);
    expect(typeof j.version).toBe("string");
  });
});
