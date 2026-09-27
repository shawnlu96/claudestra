/**
 * 中继链路的 bridge 侧：peerFetch 对 relay:// 的转换与错误映射（假客户端注入）、入站分流（relay-inbound.ts：
 * 隧道 → 本机 Web、peer → 验签 → peer 入口）、peers.json 里的中继地址与邀请载荷的指纹。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint, signedHeaders } from "../src/lib/instance-key.js";
import { peerFetch, relayInfo, setRelayClientForTest } from "../src/bridge/relay-link.js";
import { makeInboundHandler, relayMark, ReplayCache, verifyPeerRequest } from "../src/bridge/relay-inbound.js";
import { RelayError, type RelayClient, type RelayRequest, type RelayResponse } from "../src/lib/relay-client.js";
import { encodePeerInviteV2, inviteLink, isPeerBaseUrl, parsePeerInviteV2, relayPeerFingerprint, relayUrlOf } from "../src/lib/peers.js";
import { collectBody } from "../src/lib/relay-stream.js";

const FP = "16f9-b5d1-30fb-8923";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const bodyStream = (s: string) => new ReadableStream<Uint8Array>({ start: (c) => { if (s) c.enqueue(enc(s)); c.close(); } });

function fakeClient(answer: (to: string, req: RelayRequest) => Promise<RelayResponse>): RelayClient {
  return { request: (to: string, req: RelayRequest) => answer(to, req), info: () => ({ connected: true, state: "online", fp: "0", slug: "s", base: "b" }), peers: () => [] } as unknown as RelayClient;
}
const reply = (status: number, body: string, headers: Record<string, string> = {}): RelayResponse => ({ status, headers, body: bodyStream(body) });

describe("relay:// 基址与邀请载荷", () => {
  test("认 http(s):// 与 relay://<指纹>；relayUrlOf / inviteLink", () => {
    expect(isPeerBaseUrl("https://x.example/")).toBe(true);
    expect(isPeerBaseUrl(`relay://${FP.toUpperCase()}/`)).toBe(true);
    expect(isPeerBaseUrl("relay://not-a-fingerprint")).toBe(false);
    expect(isPeerBaseUrl(42)).toBe(false);
    expect(relayPeerFingerprint(`relay://${FP.toUpperCase()}`)).toBe(FP);
    expect(relayUrlOf(FP.toUpperCase())).toBe(`relay://${FP}`);
    expect(inviteLink("relay.example.com", "eyJ2IjoyLA")).toBe("https://relay.example.com/i#eyJ2IjoyLA");
  });
  test("邀请载荷带邀请方指纹；形状不对就当没带", () => {
    const base = { v: 2 as const, name: "Shawn", url: `relay://${FP}`, token: "t".repeat(20), join: "j".repeat(20) };
    expect(parsePeerInviteV2(encodePeerInviteV2({ ...base, fp: FP.toUpperCase() }))).toMatchObject({ url: `relay://${FP}`, fp: FP });
    expect(parsePeerInviteV2(encodePeerInviteV2({ ...base, fp: "garbage" }))!.fp).toBeUndefined();
    expect(parsePeerInviteV2(encodePeerInviteV2(base))!.fp).toBeUndefined();
  });
});

describe("peerFetch", () => {
  test("非 relay 地址原样交给 fetchImpl；没启用中继时 relay:// 直接报错", async () => {
    setRelayClientForTest(null);
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => { seen.push(url); return new Response("ok"); }) as unknown as typeof fetch;
    expect(await (await peerFetch("https://x.example/api/v1/agents", {}, { fetchImpl })).text()).toBe("ok");
    expect(seen).toEqual(["https://x.example/api/v1/agents"]);
    await expect(peerFetch(`relay://${FP}/api/v1/agents`, {})).rejects.toThrow(/relay 未启用/);
    expect(relayInfo()).toMatchObject({ connected: false, fp: null, url: null });
  });
  test("relay://：指纹当 to，路径含查询串，头小写，正文原样；响应流包回 Response", async () => {
    let got: { to: string; req: RelayRequest } | null = null;
    setRelayClientForTest(fakeClient(async (to, req) => { got = { to, req }; return reply(202, '{"threadId":"t1"}', { "content-type": "application/json" }); }));
    const r = await peerFetch(`relay://${FP}/api/v1/threads/t1?since=5`, { method: "post", headers: { Authorization: "Bearer tok", "X-Claudestra-Ts": "1" }, body: '{"text":"hi"}' });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ threadId: "t1" });
    expect(got!.to).toBe(FP);
    expect(got!.req).toMatchObject({ method: "POST", path: "/api/v1/threads/t1?since=5", headers: { authorization: "Bearer tok", "x-claudestra-ts": "1" } });
    expect(dec(got!.req.body as Uint8Array)).toBe('{"text":"hi"}');
  });
  test("204 不带 body；超时类错误抛 TimeoutError，其余带 code 的普通 Error", async () => {
    setRelayClientForTest(fakeClient(async () => reply(204, "")));
    expect((await peerFetch(`relay://${FP}/api/v1/x`, {})).status).toBe(204);
    setRelayClientForTest(fakeClient(async () => { throw new RelayError("peer_disconnected", "relay", "gone"); }));
    await expect(peerFetch(`relay://${FP}/api/v1/x`, {})).rejects.toMatchObject({ name: "TimeoutError" });
    setRelayClientForTest(fakeClient(async () => { throw new RelayError("peer_offline", "relay"); }));
    await expect(peerFetch(`relay://${FP}/api/v1/x`, {})).rejects.toMatchObject({ name: "Error", message: "relay peer_offline: peer_offline" });
    setRelayClientForTest(null);
  });
});

describe("入站分流（relay-inbound.ts）", () => {
  const key = instanceKeySync(mkdtempSync(join(tmpdir(), "relay-link-")))!;
  const myFp = keyFingerprint(key.publicKey);
  const NOW = Date.now();
  type Call = { url: string; init: RequestInit };
  function harness(answer: (c: Call) => Response, ingress: string | null = "http://127.0.0.1:1") {
    const calls: Call[] = [];
    let redeemed = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return answer({ url, init }); }) as unknown as typeof fetch;
    const handler = makeInboundHandler({ webBase: "http://127.0.0.1:2", ingressBase: () => ingress, fetchImpl, now: () => NOW, onRedeemed: () => redeemed++ });
    return { handler, calls, redeemed: () => redeemed };
  }
  const ctx = (from: string, signal = new AbortController().signal) => ({ from, signal });
  const signed = (method: string, path: string, body = "") => ({ ...signedHeaders(method, path, body, key, NOW) });

  test("隧道：原样打本机 Web，保留 host / x-forwarded-*，去 accept-encoding；响应去 content-encoding、Location 改 https", async () => {
    const h = harness(() => new Response("page", { status: 303, headers: { location: "http://mini.relay.test/login", "content-encoding": "gzip", "x-keep": "1" } }));
    const headers = { host: "mini.relay.test", "x-forwarded-proto": "https", "accept-encoding": "gzip", connection: "close" };
    const res = await h.handler({ method: "GET", path: "/chat?x=1", headers, body: bodyStream("") }, ctx("relay"));
    expect(h.calls[0].url).toBe("http://127.0.0.1:2/chat?x=1");
    expect(h.calls[0].init.method).toBe("GET");
    expect(h.calls[0].init.headers).toEqual({ host: "mini.relay.test", "x-forwarded-proto": "https" });
    expect(h.calls[0].init.redirect).toBe("manual");
    expect(h.calls[0].init.body).toBeUndefined();
    expect(res.status).toBe(303);
    expect(res.headers).toEqual({ location: "https://mini.relay.test/login", "x-keep": "1" });
    expect(dec(await collectBody(res.body, 100))).toBe("page");
  });
  test("隧道 POST 带正文流；Web 连不上 → local_unreachable；被取消 → local_timeout", async () => {
    const h = harness((c) => new Response(`got:${c.init.body ? "body" : "none"}`));
    const res = await h.handler({ method: "POST", path: "/api/x", headers: {}, body: bodyStream("payload") }, ctx("relay"));
    expect(h.calls[0].init.body).toBeInstanceOf(ReadableStream);
    expect(dec(await collectBody(res.body, 100))).toBe("got:body");
    const down = harness(() => { throw new Error("ECONNREFUSED"); });
    await expect(down.handler({ method: "GET", path: "/", headers: {}, body: bodyStream("") }, ctx("relay"))).rejects.toMatchObject({ code: "local_unreachable" });
    const ac = new AbortController();
    const aborted = harness(() => { ac.abort(); throw new Error("aborted"); });
    await expect(aborted.handler({ method: "GET", path: "/", headers: {}, body: bodyStream("") }, ctx("relay", ac.signal))).rejects.toMatchObject({ code: "local_timeout" });
  });
  test("peer：不在 /api/v1 下拒；验签通过后打 peer 入口并盖 relay-from；兑换成功触发 onRedeemed", async () => {
    const h = harness(() => new Response('{"ok":true}', { status: 200 }));
    await expect(h.handler({ method: "GET", path: "/hook", headers: {}, body: bodyStream("") }, ctx(myFp))).rejects.toMatchObject({ code: "path_forbidden" });
    const body = '{"join":"x"}';
    const headers = { ...signed("POST", "/api/v1/peers/redeem", body), host: "evil", "x-forwarded-for": "1.2.3.4", "x-claudestra-relay-from": "spoof", authorization: "Bearer t" };
    const res = await h.handler({ method: "POST", path: "/api/v1/peers/redeem", headers, body: bodyStream(body) }, ctx(myFp));
    expect(res.status).toBe(200);
    expect(h.calls[0].url).toBe("http://127.0.0.1:1/api/v1/peers/redeem");
    const sent = h.calls[0].init.headers as Record<string, string>;
    expect(sent["x-claudestra-relay-from"]).toBe(myFp);
    expect(sent["x-claudestra-relay-mark"]).toBe(relayMark()); // peer 入口凭它相信 relay-from（直连 peer 伪造不了）
    expect(sent.host).toBeUndefined();
    expect(sent["x-forwarded-for"]).toBeUndefined();
    expect(sent.authorization).toBe("Bearer t");
    expect(dec(h.calls[0].init.body as Uint8Array)).toBe(body);
    expect(h.redeemed()).toBe(1);
    const noIngress = harness(() => new Response("x"), null);
    const probe = { method: "GET", path: "/api/v1/agents", headers: signed("GET", "/api/v1/agents"), body: bodyStream("") };
    await expect(noIngress.handler(probe, ctx(myFp))).rejects.toMatchObject({ code: "local_unreachable" });
  });
  test("verifyPeerRequest：缺头 / 指纹不符 / 签名不对 / 过期 / 重放", () => {
    const cache = new ReplayCache(1000);
    const req = (h: Record<string, string>, body = "b") => ({ method: "POST", path: "/api/v1/x", headers: h, body: enc(body) });
    expect(verifyPeerRequest(myFp, req({}), cache, NOW)?.message).toMatch(/missing/);
    expect(verifyPeerRequest("0000-0000-0000-0000", req(signed("POST", "/api/v1/x", "b")), cache, NOW)?.message).toMatch(/does not match/);
    expect(verifyPeerRequest(myFp, req(signed("POST", "/api/v1/x", "b"), "other"), cache, NOW)?.message).toMatch(/mismatch/);
    expect(verifyPeerRequest(myFp, req(signed("POST", "/api/v1/x", "b")), cache, NOW + 301_000)?.message).toMatch(/300 s/);
    const good = signed("POST", "/api/v1/x", "b");
    expect(verifyPeerRequest(myFp, req(good), cache, NOW)).toBeNull();
    expect(verifyPeerRequest(myFp, req(good), cache, NOW + 10)?.code).toBe("replay");
    expect(verifyPeerRequest(myFp, req(good), cache, NOW + 2000)).toBeNull(); // 缓存过期后同一签名又能用（时间戳仍在 ±300 s 内）
    const get = { method: "GET", path: "/api/v1/agents", headers: signed("GET", "/api/v1/agents"), body: enc("") };
    expect(verifyPeerRequest(myFp, get, cache, NOW)).toBeNull();
    expect(verifyPeerRequest(myFp, get, cache, NOW)).toBeNull();
  });
});
