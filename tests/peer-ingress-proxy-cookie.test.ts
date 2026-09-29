import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { ingressRequest, servePeerIngress } from "../src/bridge/peer-ingress.js";
import { authenticateApi, setApiAuthPrincipalsPathForTest } from "../src/bridge/api-auth.js";
import { requestContextOf } from "../src/bridge/request-context.js";
import { relayMark, RELAY_MARK_HEADER, TUNNEL_MARK_HEADER } from "../src/bridge/relay-inbound.js";
import { attachCredential, ensureOwnerPrincipal, fullGrant } from "../src/lib/devices.js";
import type { PrincipalsFile } from "../src/lib/principals.js";

const dir = mkdtempSync(join(tmpdir(), "ingress-cookie-"));
const path = join(dir, "principals.json");
const file: PrincipalsFile = { principals: [] };
const { token } = attachCredential(ensureOwnerPrincipal(file), "test-browser", fullGrant());
writeFileSync(path, JSON.stringify(file));
beforeAll(() => setApiAuthPrincipalsPathForTest(path));
afterAll(() => { setApiAuthPrincipalsPathForTest(undefined); rmSync(dir, { recursive: true, force: true }); });

test("真入口 + 真鉴权：只有无标记回环反代保留设备 cookie；XFF 不产生回环豁免", async () => {
  const run = (addr: string, extra: Record<string, string> = {}) => ingressRequest(new Request("http://peer.test/api/v1/agents", {
    headers: { cookie: `cstra_dev=${token}`, "x-forwarded-for": "203.0.113.15", "x-forwarded-proto": "https", ...extra },
  }), async (req, url) => {
    const p = await authenticateApi(req, url, { rateLimit: false });
    return p instanceof Response ? p : Response.json({ id: p.id, source: requestContextOf(req).source });
  }, addr);
  const proxy = await run("127.0.0.1");
  expect(proxy.status).toBe(200);
  expect(await proxy.json()).toEqual({ id: "owner:self", source: "lan" });
  expect((await run("100.64.0.7")).status).toBe(403);
  expect((await run("127.0.0.1", { [TUNNEL_MARK_HEADER]: "untrusted" })).status).toBe(403);
  expect((await run("127.0.0.1", { [RELAY_MARK_HEADER]: relayMark(), "x-claudestra-relay-from": "1111-2222-3333-4444" })).status).toBe(403);
  expect((await run("127.0.0.1", { cookie: "cstra_dev=dev_invalid" })).status).toBe(401);
});

test("真实 listener + 设备鉴权：3MiB 慢上传在 5 秒内成功，不受 peer 的 1 秒预读限制", async () => {
  let enteredAt = 0, beforeRead = false;
  const began = Date.now();
  const srv = servePeerIngress({ port: 0, host: "127.0.0.1", handleApi: async (req, url) => {
    enteredAt = Date.now();
    beforeRead = !req.bodyUsed;
    const p = await authenticateApi(req, url, { rateLimit: false });
    if (p instanceof Response) return p;
    return Response.json({ bytes: (await req.arrayBuffer()).byteLength, source: requestContextOf(req).source });
  } });
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({ async pull(c) {
    await Bun.sleep(60);
    c.enqueue(new Uint8Array(48 * 1024));
    if (++chunks === 64) c.close();
  } });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/v1/voice/transcribe`, {
      method: "POST", body, signal: AbortSignal.timeout(7_000),
      headers: { cookie: `cstra_dev=${token}`, "x-cstra-device": "1", "x-forwarded-for": "203.0.113.15" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bytes: 3 * 1024 * 1024, source: "lan" });
    expect(beforeRead).toBe(true);
    expect(enteredAt - began).toBeLessThan(1_000);
    expect(Date.now() - began).toBeGreaterThan(3_000);
    expect(Date.now() - began).toBeLessThan(5_000);
  } finally { srv.stop(true); }
}, 10_000);

test("真实 listener + 假 cookie 慢送：先拒绝鉴权，2 秒内响应并限时断开", async () => {
  let rejected = 0;
  const srv = servePeerIngress({ port: 0, host: "127.0.0.1", handleApi: async (req, url) => {
    expect(req.bodyUsed).toBe(false);
    const p = await authenticateApi(req, url, { rateLimit: false });
    if (p instanceof Response) { rejected++; return p; }
    return new Response("unexpected");
  } });
  const socket = connect({ host: "127.0.0.1", port: srv.port! });
  let interval: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  const began = Date.now();
  let responseAt = 0, response = "";
  try {
    await new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("假 cookie 的慢送连接没有及时关闭")), 7_000);
      socket.once("connect", () => {
        socket.write("POST /api/v1/voice/transcribe HTTP/1.1\r\nHost: test\r\nCookie: cstra_dev=fake\r\n" +
          "X-Cstra-Device: 1\r\nX-Forwarded-For: 203.0.113.15\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n");
        interval = setInterval(() => socket.write("1\r\nx\r\n"), 200);
      });
      socket.on("data", data => { responseAt ||= Date.now(); response += data.toString(); });
      socket.once("error", reject);
      socket.once("close", resolve);
    });
    expect(rejected).toBe(1);
    expect(response).toContain("HTTP/1.1 401");
    expect(response.toLowerCase()).toContain("connection: close");
    expect(responseAt - began).toBeLessThan(2_000);
    expect(Date.now() - began).toBeLessThan(7_000);
  } finally {
    clearInterval(interval); clearTimeout(deadline);
    socket.destroy(); srv.stop(true);
  }
}, 10_000);
