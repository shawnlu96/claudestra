/**
 * E2E 帧在两道「不带凭据只放兑换」的闸上开的口子（docs/relay/e2e-design.md §5.1）。E2E 帧外层不带 token，token 只在密文里，
 * 所以 peer 入口（bridge/peer-ingress.ts）与中继入站（lib/peer-trust.ts relayPeerRefusal）给它们开了口子。这里逐条验证开口子的前提：
 *   1. 只认两种帧，逐字匹配：方法、尾斜杠、大小写、编码、查询串一律不放宽，其余照旧 403 / sender_forbidden；
 *   2. 外层身份不变弱：中继的照旧核联系人与记下的钥匙；直连的先验外层签名，签名方必须是钉了身份钥匙的 E2E 联系人；
 *   3. 先验签再 ECDH：签名不对时 deriveBits 一次都不调，失败进 peerGate 的失败桶；hello 按发件人限速。
 * 第 4 条（解密后内层照旧过 peerGate，token 主人 = 会话发起方）在 tests/peer-e2e-relay.test.ts。
 * 只由 tests/peer-e2e-gates.test.ts 在私有 HOME/状态/运行/临时目录的子进程里加载：crypto.subtle 上的 spy、api-auth 的失败桶、身份缓存与 BoringSSL 错误队列都是进程全局的。
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2eRoute } from "../src/bridge/peer-e2e-route.ts";
import { ingressRequest } from "../src/bridge/peer-ingress.ts";
import { handlePeerRedeem } from "../src/bridge/peer-redeem.ts";
import { requestContextOf, setRequestContext, type RequestSource } from "../src/bridge/request-context.ts";
import { toB64url, utf8 } from "../src/lib/e2e/encoding.ts";
import { generateEcdh } from "../src/lib/e2e/primitives.ts";
import { SIG_HEADERS, signedHeaders } from "../src/lib/instance-key.ts";
import { RUNTIME_DIR, STATE_DIR } from "../src/lib/paths.ts";
import { e2ePeerOf, localE2e, peerE2eRefusal, peerForUrl, type LocalE2e } from "../src/lib/peer-e2e-local.ts";
import { sealRedeemRequest } from "../src/lib/peer-e2e-redeem.ts";
import { encodeHello, isE2eFrame } from "../src/lib/peer-e2e-wire.ts";
import { relayPeerRefusal, type RelayPeerView } from "../src/lib/peer-trust.ts";
import type { HttpPeer } from "../src/lib/peers.ts";

const role = process.env.CLAUDESTRA_E2E_GATES_ROLE;
if (role !== "suite") throw new Error("peer e2e gates fixture requires its isolated runner");
const subtleDeriveBits = crypto.subtle.deriveBits;

const SID = toB64url(new Uint8Array(16).fill(7));
const HELLO = "/api/v1/e2e/hello";
const RECORD = `/api/v1/e2e/${SID}/1`;
const EXACT: [string, string][] = [["POST", HELLO], ["POST", RECORD], ["POST", `/api/v1/e2e/${SID}/72057594037927935`]];
/** 差一点的写法：每一条都必须照旧被闸拦下 */
const NEAR_MISS: [string, string][] = [
  ["GET", HELLO], ["PUT", HELLO], ["post", HELLO], ["GET", RECORD],
  ["POST", `${HELLO}/`], ["POST", "/api/v1/e2e/Hello"], ["POST", "/api/v1/E2E/hello"], ["POST", "/api/v1/e2e/%68ello"], ["POST", "/api/v1/e2e/hello%2F"],
  ["POST", `${HELLO}?x=1`], ["POST", `${HELLO}?`], ["POST", "/api/v1/e2e//hello"], ["POST", "/api/v1/e2e"], ["POST", "/api/v1/e2e/"],
  ["POST", `/api/v1/e2e/${SID}/0`], ["POST", `/api/v1/e2e/${SID}/01`], ["POST", `/api/v1/e2e/${SID}/1/`], ["POST", `/api/v1/e2e/${SID}/1?x`],
  ["POST", `/api/v1/e2e/${SID}/72057594037927936`], ["POST", `/api/v1/e2e/${SID.slice(1)}/1`], ["POST", `/api/v1/e2e/${SID}A/1`],
  ["POST", `/api/v1/e2e/${SID}=/1`], ["POST", `/api/v1/e2e/r/${SID}`], ["POST", `/api/v1/e2e/${SID}`], ["POST", `/api/v1/e2e/${SID}/%31`],
  ["POST", "/api/v1/agents"], ["POST", "/api/v1/agents/x/messages"], ["POST", "/api/v1/e2e/hello/../../agents"],
];

