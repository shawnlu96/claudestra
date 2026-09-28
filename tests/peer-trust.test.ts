/**
 * peer 身份：期望指纹、放行裁决、中继侧发件人核对（lib/peer-trust.ts），以及它们在 authApi（bridge/api-auth.ts）、
 * 路径模式（bridge/relay-dispatch.ts）、中继 peer 帧（bridge/relay-inbound.ts）上的接线。
 * 状态文件写在 preload 给的临时 STATE_DIR 里（peers.json / principals.json），peer 名各用各的，跑完删掉。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint, signedHeaders } from "../src/lib/instance-key.js";
import { STATE_DIR } from "../src/lib/paths.js";
import {
  currentPin, expectedPeerFp, frameBearer, LEGACY_PEER_DEADLINE, legacyPeerDeadline, loadRelayPeerView, peerAnchorOf, peerAuthHint, peerSigVerdict, recordPeerFp,
  relayPeerRefusal, type RelayPeerView,
} from "../src/lib/peer-trust.js";
import { failingPeerChecks, legacyPeerChecks, orphanPeerChecks, persistentlyFailing } from "../src/lib/doctor-peers.js";
import { authenticateApi } from "../src/bridge/api-auth.js";
import { setRequestContext } from "../src/bridge/request-context.js";
import { dispatchMachineRequest } from "../src/bridge/relay-dispatch.js";
import { makeInboundHandler } from "../src/bridge/relay-inbound.js";
import { RELAY_MODE_HEADER } from "../src/lib/relay-machine-path.js";
import { collectBody } from "../src/lib/relay-stream.js";

const newKey = () => instanceKeySync(mkdtempSync(join(tmpdir(), "peer-trust-")))!;
const keyA = newKey(), keyB = newKey(), keyX = newKey();
const fpA = keyFingerprint(keyA.publicKey), fpB = keyFingerprint(keyB.publicKey), fpX = keyFingerprint(keyX.publicKey);
const TOK = { a: "a".repeat(48), b: "b".repeat(48), old: "c".repeat(48), owner: "d".repeat(48) };
const beforeDeadline = Date.now() < Date.parse(legacyPeerDeadline());

describe("期望指纹与裁决（纯逻辑）", () => {
  test("记录的 fp 优先，其次 relay:// 基址，最后钉住的；都没有 = null", () => {
    expect(recordPeerFp({ fp: fpA.toUpperCase() })).toBe(fpA);
    expect(recordPeerFp({ baseUrl: `relay://${fpB}` })).toBe(fpB);
    expect(recordPeerFp({ baseUrl: "https://he.example" })).toBeNull();
    expect(expectedPeerFp({ fp: fpA, baseUrl: `relay://${fpB}` }, fpX)).toBe(fpA);
    expect(expectedPeerFp({ baseUrl: "https://he.example" }, fpX)).toBe(fpX);
    expect(expectedPeerFp(undefined, null)).toBeNull();
  });
  test("有期望指纹只认 ok；没有的截止日前放行（legacy），之后拒", () => {
    const before = Date.parse(LEGACY_PEER_DEADLINE) - 1, after = Date.parse(LEGACY_PEER_DEADLINE);
    for (const r of ["unsigned", "bad", "stale", "key_changed"]) expect(peerSigVerdict(r, true, before)).toEqual({ allow: false, reason: r });
    expect(peerSigVerdict("ok", true, after)).toEqual({ allow: true, legacy: false });
    expect(peerSigVerdict("ok", false, after)).toEqual({ allow: true, legacy: false });
    expect(peerSigVerdict("unsigned", false, before)).toEqual({ allow: true, legacy: true });
    expect(peerSigVerdict("bad", false, before)).toEqual({ allow: true, legacy: true });
    expect(peerSigVerdict("unsigned", false, after)).toEqual({ allow: false, reason: "unanchored" });
  });
  test("帧里的凭据：Bearer，或 GET /api/v1/events 的 ?token=", () => {
    expect(frameBearer("GET", "/api/v1/agents", { authorization: "Bearer  xyz " })).toBe("xyz");
    expect(frameBearer("GET", "/api/v1/events?token=t1", {})).toBe("t1");
    expect(frameBearer("POST", "/api/v1/events?token=t1", {})).toBe("");
    expect(frameBearer("GET", "/api/v1/agents?token=t1", {})).toBe("");
  });
  test("中继发件人核对：非联系人只许兑换；带 token 的 token 主人必须就是发件人", () => {
    const view: RelayPeerView = {
      contacts: new Set([fpA]),
      bearerOwner: (s) => (s === TOK.a ? { peer: "alpha", fp: fpA } : s === TOK.old ? { peer: "old", fp: null } : null),
    };
    const get = (headers: Record<string, string> = {}, path = "/api/v1/agents") => ({ method: "GET", path, headers });
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });
    expect(relayPeerRefusal(fpA, get(auth(TOK.a)), view)).toBeNull();
    expect(relayPeerRefusal(fpA, get(), view)).toBeNull();
    expect(relayPeerRefusal(fpX, get(auth(TOK.a)), view)).toMatch(/not a contact/);
    expect(relayPeerRefusal(fpX, { method: "POST", path: "/api/v1/peers/redeem", headers: {} }, view)).toBeNull();
    expect(relayPeerRefusal(fpX, { method: "POST", path: "/api/v1/peers/redeem", headers: auth(TOK.a) }, view)).toMatch(/does not belong/);
    expect(relayPeerRefusal(fpA, get(auth(TOK.old)), view)).toMatch(/does not belong/);
    expect(relayPeerRefusal(fpA, get(auth("nope")), view)).toMatch(/not a peer token/);
    expect(relayPeerRefusal(fpX, get({}, `/api/v1/events?token=${TOK.a}`), { ...view, contacts: new Set([fpX]) })).toMatch(/does not belong/);
  });
  test("doctor：没有老 peer 不出行；截止日前 warn，之后 fail", () => {
    expect(legacyPeerChecks([])).toEqual([]);
    const before = legacyPeerChecks(["he"], Date.parse(LEGACY_PEER_DEADLINE) - 1)[0]!;
    expect(before).toMatchObject({ status: "warn", name: "peer 验签" });
    expect(before.detail).toContain("1 个老 peer");
    expect(before.detail).toContain(LEGACY_PEER_DEADLINE.slice(0, 10));
    expect(legacyPeerChecks(["he"], Date.parse(LEGACY_PEER_DEADLINE))[0]!.status).toBe("fail");
  });
});

describe("截止日覆盖、钉住记录作废、提示文案、doctor、合并锚点", () => {
  test("PEER_LEGACY_DEADLINE 可覆盖；解析不了用默认", () => {
    expect(legacyPeerDeadline("")).toBe(LEGACY_PEER_DEADLINE);
    expect(legacyPeerDeadline("not a date")).toBe(LEGACY_PEER_DEADLINE);
    expect(legacyPeerDeadline("2026-12-15")).toBe("2026-12-15T00:00:00.000Z");
  });
  test("钉住早于记录建立时间 = 之前同名的对方，不作数；之后钉的照常", () => {
    const pin = { pinnedAt: "2026-09-24T00:00:00.000Z", publicKey: "k" };
    expect(currentPin(pin, { addedAt: "2026-09-20T00:00:00.000Z" })).toBe(pin);
    expect(currentPin(pin, { addedAt: "2026-09-25T00:00:00.000Z" })).toBeUndefined();
    expect(currentPin(pin, undefined)).toBe(pin);
    expect(currentPin(undefined, { addedAt: "2026-09-25T00:00:00.000Z" })).toBeUndefined();
  });
  test("401 提示：peer_signature 按原因分开说，不再笼统叫人重新握手", () => {
    expect(peerAuthHint(null)).toMatch(/重新握手/);
    expect(peerAuthHint({ code: "peer_signature", reason: "replay" })).toMatch(/不要原样重发/);
    expect(peerAuthHint({ code: "peer_signature", reason: "stale" })).toMatch(/时间/);
    expect(peerAuthHint({ code: "peer_signature", reason: "before_start" })).toMatch(/刚重启.*校准本机时间/);
    expect(peerAuthHint({ code: "peer_signature", reason: "key_changed" })).toMatch(/重新给你发一张邀请/);
    expect(peerAuthHint({ code: "peer_signature", reason: "key_changed" })).not.toMatch(/重新握手/);
  });
  test("doctor：有期望指纹但最近验签没通过的列出来，原因带上", () => {
    expect(failingPeerChecks([])).toEqual([]);
    const c = failingPeerChecks([{ name: "he", result: "stale" }])[0]!;
    expect(c).toMatchObject({ status: "warn", name: "peer 验签失败" });
    expect(c.detail).toContain("he: stale");
  });
  test("doctor：只在持续没通过时报——10 分钟内通过过的（有人拿 token 乱签了一次）不报", () => {
    const at = "2026-09-29T10:00:00.000Z";
    expect(persistentlyFailing(undefined)).toBeNull();
    expect(persistentlyFailing({ lastCheck: { at, result: "ok" }, lastOkAt: at })).toBeNull();
    expect(persistentlyFailing({ lastCheck: { at, result: "key_changed" }, lastOkAt: "2026-09-29T09:59:00.000Z" })).toBeNull();
    expect(persistentlyFailing({ lastCheck: { at, result: "key_changed" }, lastOkAt: "2026-09-29T09:40:00.000Z" })).toBe("key_changed");
    expect(persistentlyFailing({ lastCheck: { at, result: "stale" } })).toBe("stale");
  });
  test("doctor：入站 token 的 peer 名在 peers.json 里找不到的单独列出", () => {
    expect(orphanPeerChecks([])).toEqual([]);
    expect(orphanPeerChecks(["sekai-old"])[0]).toMatchObject({ status: "warn", name: "peer 名对不上" });
  });
  test("合并用的期望指纹：记录的 fp 优先，其次仍有效的钉住钥匙；早于记录建立的钉住不算", async () => {
    const pin = (fp: string, pinnedAt: string) => ({ publicKey: "k", fingerprint: fp, pinnedAt });
    writeFileSync(join(STATE_DIR, "peer-keys.json"), JSON.stringify({ peers: {
      "an-pin": pin(fpB, "2026-09-10T00:00:00.000Z"), "an-old": pin(fpB, "2026-09-01T00:00:00.000Z"), "an-fp": pin(fpB, "2026-09-10T00:00:00.000Z"),
    } }));
    const anchorOf = await peerAnchorOf();
    const rec = (name: string, extra: object = {}) => ({ name, addedAt: "2026-09-05T00:00:00.000Z", ...extra });
    expect(anchorOf(rec("an-fp", { fp: fpA }))).toBe(fpA);
    expect(anchorOf(rec("an-pin"))).toBe(fpB);
    expect(anchorOf(rec("an-old"))).toBeNull();
    expect(anchorOf(rec("an-none"))).toBeNull();
    rmSync(join(STATE_DIR, "peer-keys.json"), { force: true });
  });
});

describe("接线：authApi / 路径模式 / 中继 peer 帧", () => {
  const principal = (id: string, secret: string, peer?: string) => ({
    id: `token:${id}`, role: peer ? "external" : "owner", name: id, agents: ["*"], secret, createdAt: "2026-09-01T00:00:00Z", ...(peer ? { peer } : {}),
  });
  beforeAll(() => {
    writeFileSync(join(STATE_DIR, "principals.json"), JSON.stringify({ principals: [
      principal("tok_pt_a", TOK.a, "pt-alpha"), principal("tok_pt_b", TOK.b, "pt-bravo"), principal("tok_pt_old", TOK.old, "pt-old"), principal("tok_pt_owner", TOK.owner),
    ] }));
    writeFileSync(join(STATE_DIR, "peers.json"), JSON.stringify({ httpPeers: [
      { name: "pt-alpha", fp: fpA, inTokenId: "tok_pt_a", addedAt: "2026-09-01T00:00:00Z" },
      { name: "pt-bravo", baseUrl: "https://bravo.example", inTokenId: "tok_pt_b", addedAt: "2026-09-01T00:00:00Z" },
      { name: "pt-old", baseUrl: "https://old.example", inTokenId: "tok_pt_old", addedAt: "2026-09-01T00:00:00Z" },
    ] }));
  });
  afterAll(() => {
    for (const f of ["principals.json", "peers.json", "peer-keys.json"]) rmSync(join(STATE_DIR, f), { force: true });
  });

  const PATH = "/api/v1/agents";
  function apiReq(token: string, opts: { key?: typeof keyA; now?: number; body?: string; method?: string; source?: "lan" | "relay" } = {}) {
    const method = opts.method ?? "GET";
    const sig = opts.key ? signedHeaders(method, PATH, opts.body ?? "", opts.key, opts.now ?? Date.now()) : {};
    const r = new Request(`http://ingress.local${PATH}`, { method, headers: { authorization: `Bearer ${token}`, ...sig }, ...(opts.body ? { body: opts.body } : {}) });
    setRequestContext(r, { source: opts.source ?? "lan", clientIp: null, https: false });
    return r;
  }
  const status = async (r: Request) => {
    const p = await authenticateApi(r, new URL(r.url), { rateLimit: false });
    return p instanceof Response ? p.status : 200;
  };

  test("路径模式（source=relay）下 peer token 一律 403，即使签名正确；owner token 不受影响", async () => {
    expect(await status(apiReq(TOK.a, { key: keyA, source: "relay" }))).toBe(403);
    expect(await status(apiReq(TOK.owner, { source: "relay" }))).toBe(200);
  });
  test("记了 fp 的 peer：对的钥匙放行；不签 / 别人的钥匙 / 过期 / 正文被改都 401", async () => {
    expect(await status(apiReq(TOK.a, { key: keyA }))).toBe(200);
    expect(await status(apiReq(TOK.a))).toBe(401);
    expect(await status(apiReq(TOK.a, { key: keyX }))).toBe(401);
    expect(await status(apiReq(TOK.a, { key: keyA, now: Date.now() - 600_000 }))).toBe(401);
    const tampered = apiReq(TOK.a, { key: keyA, method: "POST", body: '{"x":1}' });
    const forged = new Request(tampered.url, { method: "POST", headers: tampered.headers, body: '{"x":2}' });
    setRequestContext(forged, { source: "lan", clientIp: null, https: false });
    expect(await status(forged)).toBe(401);
  });
  test("只钉住过的 peer（http 直连、记录里没 fp）：第一次签名钉住，之后换钥匙或不签都 401", async () => {
    expect(await status(apiReq(TOK.b, { key: keyB }))).toBe(200);
    expect(await status(apiReq(TOK.b, { key: keyB }))).toBe(200);
    expect(await status(apiReq(TOK.b, { key: keyX }))).toBe(401);
    expect(await status(apiReq(TOK.b))).toBe(401);
  });
  test("没有任何期望指纹的老 peer：截止日前不签名也放行（告警），之后拒", async () => {
    expect(await status(apiReq(TOK.old))).toBe(beforeDeadline ? 200 : 401);
  });
  test("防重放：同一个签名的 POST 300 秒内再来一次 → 401；GET 不去重", async () => {
    const t = Date.now(); // 早于进程启动的签名本来就会被当重放（ReplayCache），这里要的是窗口内的重复
    const body = '{"text":"replay-direct"}';
    expect(await status(apiReq(TOK.a, { key: keyA, method: "POST", body, now: t }))).toBe(200);
    expect(await status(apiReq(TOK.a, { key: keyA, method: "POST", body, now: t }))).toBe(401);
    expect(await status(apiReq(TOK.a, { key: keyA, method: "POST", body: '{"text":"other"}', now: t }))).toBe(200);
    expect(await status(apiReq(TOK.a, { key: keyA, now: t }))).toBe(200);
    expect(await status(apiReq(TOK.a, { key: keyA, now: t }))).toBe(200);
  });
  test("防重放：经中继转进来的请求只算一次；截获后在中继上重放、或改走直连重放都被拒", async () => {
    const statuses: number[] = [];
    const ingress = (async (url: string, init: RequestInit) => {
      const r = new Request(`http://ingress.local${new URL(url).pathname}`, init);
      setRequestContext(r, { source: "lan", clientIp: null, https: false });
      const p = await authenticateApi(r, new URL(r.url), { rateLimit: false });
      statuses.push(p instanceof Response ? p.status : 200);
      return p instanceof Response ? p : new Response("{}");
    }) as unknown as typeof fetch;
    const h = makeInboundHandler({
      webBase: "http://127.0.0.1:2", ingressBase: () => "http://127.0.0.1:1", fetchImpl: ingress,
      refusePeer: async (from, req) => relayPeerRefusal(from, req, await loadRelayPeerView()),
    });
    const body = '{"text":"replay-relay"}';
    const headers = { authorization: `Bearer ${TOK.a}`, ...signedHeaders("POST", PATH, body, keyA) };
    const frame = () => ({ method: "POST", path: PATH, headers, body: new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(new TextEncoder().encode(body)); c.close(); } }) });
    const ctx = { from: fpA, signal: new AbortController().signal };
    expect((await h(frame(), ctx)).status).toBe(200);
    expect(statuses).toEqual([200]);
    await expect(h(frame(), ctx)).rejects.toMatchObject({ code: "replay" });
    const direct = new Request(`http://ingress.local${PATH}`, { method: "POST", headers, body });
    setRequestContext(direct, { source: "lan", clientIp: null, https: false });
    expect(await status(direct)).toBe(401);
  });
  test("路径模式里兑换邀请直接 403，不进 API", async () => {
    let called = false;
    const res = await dispatchMachineRequest(
      { method: "POST", path: "/api/v1/peers/redeem", headers: { [RELAY_MODE_HEADER]: "api" }, body: new ReadableStream({ start: (c) => c.close() }) },
      { from: "relay", signal: new AbortController().signal },
      async () => ((called = true), new Response("ok")),
    );
    expect(res.status).toBe(403);
    expect(called).toBe(false);
  });
  test("中继 peer 帧：发件人签名有效但 token 不是他的 / 他不是联系人 → sender_forbidden；本人照常到入口", async () => {
    const hits: string[] = [];
    const fetchImpl = (async (url: string) => (hits.push(url), new Response("{}"))) as unknown as typeof fetch;
    const h = makeInboundHandler({
      webBase: "http://127.0.0.1:2", ingressBase: () => "http://127.0.0.1:1", fetchImpl,
      refusePeer: async (from, req) => relayPeerRefusal(from, req, await loadRelayPeerView()),
    });
    const frame = (key: typeof keyA, token: string) => ({
      method: "GET", path: PATH, headers: { authorization: `Bearer ${token}`, ...signedHeaders("GET", PATH, "", key) }, body: new ReadableStream({ start: (c) => c.close() }),
    });
    const ctx = (from: string) => ({ from, signal: new AbortController().signal });
    await expect(h(frame(keyX, TOK.a), ctx(fpX))).rejects.toMatchObject({ code: "sender_forbidden" });
    await expect(h(frame(keyB, TOK.b), ctx(fpB))).rejects.toMatchObject({ code: "sender_forbidden" }); // 只钉住过的 http peer 不是中继联系人
    expect(hits).toEqual([]);
    const ok = await h(frame(keyA, TOK.a), ctx(fpA));
    expect(ok.status).toBe(200);
    expect(await collectBody(ok.body, 100)).toBeInstanceOf(Uint8Array);
    expect(hits).toEqual([`http://127.0.0.1:1${PATH}`]);
  });
});
