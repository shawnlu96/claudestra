/**
 * 中继进 bridge 的各条路待遇一致（bridge/relay-inbound.ts socketTrust、bridge/api-auth.ts）：
 * 隧道请求来源定成 relay（peer token 403、不算同机）；兑换只认 peer 入口核过的发件人或兑换请求自带的签名；
 * peer 先验签再扣限速；删掉后同名重加 / 重新邀请能改钉。状态文件写在 preload 的临时 STATE_DIR，peer 名各用各的。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint, signedHeaders } from "../src/lib/instance-key.js";
import { STATE_DIR } from "../src/lib/paths.js";
import { authenticateApi } from "../src/bridge/api-auth.js";
import { peerReplayVerdict } from "../src/bridge/peer-signature.js";
import { redeemRefusal, redeemSender, relaySenderFp } from "../src/bridge/peer-redeem.js";
import { peerAuthHint } from "../src/lib/peer-auth-hints.js";
import { makeInboundHandler, socketTrust } from "../src/bridge/relay-inbound.js";
import { dispatchMachineRequest } from "../src/bridge/relay-dispatch.js";
import { requestContextOf, setRequestContext } from "../src/bridge/request-context.js";
import { handleHost } from "../src/bridge/local-api/host.js";
import { handleDevicesPublic } from "../src/bridge/devices.js";
import { DEVICE_HEADER } from "../src/lib/devices.js";
import type { Principal } from "../src/lib/principals.js";

const newKey = () => instanceKeySync(mkdtempSync(join(tmpdir(), "relay-entry-")))!;
const keyP = newKey(), keyQ = newKey(), keyQ2 = newKey(), keyG = newKey();
const fpP = keyFingerprint(keyP.publicKey), fpQ2 = keyFingerprint(keyQ2.publicKey);
const TOK = { p: "p".repeat(48), q: "q".repeat(48), g: "g".repeat(48) };
const empty = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });

/** 模拟 bridge 主端口 / 旧 web 端口：socket 是回环，调 bridgeFetch 用的同一个 socketTrust；loopback 记下闸门结果 */
const gate = new WeakMap<Request, boolean>();
function viaBridgePort(url: string, init: RequestInit, addr = "127.0.0.1"): Request {
  const r = new Request(`http://127.0.0.1:3333${new URL(url).pathname}${new URL(url).search}`, init);
  gate.set(r, socketTrust(r, addr));
  return r;
}
/** 经 forwardTunnel 打到 bridge 端口，交给 handle 处理 */
async function viaTunnel(path: string, headers: Record<string, string>, handle: (r: Request) => Promise<Response>, method = "GET"): Promise<Response> {
  const h = makeInboundHandler({
    webBase: "http://127.0.0.1:3333", ingressBase: () => null, refusePeer: async () => null,
    fetchImpl: (async (url: string, init: RequestInit) => handle(viaBridgePort(url, init))) as unknown as typeof fetch,
  });
  const body = method === "GET" ? empty() : new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new TextEncoder().encode("{}")), c.close()) });
  const res = await h({ method, path, headers, body }, { from: "relay", signal: new AbortController().signal });
  return new Response(res.body, { status: res.status, headers: res.headers });
}

beforeAll(() => {
  const principal = (id: string, secret: string, peer: string) => ({ id: `token:${id}`, role: "external", name: id, agents: ["*"], secret, createdAt: "2026-09-01T00:00:00Z", peer });
  writeFileSync(join(STATE_DIR, "principals.json"), JSON.stringify({ principals: [principal("tok_re_p", TOK.p, "re-p"), principal("tok_re_q", TOK.q, "re-q"), principal("tok_re_g", TOK.g, "re-g")] }));
  writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [
    { name: "re-p", fp: fpP, inTokenId: "tok_re_p", addedAt: "2026-09-01T00:00:00.000Z" },
    { name: "re-q", baseUrl: "https://q.example", inTokenId: "tok_re_q", addedAt: "2026-09-01T00:00:00.000Z" },
    { name: "re-g", fp: keyFingerprint(keyG.publicKey), inTokenId: "tok_re_g", addedAt: "2026-09-01T00:00:00.000Z" },
  ] }));
});
afterAll(() => {
  for (const f of ["principals.json", "peers.json", "peer-keys.json"]) rmSync(join(STATE_DIR, f), { force: true });
});

