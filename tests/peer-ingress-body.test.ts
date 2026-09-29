import { expect, test } from "bun:test";
import { connect } from "node:net";
import { ingressRequest, servePeerIngress } from "../src/bridge/peer-ingress.js";
import { MAX_HTTP_BODY, MAX_PEER_BODY, readBoundedRequestBody } from "../src/lib/request-body.js";
import { RELAY_MARK_HEADER, relayMark } from "../src/bridge/relay-inbound.js";
import { E2E_BODY_MAX, e2eError } from "../src/lib/peer-e2e-wire.js";
import { readRequestCapped } from "../src/lib/peer-e2e-serve.js";

const E2E_PATHS = ["/api/v1/e2e/hello", "/api/v1/e2e/AAAAAAAAAAAAAAAAAAAAAA/1"];

test("预读：声明超大和无长度分块超大都拒，API 不执行；小正文原样传递", async () => {
  const seen: string[] = [];
  const api = async (r: Request) => { seen.push(await r.text()); return new Response("ok"); };
  const url = "http://test/api/v1/peers/redeem";
  for (const headers of [{}, { "content-length": String(MAX_PEER_BODY + 1) }] as Record<string, string>[]) {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_PEER_BODY + 1)); c.close(); } });
    const res = await ingressRequest(new Request(url, { method: "POST", headers, body }), api, "198.51.100.1");
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  }
  expect(seen).toEqual([]);
  const cookieRedeem = new Request(url, { method: "POST", headers: { cookie: "cstra_dev=fixture" }, body: new Uint8Array(MAX_PEER_BODY + 1) });
  expect((await ingressRequest(cookieRedeem, api, "127.0.0.1")).status).toBe(413);
  expect((await ingressRequest(new Request(url, { method: "POST", body: "{}" }), api, "198.51.100.1")).status).toBe(200);
  expect(seen).toEqual(["{}"]);
});

test("本机反代无凭据任意 POST 不预读；公开配对与 cookie 兼容保留", async () => {
  let calls = 0;
  const api = async () => { calls++; return new Response("ok"); };
  const req = new Request("http://test/api/v1/agents/x/messages", { method: "POST", body: new ReadableStream() });
  expect((await ingressRequest(req, api, "127.0.0.1")).status).toBe(403);
  expect(req.bodyUsed).toBe(false);
  expect(calls).toBe(0);
  for (const [path, headers] of [["devices/pair", {}], ["agents/x/messages", { cookie: "cstra_dev=fixture" }]] as const) {
    const r = new Request(`http://test/api/v1/${path}`, { method: "POST", headers, body: "{}" });
    expect((await ingressRequest(r, api, "127.0.0.1")).status).toBe(200);
  }
  expect(calls).toBe(2);
});

test("正文超时：绝对期限不随来字节续期，不等取消承诺", async () => {
  let cancelled = false;
  const req = new Request("http://test/", { method: "POST", body: new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  }) });
  await expect(readBoundedRequestBody(req, 100, 30)).rejects.toMatchObject({ status: 408 });
  expect(cancelled).toBe(true);
});

test("E2E 两种帧即使在回环带 cookie 也不能走网页流式例外", async () => {
  let calls = 0;
  for (const path of E2E_PATHS) {
    for (const headers of [{}, { cookie: "cstra_dev=fake", "x-cstra-device": "1" }] as Record<string, string>[]) {
      const req = new Request(`http://test${path}`, { method: "POST", headers, body: new Uint8Array(E2E_BODY_MAX + 1) });
      const res = await ingressRequest(req, async () => { calls++; return new Response("unexpected"); }, "127.0.0.1");
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ code: "e2e_too_large" });
      expect(res.headers.get("connection")).toBe("close");
    }
  }
  expect(calls).toBe(0);
});

test("E2E 读取适配层也走统一绝对期限，拒收响应关闭连接", async () => {
  let cancelled = false;
  const req = new Request("http://test/api/v1/e2e/hello", { method: "POST", body: new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  }) });
  const start = Date.now();
  expect(await readRequestCapped(req, E2E_BODY_MAX)).toBeNull();
  expect(cancelled).toBe(true);
  expect(Date.now() - start).toBeLessThan(2_000);
  expect(e2eError(413, "e2e_too_large").headers.get("connection")).toBe("close");
});

async function slowUpload(path: string, headers = "", status = 408) {
  let calls = 0;
  const srv = servePeerIngress({ port: 0, host: "127.0.0.1", handleApi: async () => { calls++; return new Response("unexpected"); } });
  const socket = connect({ host: "127.0.0.1", port: srv.port! });
  let timer: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let received = "";
  let responseAt = 0;
  const start = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error(`未及时断开: ${received}`)), 7_000);
      socket.on("connect", () => {
        socket.write(`POST ${path} HTTP/1.1\r\nHost: test\r\n${headers}Transfer-Encoding: chunked\r\n\r\n1\r\nx\r\n`);
        timer = setInterval(() => socket.write("1\r\nx\r\n"), 200);
      });
      socket.on("data", b => { received += b.toString(); responseAt ||= Date.now(); });
      socket.on("error", reject);
      socket.on("close", resolve);
    });
    expect(received).toContain(`HTTP/1.1 ${status}`);
    expect(received.toLowerCase()).toContain("connection: close");
    expect(responseAt - start).toBeLessThan(2_000);
    // Bun 的 socket 关闭按粗粒度时钟执行，不能把响应的 1 秒期限误称为 TCP 已关闭。
    expect(Date.now() - start).toBeLessThan(7_000);
    expect(calls).toBe(0);
  } finally {
    clearInterval(timer);
    clearTimeout(watchdog);
    socket.destroy();
    srv.stop(true);
  }
}

test("真实 peer listener：兑换/E2E 滴流、反代无凭据 POST 都在 2 秒内响应并限时断开", async () => {
  await Promise.all([
    slowUpload("/api/v1/peers/redeem"),
    slowUpload("/api/v1/peers/redeem", `${RELAY_MARK_HEADER}: ${relayMark()}\r\nx-claudestra-relay-from: 16f9-b5d1-30fb-8923\r\n`),
    slowUpload("/api/v1/agents/x/messages", "X-Forwarded-For: 203.0.113.5\r\n", 403),
    ...E2E_PATHS.flatMap(path => [slowUpload(path), slowUpload(path, "Cookie: cstra_dev=fake\r\nX-Cstra-Device: 1\r\n")]),
  ]);
}, 10_000);

test("listener 显式正文上限；网页上限仍容得下 20MB 语音", async () => {
  let calls = 0;
  const srv = servePeerIngress({ port: 0, host: "127.0.0.1", handleApi: async () => { calls++; return new Response("unexpected"); } });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/v1/peers/redeem`, { method: "POST", body: new Uint8Array(MAX_HTTP_BODY + 1) });
    expect(res.status).toBe(413);
    expect(calls).toBe(0);
    expect(MAX_HTTP_BODY).toBeGreaterThan(20 * 1024 * 1024 + 64 * 1024);
  } finally { srv.stop(true); }
});
