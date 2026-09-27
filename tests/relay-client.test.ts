/**
 * 中继客户端（src/lib/relay-client.ts）对假中继（tests/relay-fake-relay.ts）：握手、联系人、请求往返（含流式）、
 * 入站处理与回帖、取消、断线重连、致命退避、心跳判死。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { keyFingerprint } from "../src/lib/relay-protocol.js";
import { collectBody } from "../src/lib/relay-stream.js";
import { connect, RelayError, type InboundHandler, type InboundResponse, type RelayClient } from "../src/lib/relay-client.js";
import { startFakeRelay, type FakeRelay } from "./relay-fake-relay.js";

const FAST = { heartbeatMs: 200, pongTimeoutMs: 150, backoffMs: [30, 60], stableMs: 50, fatalRetryMs: 400, headGraceMs: 300 };
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freshKey() {
  return instanceKeySync(mkdtempSync(join(tmpdir(), "relay-client-")))!;
}

const opened: Array<RelayClient | FakeRelay> = [];
afterAll(() => {
  for (const x of opened) ("stop" in x ? x.stop() : x.close());
});

function client(relay: FakeRelay, name: string, handler?: InboundHandler, extra: Partial<Parameters<typeof connect>[0]> = {}) {
  const key = freshKey();
  const c = connect({ relayUrl: relay.url, key, name, slug: name.toLowerCase(), onInbound: handler, timing: FAST, log: () => {}, ...extra });
  opened.push(c);
  return { c, fp: keyFingerprint(key.publicKey) };
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(5);
  }
}

describe("握手与登记", () => {
  const relay = startFakeRelay({ base: "r.test", slug: "renamed" });
  opened.push(relay);
  test("hello → auth → welcome：info 拿到中继定的 slug 与 base；contacts 与 code 在 welcome 后补发", async () => {
    const { c, fp } = client(relay, "Alpha");
    c.setContacts(["1111-2222-3333-4444", "1111-2222-3333-4444"]);
    c.putCode("K7PM2XQ9", Math.floor(Date.now() / 1000) + 600);
    await relay.waitOnline(fp);
    await until(() => c.state === "online");
    expect(c.info()).toMatchObject({ connected: true, fp, slug: "renamed", base: "r.test" });
    const contacts = await relay.waitFor((r) => r.fp === fp && r.frame.t === "contacts");
    expect(contacts.frame.fps).toEqual(["1111-2222-3333-4444"]);
    const code = await relay.waitFor((r) => r.fp === fp && r.frame.t === "code");
    expect(code.frame).toMatchObject({ op: "put", code: "K7PM2XQ9" });
    c.delCode("K7PM2XQ9");
    await relay.waitFor((r) => r.fp === fp && r.frame.t === "code" && r.frame.op === "del");
    c.setContacts(["1111-2222-3333-4444"]); // 没变就不重发
    await sleep(30);
    expect(relay.received.filter((r) => r.fp === fp && r.frame.t === "contacts").length).toBe(1);
  });
  test("presence 更新 peers() 并回调；peers 帧全量覆盖", async () => {
    const { c, fp } = client(relay, "Beta");
    await relay.waitOnline(fp);
    const seen: string[] = [];
    (c as unknown as { o: { onPresence: (p: { fp: string }) => void } }).o.onPresence = (p) => seen.push(p.fp);
    relay.sendTo(fp, { t: "peers", peers: [{ fp: "aaaa-bbbb-cccc-dddd", slug: "x", name: "X", online: false, lastSeen: "", mutual: true }] });
    relay.sendTo(fp, { t: "presence", peer: { fp: "aaaa-bbbb-cccc-dddd", slug: "x", name: "X", online: true, lastSeen: "now" } });
    await until(() => c.peers().some((p) => p.online));
    expect(c.peers()).toHaveLength(1);
    expect(seen).toEqual(["aaaa-bbbb-cccc-dddd"]);
  });
});

describe("请求往返", () => {
  const relay = startFakeRelay();
  opened.push(relay);
  const seenCtx: string[] = [];
  const echo: InboundHandler = async (req, ctx): Promise<InboundResponse> => {
    seenCtx.push(ctx.from);
    const body = await collectBody(req.body, 10_000_000);
    if (req.path.startsWith("/api/v1/stream")) {
      const big = new Uint8Array(400_000).fill(65);
      const stream = new ReadableStream<Uint8Array>({
        start(ctl) {
          ctl.enqueue(enc("part1;"));
          ctl.enqueue(big);
          ctl.enqueue(enc(";part3"));
          ctl.close();
        },
      });
      return { status: 200, headers: { "content-type": "text/event-stream" }, body: stream };
    }
    if (req.path.startsWith("/api/v1/fail")) throw new RelayError("bad_signature", "peer", "nope");
    if (req.path.startsWith("/api/v1/boom")) throw new Error("ingress down");
    return { status: 201, headers: { "x-echo": req.headers["x-in"] ?? "" }, body: enc(JSON.stringify({ method: req.method, path: req.path, body: dec(body) })) };
  };
  test("小正文内联、大正文分块；响应头即到，正文从流里读；流式响应多块拼回", async () => {
    const a = client(relay, "A");
    const b = client(relay, "B", echo);
    await Promise.all([relay.waitOnline(a.fp), relay.waitOnline(b.fp)]);
    const r1 = await a.c.request(b.fp, { method: "post", path: "/api/v1/agents/x/messages?q=1", headers: { "x-in": "v" }, body: enc("hello") });
    expect(r1.status).toBe(201);
    expect(r1.headers["x-echo"]).toBe("v");
    expect(JSON.parse(dec(await collectBody(r1.body, 1e6)))).toEqual({ method: "POST", path: "/api/v1/agents/x/messages?q=1", body: "hello" });
    expect(seenCtx).toEqual([a.fp]);
    const big = new Uint8Array(350_000).fill(66);
    const r2 = await a.c.request(b.fp, { method: "POST", path: "/api/v1/agents/x/messages", headers: {}, body: big });
    const got = JSON.parse(dec(await collectBody(r2.body, 1e6)));
    expect(got.body.length).toBe(350_000);
    expect(relay.received.filter((r) => r.fp === a.fp && r.frame.t === "data").length).toBe(3);
    const r3 = await a.c.request(b.fp, { method: "GET", path: "/api/v1/stream", headers: {} });
    expect(r3.headers["content-type"]).toBe("text/event-stream");
    const text = dec(await collectBody(r3.body, 1e6));
    expect(text.startsWith("part1;")).toBe(true);
    expect(text.endsWith(";part3")).toBe(true);
    expect(text.length).toBe(400_000 + 12);
    const rs = client(relay, "S", echo);
    await relay.waitOnline(rs.fp);
    const r4 = await a.c.request(rs.fp, { method: "GET", path: "/api/v1/agents", headers: {}, body: new ReadableStream({ start: (c) => { c.enqueue(enc("ab")); c.close(); } }) });
    expect(JSON.parse(dec(await collectBody(r4.body, 1e6))).body).toBe("ab");
  });
  test("对方 handler 抛 RelayError → 原码回到发起方；普通异常 → local_unreachable；不在 /api/v1 下本地就拒", async () => {
    const a = client(relay, "A2");
    const b = client(relay, "B2", echo);
    await Promise.all([relay.waitOnline(a.fp), relay.waitOnline(b.fp)]);
    await expect(a.c.request(b.fp, { method: "GET", path: "/api/v1/fail", headers: {} })).rejects.toMatchObject({ code: "bad_signature", origin: "peer", message: "nope" });
    await expect(a.c.request(b.fp, { method: "GET", path: "/api/v1/boom", headers: {} })).rejects.toMatchObject({ code: "local_unreachable", origin: "peer" });
    await expect(a.c.request(b.fp, { method: "GET", path: "/hook", headers: {} })).rejects.toMatchObject({ code: "path_forbidden", origin: "client" });
    await expect(a.c.request("0000-0000-0000-0000", { method: "GET", path: "/api/v1/agents", headers: {} })).rejects.toMatchObject({ code: "peer_offline", origin: "relay" });
  });
  test("隧道请求（from relay）：回帖不带 to，失败回 502", async () => {
    const b = client(relay, "B3", echo);
    await relay.waitOnline(b.fp);
    relay.sendTo(b.fp, { t: "req", id: "t1", from: "relay", method: "GET", path: "/chat?x=1", headers: { host: "b3.relay.test", "x-in": "h" } });
    const res = await relay.waitFor((r) => r.fp === b.fp && r.frame.t === "res" && r.frame.id === "t1");
    expect(res.frame.to).toBeUndefined();
    expect(res.frame.status).toBe(201);
    expect(JSON.parse(dec(Buffer.from(String(res.frame.body), "base64")))).toMatchObject({ path: "/chat?x=1" });
    relay.sendTo(b.fp, { t: "req", id: "t2", from: "relay", method: "GET", path: "/api/v1/boom", headers: {} });
    const bad = await relay.waitFor((r) => r.fp === b.fp && r.frame.t === "res" && r.frame.id === "t2");
    expect(bad.frame.status).toBe(502);
    // 入站正文分块：more + data + end 拼成一段
    relay.sendTo(b.fp, { t: "req", id: "t3", from: "relay", method: "POST", path: "/x", headers: {}, body: Buffer.from("he").toString("base64"), more: true });
    relay.sendTo(b.fp, { t: "data", id: "t3", from: "relay", b64: Buffer.from("llo").toString("base64") });
    relay.sendTo(b.fp, { t: "end", id: "t3", from: "relay" });
    const r3 = await relay.waitFor((r) => r.fp === b.fp && r.frame.t === "res" && r.frame.id === "t3");
    expect(JSON.parse(dec(Buffer.from(String(r3.frame.body), "base64"))).body).toBe("hello");
  });
  test("发起方 abort → 对方 signal 触发、发起方拒 cancelled；发起方 cancel 帧到对方", async () => {
    let aborted = false;
    const slow: InboundHandler = (_req, ctx) => new Promise((_res, rej) => ctx.signal.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); }));
    const a = client(relay, "A4");
    const b = client(relay, "B4", slow);
    await Promise.all([relay.waitOnline(a.fp), relay.waitOnline(b.fp)]);
    const ac = new AbortController();
    const p = a.c.request(b.fp, { method: "GET", path: "/api/v1/agents", headers: {} }, { signal: ac.signal });
    await relay.waitFor((r) => r.fp === a.fp && r.frame.t === "req");
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    await until(() => aborted);
    expect(relay.received.some((r) => r.fp === a.fp && r.frame.t === "cancel")).toBe(true);
  });
});

describe("断线、重连、退避", () => {
  test("在途请求以 connection_lost 拒绝；重连后 contacts 补发；info 报 offline", async () => {
    const relay = startFakeRelay();
    opened.push(relay);
    const never: InboundHandler = () => new Promise(() => {});
    const a = client(relay, "A5");
    const b = client(relay, "B5", never);
    await Promise.all([relay.waitOnline(a.fp), relay.waitOnline(b.fp)]);
    a.c.setContacts([b.fp]);
    await relay.waitFor((r) => r.fp === a.fp && r.frame.t === "contacts");
    const p = a.c.request(b.fp, { method: "GET", path: "/api/v1/agents", headers: {} });
    await relay.waitFor((r) => r.fp === a.fp && r.frame.t === "req");
    relay.drop(a.fp);
    await expect(p).rejects.toMatchObject({ code: "connection_lost", origin: "client" });
    await until(() => a.c.state !== "online");
    expect(a.c.info().connected).toBe(false);
    await expect(a.c.request(b.fp, { method: "GET", path: "/api/v1/agents", headers: {} })).rejects.toMatchObject({ code: "connection_lost" });
    await relay.waitOnline(a.fp);
    await until(() => relay.received.filter((r) => r.fp === a.fp && r.frame.t === "contacts").length === 2);
  });
  test("致命错误固定退避：auth_failed 后 fatalRetryMs 内不重试", async () => {
    const relay = startFakeRelay({ rejectAuthWith: "auth_failed" });
    opened.push(relay);
    const { c } = client(relay, "F");
    await until(() => relay.authCount === 1);
    await sleep(250);
    expect(relay.authCount).toBe(1);
    expect(c.info().lastError).toBe("auth_failed");
    expect((c.info().retryAt ?? 0) - Date.now()).toBeGreaterThan(0);
    await until(() => relay.authCount === 2, 1500);
  });
  test("心跳无 pong → 主动断开并重连", async () => {
    const relay = startFakeRelay({ noPong: true });
    opened.push(relay);
    const { fp } = client(relay, "H");
    await relay.waitOnline(fp);
    await until(() => relay.authCount >= 2, 3000);
  });
  test("close() 后不再重连", async () => {
    const relay = startFakeRelay();
    opened.push(relay);
    const { c, fp } = client(relay, "C");
    await relay.waitOnline(fp);
    c.close();
    expect(c.state).toBe("closed");
    await sleep(200);
    expect(relay.authCount).toBe(1);
    expect(relay.conns.has(fp)).toBe(false);
  });
});
