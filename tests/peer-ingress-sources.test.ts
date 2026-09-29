/**
 * peer 入口按 socket 来源分类（bridge/peer-ingress.ts ingressRequest）与 peer-ingress 来源下的权限：
 *   a. 回环 socket、没有中继标记 = 本机反代 → 来源 lan，设备 cookie 照认；
 *   b. 非回环 socket（对外直连）→ 来源 peer-ingress，删 cookie / 设备头，不带凭据只放兑换与邀请页；
 *   c. 中继 peer 帧（进程内标记）→ 同 b，带发件人指纹；
 *   d. 设备端点、设备凭据在 peer-ingress 下一律拒；legacy-session 只认 loopback / lan。
 * 另有控制面闸门：带隧道标记的请求即使缺了 XFF 也不算回环（bridge/relay-inbound.ts socketTrust）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingressRequest } from "../src/bridge/peer-ingress.js";
import { makeInboundHandler, RELAY_MARK_HEADER, relayMark, socketTrust, TUNNEL_MARK_HEADER } from "../src/bridge/relay-inbound.js";
import { requestContextOf, setRequestContext, type RequestSource } from "../src/bridge/request-context.js";
import { handleDevicesPublic } from "../src/bridge/devices.js";
import { authenticateApi } from "../src/bridge/api-auth.js";
import { setWebStatePathForTest } from "../src/bridge/local-api/db.js";
import { closeWebState } from "../src/lib/web-state.js";
import { DEVICE_HEADER } from "../src/lib/devices.js";

const FP = "16f9-b5d1-30fb-8923";
type Seen = { source: RequestSource; relayFrom?: string; cookie: string | null; device: string | null; path: string };

function capture() {
  const seen: Seen[] = [];
  const api = async (req: Request) => {
    const c = requestContextOf(req);
    seen.push({ source: c.source, ...(c.relayFrom ? { relayFrom: c.relayFrom } : {}), cookie: req.headers.get("cookie"), device: req.headers.get(DEVICE_HEADER), path: new URL(req.url).pathname });
    return new Response("{}");
  };
  return { seen, api };
}
const browser = { cookie: "cstra_dev=abc", [DEVICE_HEADER]: "1" };

describe("peer 入口的四类来源", () => {
  test("a：回环 socket、没有中继标记（本机反代）→ lan，cookie 与设备头原样交给 API", async () => {
    const { seen, api } = capture();
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const res = await ingressRequest(new Request("http://127.0.0.1:1/api/v1/agents", { headers: browser }), api, addr);
      expect(res.status).toBe(200);
    }
    expect(seen.every((s) => s.source === "lan" && s.cookie === browser.cookie && s.device === "1")).toBe(true);
  });
  test("b：非回环 socket → peer-ingress，删掉 cookie 与设备头；不带凭据只放兑换与邀请页", async () => {
    const { seen, api } = capture();
    const at = (path: string, init: RequestInit = {}) => ingressRequest(new Request(`http://127.0.0.1:1${path}`, { ...init, headers: { ...browser, ...(init.headers as object) } }), api, "100.64.0.9");
    expect((await at("/api/v1/agents")).status).toBe(403);
    expect((await at("/api/v1/devices/pair/challenge")).status).toBe(403);
    expect((await at("/api/v1/invite")).status).toBe(200);
    expect((await at("/api/v1/peers/redeem", { method: "POST", body: "{}" })).status).toBe(200);
    expect(seen.map((s) => [s.source, s.cookie, s.device, s.path])).toEqual([
      ["peer-ingress", null, null, "/api/v1/invite"], ["peer-ingress", null, null, "/api/v1/peers/redeem"],
    ]);
  });
  test("c：中继 peer 帧（标记核过）→ peer-ingress + 发件人指纹，cookie 删掉；回环 socket 也不当本机反代", async () => {
    const { seen, api } = capture();
    const headers = { ...browser, "x-claudestra-relay-from": FP, [RELAY_MARK_HEADER]: relayMark() };
    await ingressRequest(new Request("http://127.0.0.1:1/api/v1/peers/redeem", { method: "POST", headers, body: "{}" }), api, "127.0.0.1");
    expect(seen).toEqual([{ source: "peer-ingress", relayFrom: FP, cookie: null, device: null, path: "/api/v1/peers/redeem" }]);
  });
  test("回环 socket 但带隧道标记头（不论值）→ 不当本机反代，按 peer-ingress 处理", async () => {
    const { seen, api } = capture();
    const headers = { ...browser, [TUNNEL_MARK_HEADER]: "anything" };
    expect((await ingressRequest(new Request("http://127.0.0.1:1/api/v1/agents", { headers }), api, "127.0.0.1")).status).toBe(403);
    await ingressRequest(new Request("http://127.0.0.1:1/api/v1/invite", { headers }), api, "127.0.0.1");
    expect(seen).toEqual([{ source: "peer-ingress", cookie: null, device: null, path: "/api/v1/invite" }]);
  });
  test("网页端口与 peer 入口是同一个端口：隧道一律 local_unreachable，fetch 一次都不调", async () => {
    const calls: string[] = [];
    const handler = makeInboundHandler({ webBase: "http://127.0.0.1:3333", ingressBase: () => "http://127.0.0.1:3333", refusePeer: async () => null,
      fetchImpl: (async (u: string) => { calls.push(u); return new Response("x"); }) as unknown as typeof fetch });
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    await expect(handler({ method: "GET", path: "/api/v1/agents", headers: {}, body }, { from: "relay", signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "local_unreachable" });
    expect(calls).toEqual([]);
  });
  test("隧道把 path 改写成打到 peer 入口：被同源断言拦住，到不了 a 类（fetch 一次都不调）", async () => {
    const calls: string[] = [];
    const handler = makeInboundHandler({ webBase: "http://127.0.0.1:2", ingressBase: () => "http://127.0.0.1:1", refusePeer: async () => null,
      fetchImpl: (async (u: string) => { calls.push(u); return new Response("x"); }) as unknown as typeof fetch });
    const body = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    await expect(handler({ method: "GET", path: "@127.0.0.1:1/api/v1/agents", headers: browser, body }, { from: "relay", signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "path_forbidden" });
    expect(calls).toEqual([]);
  });
});

describe("peer-ingress 来源下的权限矩阵（设备端点、设备凭据、控制面）", () => {
  const withSource = (source: RequestSource, path: string, init: RequestInit = {}) => {
    const r = new Request(`http://127.0.0.1:1${path}`, init);
    setRequestContext(r, { source, clientIp: null, https: false });
    return r;
  };
  const DEVICE_ENDPOINTS: Array<[string, string]> = [
    ["GET", "/api/v1/devices/pair/challenge"], ["POST", "/api/v1/devices/pair"], ["GET", "/api/v1/devices/pair/status"],
    ["POST", "/api/v1/devices/local"], ["POST", "/api/v1/devices/legacy-session"],
  ];
  test("设备端点：peer-ingress 一律 403", async () => {
    for (const [method, path] of DEVICE_ENDPOINTS) {
      const r = withSource("peer-ingress", path, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      expect((await handleDevicesPublic(r, new URL(r.url)))?.status).toBe(403);
    }
  });
  describe("legacy-session 只认 loopback / lan（请求带齐设备头与旧会话 cookie，结果只由来源决定）", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "legacy-src-"));
      setWebStatePathForTest(join(dir, "web-state.sqlite"));
    });
    afterAll(() => {
      closeWebState(join(dir, "web-state.sqlite"));
      setWebStatePathForTest(undefined);
      rmSync(dir, { recursive: true, force: true });
    });
    const legacy = async (source: RequestSource) => {
      const r = withSource(source, "/api/v1/devices/legacy-session", { method: "POST", headers: { [DEVICE_HEADER]: "1", cookie: "cstra_session=nope" }, body: "{}" });
      const res = (await handleDevicesPublic(r, new URL(r.url)))!;
      return [res.status, ((await res.json()) as { code?: string }).code];
    };
    test("relay → 404 no_legacy_session；peer-ingress、unknown → 403（设备端点整体不开）", async () => {
      expect(await legacy("relay")).toEqual([404, "no_legacy_session"]);
      expect((await legacy("peer-ingress"))[0]).toBe(403);
      expect((await legacy("unknown"))[0]).toBe(403);
    });
    test("对照：loopback / lan 走到会话核对，旧会话不认识 → 401 legacy_session_invalid", async () => {
      expect(await legacy("loopback")).toEqual([401, "legacy_session_invalid"]);
      expect(await legacy("lan")).toEqual([401, "legacy_session_invalid"]);
    });
  });
  test("设备 cookie 经 peer-ingress 来 → 403（不当成设备身份）", async () => {
    const r = withSource("peer-ingress", "/api/v1/agents", { headers: { cookie: "cstra_dev=abc" } });
    const res = await authenticateApi(r, new URL(r.url), { rateLimit: false });
    expect(res instanceof Response ? res.status : 200).toBe(403);
  });
  test("控制面：带隧道标记的请求缺了 XFF 也不算回环；真本机不受影响", async () => {
    const sent: Record<string, string>[] = [];
    const handler = makeInboundHandler({ webBase: "http://127.0.0.1:2", ingressBase: () => null, refusePeer: async () => null,
      fetchImpl: (async (_u: string, init: RequestInit) => { sent.push(init.headers as Record<string, string>); return new Response("x"); }) as unknown as typeof fetch });
    await handler({ method: "GET", path: "/hook", headers: {}, body: new ReadableStream({ start: (c) => c.close() }) }, { from: "relay", signal: new AbortController().signal });
    const { "x-forwarded-for": _xff, ...noXff } = sent[0]!;
    const tunnelled = new Request("http://127.0.0.1:3847/hook", { headers: noXff });
    expect(socketTrust(tunnelled, "127.0.0.1")).toBe(false); // 只看 socket 与 XFF 会被当成本机，隧道标记把它排除
    expect(requestContextOf(tunnelled).source).toBe("relay");
    const local = new Request("http://127.0.0.1:3847/hook");
    expect(socketTrust(local, "127.0.0.1")).toBe(true);
    expect(requestContextOf(local).source).toBe("loopback");
  });
});