const PATH = "/api/v1/agents";
const status = async (r: Request, rateLimit = false) => {
  const p = await authenticateApi(r, new URL(r.url), { rateLimit });
  return p instanceof Response ? p.status : 200;
};
function direct(token: string, key?: typeof keyP, method = "GET", body = ""): Request {
  const r = new Request(`http://127.0.0.1:1${PATH}`, { method, headers: { authorization: `Bearer ${token}`, ...(key ? signedHeaders(method, PATH, body, key) : {}) }, ...(body ? { body } : {}) });
  setRequestContext(r, { source: "lan", clientIp: null, https: false });
  return r;
}

describe("隧道：中继不带模式头走旧子域名隧道，进 bridge 端口后来源是 relay", () => {
  test("带 peer token（签名正确）→ 403；标记是 forwardTunnel 加的，中继自己塞的同名头被剥掉", async () => {
    const got: number[] = [];
    const h = makeInboundHandler({
      webBase: "http://127.0.0.1:3333", ingressBase: () => null, refusePeer: async () => null,
      fetchImpl: (async (url: string, init: RequestInit) => {
        const r = viaBridgePort(url, init);
        expect(requestContextOf(r).source).toBe("relay");
        const p = await authenticateApi(r, new URL(r.url), { rateLimit: false });
        got.push(p instanceof Response ? p.status : 200);
        return p instanceof Response ? p : new Response("ok");
      }) as unknown as typeof fetch,
    });
    const headers = { authorization: `Bearer ${TOK.p}`, ...signedHeaders("GET", PATH, "", keyP), "x-forwarded-for": "203.0.113.9", "x-claudestra-tunnel-mark": "guess" };
    const res = await h({ method: "GET", path: PATH, headers, body: empty() }, { from: "relay", signal: new AbortController().signal });
    expect(res.status).toBe(403);
    expect(got).toEqual([403]);
  });
  test("中继伪造 XFF 为回环：/host 也不认本机；没有标记（或标记不对）的普通反代请求照旧是 lan", async () => {
    let seen: Request | null = null;
    const h = makeInboundHandler({
      webBase: "http://127.0.0.1:3333", ingressBase: () => null, refusePeer: async () => null,
      fetchImpl: (async (url: string, init: RequestInit) => ((seen = viaBridgePort(url, init)), new Response("ok"))) as unknown as typeof fetch,
    });
    await h({ method: "GET", path: "/api/v1/host", headers: { "x-forwarded-for": "127.0.0.1" }, body: empty() }, { from: "relay", signal: new AbortController().signal });
    const owner = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "" } as Principal;
    expect(await (await handleHost(seen!, "/host", owner))!.json()).toMatchObject({ local: false });
    const proxied = viaBridgePort("http://x/api/v1/host", { headers: { "x-forwarded-for": "127.0.0.1", "x-claudestra-tunnel-mark": "guess" } });
    expect(requestContextOf(proxied).source).toBe("lan");
    expect(proxied.headers.get("x-claudestra-tunnel-mark")).toBeNull();
    expect(requestContextOf(viaBridgePort("http://x/", {})).source).toBe("loopback");
  });
  test("带 XFF 的隧道请求：来源 relay、不算本机，legacy-session 404", async () => {
    let seen: Request | null = null;
    const res = await viaTunnel("/api/v1/devices/legacy-session", { "x-forwarded-for": "203.0.113.9", cookie: "cstra_session=s", [DEVICE_HEADER]: "1" },
      async (r) => ((seen = r), (await handleDevicesPublic(r, new URL(r.url)))!), "POST");
    expect(requestContextOf(seen!)).toMatchObject({ source: "relay", clientIp: "203.0.113.9", https: true });
    expect(gate.get(seen!)).toBe(false);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no_legacy_session" });
  });
  test("每个请求都定来源：本机反代带 XFF → lan，clientIp 是 socket 地址、https 跟随 x-forwarded-proto；局域网直连同样有上下文", () => {
    const proxied = viaBridgePort("http://x/api/v1/agents", { headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" } });
    expect(requestContextOf(proxied)).toEqual({ source: "lan", clientIp: "127.0.0.1", https: true });
    expect(gate.get(proxied)).toBe(false);
    const plain = viaBridgePort("http://x/api/v1/agents", { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(requestContextOf(plain).https).toBe(false);
    const lan = viaBridgePort("http://x/api/v1/agents", {}, "192.168.1.5");
    expect(requestContextOf(lan)).toEqual({ source: "lan", clientIp: "192.168.1.5", https: false });
    expect(gate.get(lan)).toBe(false);
    expect(gate.get(viaBridgePort("http://x/hook", {}))).toBe(true);
  });
});

describe("没设过来源上下文的请求：各白名单都不认", () => {
  test("peer token、设备 cookie、兑换、设备端点一律拒", async () => {
    const bare = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:1${path}`, init);
    expect(requestContextOf(bare("/")).source).toBe("unknown");
    expect(await status(bare(PATH, { headers: { authorization: `Bearer ${TOK.p}`, ...signedHeaders("GET", PATH, "", keyP) } }))).toBe(403);
    expect(await status(bare(PATH, { headers: { cookie: "cstra_dev=abc" } }))).toBe(403);
    expect(redeemRefusal(bare("/api/v1/peers/redeem", { method: "POST", body: "{}" }))?.status).toBe(403);
    const pair = bare("/api/v1/devices/pair/challenge");
    expect((await handleDevicesPublic(pair, new URL(pair.url)))?.status).toBe(403);
  });
});

describe("兑换邀请：来源与发件人指纹", () => {
  const redeem = (headers: Record<string, string>, body = '{"join":"j","name":"n"}') =>
    new Request("http://127.0.0.1:1/api/v1/peers/redeem", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  test("经中继（隧道或路径模式，source=relay）→ 403；直连 / peer 入口放行", () => {
    const r = redeem({});
    setRequestContext(r, { source: "relay", clientIp: null, https: true });
    expect(redeemRefusal(r)?.status).toBe(403);
    const l = redeem({});
    setRequestContext(l, { source: "lan", clientIp: null, https: false });
    expect(redeemRefusal(l)).toBeNull();
  });
  test("直连兑换：签名对得上取签名钥匙指纹；不签 / 正文被换 / 伪造来源头都拿不到；读完正文仍可用", async () => {
    const body = '{"join":"j","name":"n"}';
    const signed = redeem(signedHeaders("POST", "/api/v1/peers/redeem", body, keyQ2), body);
    expect(await redeemSender(signed)).toEqual({ fp: fpQ2, pk: keyQ2.publicKey });
    expect(await signed.json()).toEqual({ join: "j", name: "n" });
    expect((await redeemSender(redeem({ "x-claudestra-relay-from": fpP }))).fp).toBe("");
    expect((await redeemSender(redeem(signedHeaders("POST", "/api/v1/peers/redeem", body, keyQ2), '{"join":"j","name":"other"}'))).fp).toBe("");
    const relayed = redeem({});
    setRequestContext(relayed, { source: "lan", clientIp: null, https: false, relayFrom: fpP });
    expect((await redeemSender(relayed)).fp).toBe(fpP);
  });
  test("路径模式 dispatch 出来的请求读不到来源指纹（即使中继在帧里写了）", async () => {
    let fp = "x";
    await dispatchMachineRequest({ method: "GET", path: PATH, headers: { "x-claudestra-relay-from": fpP, "x-claudestra-relay-mode": "api" }, body: empty() },
      { from: "relay", signal: new AbortController().signal }, async (r) => ((fp = relaySenderFp(r)), new Response("ok")));
    expect(fp).toBe("");
  });
});

describe("先验签再扣限速；改钉", () => {
  test("验签失败单独限流（每分钟 120 次，超了 429），且不消耗正牌 peer 的额度", async () => {
    for (let i = 0; i < 120; i++) expect(await status(direct(TOK.p), true)).toBe(401);
    for (let i = 0; i < 10; i++) expect(await status(direct(TOK.p, keyQ), true)).toBe(429);
    const limited = await authenticateApi(direct(TOK.p, keyQ), new URL(`http://127.0.0.1:1${PATH}`), { rateLimit: true });
    expect(await (limited as Response).json()).toMatchObject({ code: "peer_signature", reason: "sig_rate_limited", cause: "key_changed" });
    expect(peerAuthHint({ code: "peer_signature", reason: "sig_rate_limited", cause: "stale" })).toMatch(/限流.*stale/);
    expect(await status(direct(TOK.p, keyP), true)).toBe(200);
  });
  test("同一条签名 GET 重复出现：只第一次扣成功限速桶，超过 5 次按重放拒；正牌新请求照常", async () => {
    const at = Date.now();
    const get = (path: string) => {
      const r = new Request(`http://127.0.0.1:1${path}`, { headers: { authorization: `Bearer ${TOK.g}`, ...signedHeaders("GET", path, "", keyG, at) } });
      setRequestContext(r, { source: "lan", clientIp: null, https: false });
      return r;
    };
    const once = async (r: Request) => {
      const p = await authenticateApi(r, new URL(r.url), { rateLimit: true });
      return p instanceof Response ? `${p.status}:${((await p.json()) as { reason?: string }).reason ?? ""}` : "200";
    };
    for (let i = 0; i < 119; i++) expect(await once(get(`${PATH}?i=${i}`))).toBe("200");
    for (let i = 0; i < 4; i++) expect(await once(get(`${PATH}?i=0`))).toBe("200"); // 重复的不扣桶（第 2～5 次）
    expect(await once(get(`${PATH}?i=0`))).toBe("401:replay"); // 第 6 次
    expect(await once(get(`${PATH}?i=fresh`))).toBe("200"); // 桶里还剩 1 格
    expect(await once(get(`${PATH}?i=fresh2`))).toBe("429:rate_limited");
  });
  test("不限速的路由（远程终端）不收 peer token：签名对也 403，不碰防重放缓存", async () => {
    const r = direct(TOK.p, keyP, "POST", '{"data":"x"}');
    const p = await authenticateApi(r, new URL(r.url), { rateLimit: false, peers: false });
    expect(p instanceof Response && p.status).toBe(403);
    expect(await (p as Response).json()).toMatchObject({ code: "peer_route_forbidden" });
  });
  test("只钉住过的 peer：对方重装后按签名兑换重新加入（记录有了 fp）→ 改钉新钥匙；删掉后同名重加 → 旧钉住作废", async () => {
    expect(await status(direct(TOK.q, keyQ))).toBe(200); // 钉住 Q
    expect(await status(direct(TOK.q, keyQ2))).toBe(401); // 对方换了钥匙
    const set = (rec: object) => writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [
      { name: "re-p", fp: fpP, inTokenId: "tok_re_p", addedAt: "2026-09-01T00:00:00.000Z" }, rec,
    ] }));
    set({ name: "re-q", baseUrl: "https://q.example", inTokenId: "tok_re_q", addedAt: "2026-09-01T00:00:00.000Z", fp: fpQ2 }); // 签名兑换写进的 fp
    expect(await status(direct(TOK.q, keyQ2))).toBe(200);
    expect(await status(direct(TOK.q, keyQ))).toBe(401);
    set({ name: "re-q", baseUrl: "https://q.example", inTokenId: "tok_re_q", addedAt: new Date(Date.now() + 1000).toISOString() }); // 删掉后同名重加，没有 fp
    expect(await status(direct(TOK.q, keyQ))).toBe(200); // 之前钉的 Q2 早于新记录，不作数，按新对方重新钉
  });
});

test("签于本进程启动之前的 GET：按第一次放行并扣额度，不按 before_start 拒；非 GET 照拒", () => {
  const ts = "1000"; // 必定早于防重放缓存建立（整套测试共用一个进程，模块可能早就加载了）
  const sig = Buffer.from(`early-${Date.now()}`).toString("base64url");
  expect(peerReplayVerdict({ sig, ts, idempotent: true }, "re-early")).toEqual({ reject: false, charge: true });
  expect(peerReplayVerdict({ sig, ts, idempotent: false }, "re-early")).toEqual({ reject: "before_start", charge: true });
});