describe("1. 口子只认两种帧，逐字匹配", () => {
  test("isE2eFrame：精确写法认，差一点的一律不认", () => {
    for (const [m, p] of EXACT) expect([m, p, isE2eFrame(m, p)]).toEqual([m, p, true]);
    for (const [m, p] of NEAR_MISS) expect([m, p, isE2eFrame(m, p)]).toEqual([m, p, false]);
  });

  const FP = "16f9-b5d1-30fb-8923", KEY = "k".repeat(43);
  const view: RelayPeerView = { contacts: new Set([FP]), keyOf: (fp) => (fp === FP ? KEY : null), bearerOwner: () => null };
  const frame = (method: string, path: string, key = KEY) => ({ method, path, headers: { [SIG_HEADERS.key]: key } });

  test("中继入站：联系人不带 token 只放精确的 E2E 帧；联系人、记下的钥匙照样核", () => {
    for (const [m, p] of EXACT) expect(relayPeerRefusal(FP, frame(m, p), view)).toBeNull();
    for (const [m, p] of NEAR_MISS) expect([m, p, relayPeerRefusal(FP, frame(m, p), view)]).toEqual([m, p, "peer requests must carry the peer's token"]);
    expect(relayPeerRefusal("aaaa-bbbb-cccc-dddd", frame("POST", HELLO), view)).toBe("sender is not a contact of this instance");
    expect(relayPeerRefusal(FP, frame("POST", RECORD, "x".repeat(43)), view)).toBe("signing key is not the one recorded for this contact");
  });

  test("peer 入口（对外直连）：不带凭据只放精确的 E2E 帧（外加 T25 原有的兑换与邀请页），其余 403、API 不被调用", async () => {
    const seen: string[] = [];
    const api = async (req: Request, url: URL) => (seen.push(`${requestContextOf(req).source} ${req.method} ${url.pathname}`), new Response("{}"));
    const at = (m: string, p: string) => ingressRequest(new Request(`http://127.0.0.1:1${p}`, { method: m, ...(m === "GET" ? {} : { body: "x" }) }), api, "203.0.113.9");
    for (const [m, p] of EXACT) expect((await at(m, p)).status).toBe(200);
    expect(seen).toEqual(EXACT.map(([m, p]) => `peer-ingress ${m} ${p}`));
    seen.length = 0;
    // new Request 会把 method 规范成大写、把 /../ 折掉：那几条在 HTTP 层就不是原样到达，跳过（中继入站看原串，上一条已覆盖）
    for (const [m, p] of NEAR_MISS.filter(([m, p]) => m === m.toUpperCase() && !p.includes(".."))) expect([m, p, (await at(m, p)).status]).toEqual([m, p, 403]);
    expect(seen).toEqual([]);
  });
});

// ── 2、3：直连来的外层身份，与验签在 ECDH 之前 ──
let a: LocalE2e, b: LocalE2e, carl: LocalE2e, stranger: LocalE2e;
const dirs: string[] = [];
const record = (name: string, x: LocalE2e, e2e: boolean): HttpPeer => ({
  name, baseUrl: `http://${name}.test`, addedAt: "2026-09-01T00:00:00Z", fp: x.fp, publicKey: x.key.publicKey, ...(e2e ? { e2e: { idk: x.key.publicKey, ek: x.signed } } : {}),
} as HttpPeer);

beforeAll(async () => {
  const mk = async () => {
    const d = mkdtempSync(join(tmpdir(), "peer-e2e-gates-"));
    dirs.push(d);
    return (await localE2e(d))!;
  };
  [a, b, carl, stranger] = [await mk(), await mk(), await mk(), await mk()];
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  // 父入口凭这一行核：身份在本进程私有目录生成且已清理、deriveBits 已复原
  const receipt = { state: STATE_DIR, runtime: RUNTIME_DIR, tmp: tmpdir(), fps: [a, b, carl, stranger].map((x) => x?.fp), dirs, cleaned: dirs.every((d) => !existsSync(d)),
    restored: crypto.subtle.deriveBits === subtleDeriveBits };
  process.stdout.write("E2E_GATES_RESULT " + JSON.stringify(receipt) + "\n");
});

