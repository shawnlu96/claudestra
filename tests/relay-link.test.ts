/**
 * 中继链路的 bridge 侧：peerFetch 对 relay:// 的转换与错误映射（客户端库本身在 claudestra-relay 仓库测）。
 */
import { describe, test, expect } from "bun:test";
import { peerFetch, relayConfig, setRelayClientForTest } from "../src/bridge/relay-link.js";
import { RelayError, type RelayRequest, type RelayResponse } from "../src/lib/relay-client.js";
import { isPeerBaseUrl, relayPeerFingerprint } from "../src/lib/peers.js";

const FP = "16f9-b5d1-30fb-8923";

function fakeClient(answer: (to: string, req: RelayRequest) => Promise<RelayResponse>) {
  return {
    fingerprint: "0000-0000-0000-0000",
    state: "online" as const,
    request: (to: string, req: RelayRequest) => answer(to, req),
    peers: () => [],
    onPresence: () => () => {},
    onStateChange: () => () => {},
    close: async () => {},
  };
}

describe("relay:// 基址", () => {
  test("认 http(s):// 与 relay://<指纹>，别的不认", () => {
    expect(isPeerBaseUrl("https://x.example/")).toBe(true);
    expect(isPeerBaseUrl(`relay://${FP}`)).toBe(true);
    expect(isPeerBaseUrl(`relay://${FP.toUpperCase()}/`)).toBe(true);
    expect(isPeerBaseUrl("relay://not-a-fingerprint")).toBe(false);
    expect(isPeerBaseUrl("ftp://x")).toBe(false);
    expect(isPeerBaseUrl(42)).toBe(false);
    expect(relayPeerFingerprint(`relay://${FP.toUpperCase()}`)).toBe(FP);
    expect(relayPeerFingerprint("https://x.example")).toBeNull();
  });
  test("RELAY_URL / RELAY_ORG_TOKEN 要一起配", () => {
    expect(relayConfig(() => undefined)).toBeNull();
    expect(relayConfig((k) => (k === "RELAY_URL" ? "wss://r" : undefined))).toBeNull();
    expect(relayConfig((k) => (k === "RELAY_URL" ? " wss://r " : "tok"))).toEqual({ url: "wss://r", orgToken: "tok" });
  });
});

describe("peerFetch", () => {
  test("非 relay 地址原样交给 fetchImpl", async () => {
    setRelayClientForTest(null);
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const r = await peerFetch("https://x.example/api/v1/agents", {}, { fetchImpl });
    expect(await r.text()).toBe("ok");
    expect(seen).toEqual(["https://x.example/api/v1/agents"]);
  });
  test("没启用中继时 relay:// 直接报错，不碰 fetch", async () => {
    setRelayClientForTest(null);
    await expect(peerFetch(`relay://${FP}/api/v1/agents`, {})).rejects.toThrow(/relay 未启用/);
  });
  test("relay://：指纹当 to，路径含查询串，头转小写，正文原样，响应包回 Response", async () => {
    let got: { to: string; req: RelayRequest } | null = null;
    setRelayClientForTest(fakeClient(async (to, req) => {
      got = { to, req };
      return { status: 202, headers: { "content-type": "application/json" }, body: new TextEncoder().encode('{"threadId":"t1"}') };
    }));
    const r = await peerFetch(`relay://${FP}/api/v1/threads/t1?since=5`, {
      method: "POST",
      headers: { Authorization: "Bearer tok", "X-Claudestra-Ts": "1" },
      body: '{"text":"hi"}',
    });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ threadId: "t1" });
    expect(got!.to).toBe(FP);
    expect(got!.req.method).toBe("POST");
    expect(got!.req.path).toBe("/api/v1/threads/t1?since=5");
    expect(got!.req.headers).toEqual({ authorization: "Bearer tok", "x-claudestra-ts": "1" });
    expect(new TextDecoder().decode(got!.req.body)).toBe('{"text":"hi"}');
  });
  test("204 不带 body 也能包回 Response", async () => {
    setRelayClientForTest(fakeClient(async () => ({ status: 204, headers: {}, body: new Uint8Array() })));
    const r = await peerFetch(`relay://${FP}/api/v1/x`, {});
    expect(r.status).toBe(204);
  });
  test("超时类中继错误抛 TimeoutError，其余带 code 的普通 Error", async () => {
    setRelayClientForTest(fakeClient(async () => { throw new RelayError("peer_disconnected", "relay", "gone"); }));
    await expect(peerFetch(`relay://${FP}/api/v1/x`, {})).rejects.toMatchObject({ name: "TimeoutError" });
    setRelayClientForTest(fakeClient(async () => { throw new RelayError("peer_offline", "relay"); }));
    await expect(peerFetch(`relay://${FP}/api/v1/x`, {})).rejects.toMatchObject({ name: "Error", message: "relay peer_offline: peer_offline" });
    setRelayClientForTest(null);
  });
});