let spy: ReturnType<typeof spyOn> | null = null;
/** ECDH 与 HKDF 都走 subtle.deriveBits（lib/e2e/primitives.ts）：计它的调用次数 */
function countDerive(): () => number {
  spy = spyOn(crypto.subtle, "deriveBits");
  return () => spy!.mock.calls.length;
}
afterEach(() => {
  spy?.mockRestore();
  spy = null;
});

const newRoute = () => createE2eRoute({ local: async () => b, peers: async () => [record("alice", a, true), record("carl", carl, false)], pin: async () => {} });
async function helloBody(from: LocalE2e): Promise<Uint8Array> {
  return utf8(encodeHello({ from: from.fp, to: b.fp, ce: (await generateEcdh()).pub, key: from.signed }));
}
function post(path: string, body: Uint8Array, headers: Record<string, string>, source: RequestSource = "peer-ingress", ip = "203.0.113.9"): Request {
  const req = new Request(`http://b.test${path}`, { method: "POST", headers, body });
  setRequestContext(req, { source, clientIp: ip, https: false });
  return req;
}
const hit = async (route: ReturnType<typeof newRoute>, req: Request) => {
  const res = (await route.route(req, new URL(req.url), async () => new Response("inner")))!;
  return [res.status, ((await res.json().catch(() => ({}))) as { code?: string }).code];
};

describe("2、3. 直连的外层身份：先验签、签名方是钉了钥匙的 E2E 联系人，之后才有 ECDH", () => {
  test("没签名、陌生钥匙冒名、普通联系人（没钉 E2E 钥）、签名对不上正文、记录帧乱签：都 401 e2e_signature，deriveBits 0 次", async () => {
    const route = newRoute();
    const body = await helloBody(a), other = await helloBody(a);
    const derived = countDerive();
    for (const source of ["peer-ingress", "lan", "loopback"] as RequestSource[]) expect(await hit(route, post(HELLO, body, {}, source))).toEqual([401, "e2e_signature"]);
    expect(await hit(route, post(HELLO, body, signedHeaders("POST", HELLO, body, stranger.key)))).toEqual([401, "e2e_signature"]);
    expect(await hit(route, post(HELLO, body, signedHeaders("POST", HELLO, body, carl.key)))).toEqual([401, "e2e_signature"]);
    expect(await hit(route, post(HELLO, body, signedHeaders("POST", HELLO, other, a.key)))).toEqual([401, "e2e_signature"]);
    expect(await hit(route, post(RECORD, utf8("x"), signedHeaders("POST", RECORD, "y", a.key)))).toEqual([401, "e2e_signature"]);
    expect(await hit(route, post(RECORD, utf8("x"), signedHeaders("POST", RECORD, "x", stranger.key)))).toEqual([401, "e2e_signature"]);
    expect(derived()).toBe(0);
  });

  test("对照：钉了钥匙的 E2E 联系人签对了，hello 才走到 ECDH；记录帧签对了进到会话查找（会话不存在 401 e2e_session）", async () => {
    const route = newRoute();
    const body = await helloBody(a);
    const derived = countDerive();
    expect(await hit(route, post(HELLO, body, signedHeaders("POST", HELLO, body, a.key)))).toEqual([200, undefined]);
    expect(derived()).toBeGreaterThan(0);
    expect(await hit(route, post(RECORD, utf8("x"), signedHeaders("POST", RECORD, "x", a.key)))).toEqual([401, "e2e_session"]);
  });

  test("验签失败计入 peerGate 的失败桶：认不出的按来源地址记，超过每分钟 120 次回 429，别的来源不受影响", async () => {
    const route = newRoute();
    const body = await helloBody(a);
    const bad = () => post(HELLO, body, signedHeaders("POST", HELLO, body, stranger.key), "peer-ingress", "198.51.100.77");
    for (let i = 0; i < 120; i++) expect((await hit(route, bad()))[0]).toBe(401);
    expect(await hit(route, bad())).toEqual([429, "e2e_rate_limited"]);
    expect(await hit(route, post(HELLO, body, signedHeaders("POST", HELLO, body, stranger.key), "peer-ingress", "198.51.100.78"))).toEqual([401, "e2e_signature"]);
  });

  test("hello 按发件人限速：同一个联系人一分钟 20 次，第 21 次 429 且不做 ECDH", async () => {
    const route = newRoute();
    const bodies = await Promise.all(Array.from({ length: 21 }, () => helloBody(a)));
    for (const body of bodies.slice(0, 20)) expect((await hit(route, post(HELLO, body, signedHeaders("POST", HELLO, body, a.key))))[0]).toBe(200);
    const derived = countDerive();
    const last = bodies[20]!;
    expect(await hit(route, post(HELLO, last, signedHeaders("POST", HELLO, last, a.key)))).toEqual([429, "e2e_rate_limited"]);
    expect(derived()).toBe(0);
  });

  test("加密兑换：发件人认不出（没签名、签名对不上正文）就不解信封，deriveBits 0 次、manager 不被调用；签对了才解", async () => {
    const sealed = JSON.stringify((await sealRedeemRequest(b.machine.pair.pub, b.fp, { join: "j".repeat(48), name: "alice", idk: a.key.publicKey, key: a.signed })).body);
    const calls: string[][] = [];
    const deps = { runManager: async (...args: string[]) => (calls.push(args), { ok: false }), local: async () => b };
    const redeem = (headers: Record<string, string>) => {
      const req = new Request("http://b.test/api/v1/peers/redeem", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: sealed });
      setRequestContext(req, { source: "peer-ingress", clientIp: "203.0.113.10", https: false });
      return handlePeerRedeem(req, deps);
    };
    const derived = countDerive();
    expect((await redeem({})).status).toBe(403);
    expect((await redeem(signedHeaders("POST", "/api/v1/peers/redeem", "tampered", a.key))).status).toBe(403);
    expect(derived()).toBe(0);
    expect((await redeem(signedHeaders("POST", "/api/v1/peers/redeem", sealed, a.key))).status).toBe(400); // 解开了，口令不对（没有这张邀请）
    expect(derived()).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });
});

describe("4. 判定：哪些是 required peer、明文与会话各该不该拒（lib/peer-e2e-local.ts）", () => {
  test("peerE2eRefusal：required peer 的明文 → e2e_required；会话发起方与 token 主人不一致 → e2e_peer_mismatch", () => {
    const peers = [record("alice", a, true), record("carl", carl, false), { ...record("gone", stranger, true), disabled: true }];
    expect(peerE2eRefusal("alice", undefined, peers)).toBe("e2e_required");
    expect(peerE2eRefusal("carl", undefined, peers)).toBeNull();
    expect(peerE2eRefusal("alice", a.fp, peers)).toBeNull();
    expect(peerE2eRefusal("alice", carl.fp, peers)).toBe("e2e_peer_mismatch");
    expect(peerE2eRefusal("carl", a.fp, peers)).toBe("e2e_peer_mismatch"); // 会话里拿普通 peer 的 token 也不行
    expect(peerE2eRefusal("gone", stranger.fp, peers)).toBe("e2e_peer_mismatch"); // 禁用了的记录不认
    expect(peerE2eRefusal("nobody", a.fp, peers)).toBe("e2e_peer_mismatch");
  });

  test("e2ePeerOf / peerForUrl：只认没禁用、带 E2E 钥、记得住指纹的；地址按指纹或 baseUrl 前缀", () => {
    const alice = record("alice", a, true);
    expect(e2ePeerOf(alice)).toEqual({ name: "alice", fp: a.fp, idk: a.key.publicKey, ek: a.signed });
    expect(e2ePeerOf(record("carl", carl, false))).toBeNull();
    expect(e2ePeerOf({ ...alice, disabled: true })).toBeNull();
    const peers = [alice, { ...record("carl", carl, false), baseUrl: `relay://${carl.fp}` }];
    expect(peerForUrl("http://alice.test/api/v1/agents", peers)?.name).toBe("alice");
    expect(peerForUrl("http://alice.test.evil/api/v1/agents", peers)).toBeNull();
    expect(peerForUrl(`relay://${carl.fp.toUpperCase()}/api/v1/agents`, peers)?.name).toBe("carl");
    expect(peerForUrl("relay://0000-0000-0000-0000/api/v1/agents", peers)).toBeNull();
  });
});

// 父入口的误配探针：故意错的断言 / 中途退出的子进程必须让父入口红（tests/peer-e2e-gates.test.ts）
const sabotage = process.env.CLAUDESTRA_E2E_GATES_SABOTAGE;
if (sabotage === "assert") test("误配探针：故意错的断言", () => expect(isE2eFrame("GET", HELLO)).toBe(true));
if (sabotage === "exit") test("误配探针：子进程中途退出", () => process.exit(3));
