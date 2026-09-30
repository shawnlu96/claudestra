/**
 * Peer 面板「测试」（peer-http-test）对 E2E peer 也要带内层实例签名（i28-R8）：对方解开会话后照常验签，没签的一律 401 unsigned。
 * 自环：本机（测试进程的 STATE_DIR）同时是发方和收方，收方用真件——peer 入口 → E2E 路由 → authenticateApi 验签 / peerGate。
 * 反例：同一条请求内层不签，收方照旧 401 unsigned（没为测试放宽验签），提示也不再叫人删 peer 重新邀请。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { authenticateApi } from "../src/bridge/api-auth.ts";
import { createE2eRoute } from "../src/bridge/peer-e2e-route.ts";
import { ingressRequest } from "../src/bridge/peer-ingress.ts";
import { signedHeaders } from "../src/lib/instance-key.ts";
import { STATE_DIR } from "../src/lib/paths.ts";
import { peerAuthHint } from "../src/lib/peer-auth-hints.ts";
import { defaultOutboundDeps, createE2eOutbound } from "../src/lib/peer-e2e-outbound.ts";
import { localE2e, pinPeerE2eKey, readHttpPeers, type LocalE2e } from "../src/lib/peer-e2e-local.ts";
import { writePeers, type HttpPeer } from "../src/lib/peers.ts";
import { cmdPeerHttpTest, issuePeerToken } from "../src/manager/peers.ts";

const STATE_FILES = ["registry.json", "peers.json", "principals.json", "peer-keys.json"];
const saved = new Map<string, string | null>();
let me: LocalE2e;
let ingress: Server<undefined>;
let e2eBase = "", secret = "";

const route = createE2eRoute({ local: () => localE2e(), peers: readHttpPeers, pin: pinPeerE2eKey });
async function api(req: Request, url: URL): Promise<Response> {
  const e2e = await route.route(req, url, (inner) => api(inner, new URL(inner.url)));
  if (e2e) return e2e;
  const auth = await authenticateApi(req, url, { rateLimit: false });
  if (auth instanceof Response) return auth;
  return Response.json({ ok: true, agents: [{ name: "x", status: "idle" }] });
}

async function runTest(name: string): Promise<any> {
  const out: string[] = [];
  const orig = console.log;
  console.log = (s: unknown) => void out.push(String(s));
  try {
    await cmdPeerHttpTest(name);
  } finally {
    console.log = orig;
  }
  return JSON.parse(out.at(-1) ?? "null");
}

beforeAll(async () => {
  for (const f of STATE_FILES) saved.set(f, existsSync(join(STATE_DIR, f)) ? readFileSync(join(STATE_DIR, f), "utf8") : null);
  writeFileSync(join(STATE_DIR, "registry.json"), JSON.stringify({ agents: { "agent-x": { name: "agent-x", external: true } } }));
  for (const f of ["peers.json", "principals.json", "peer-keys.json"]) rmSync(join(STATE_DIR, f), { force: true });
  me = (await localE2e())!;
  ingress = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => ingressRequest(req, api) });
  e2eBase = `http://127.0.0.1:${ingress.port}`;
  const e2e = await issuePeerToken("self", ["x"]);
  const legacy = await issuePeerToken("legacy", ["x"]);
  const oneWay = await issuePeerToken("oneway", ["x"]);
  secret = e2e.secret;
  const now = new Date().toISOString();
  const key = { fp: me.fp, publicKey: me.key.publicKey };
  const peers: HttpPeer[] = [
    { name: "self", baseUrl: e2eBase, outToken: e2e.secret, inTokenId: e2e.tokenId, ...key, e2e: { idk: me.key.publicKey, ek: me.signed }, addedAt: now },
    // 老式明文 peer：换个主机写法，别和上面那条按地址撞到一起
    { name: "legacy", baseUrl: `http://localhost:${ingress.port}`, outToken: legacy.secret, inTokenId: legacy.tokenId, ...key, addedAt: now },
    { name: "oneway", inTokenId: oneWay.tokenId, ...key, e2e: { idk: me.key.publicKey, ek: me.signed }, addedAt: now },
  ];
  await writePeers({ httpPeers: peers });
});

afterAll(() => {
  ingress?.stop(true);
  for (const [f, v] of saved) v === null ? rmSync(join(STATE_DIR, f), { force: true }) : writeFileSync(join(STATE_DIR, f), v);
});

describe("peer-http-test", () => {
  test("E2E peer：内层带实例签名，对方验签通过，返回可访问的 agent", async () => {
    const o = await runTest("self");
    expect(o).toMatchObject({ ok: true, reachable: true, remoteAgents: [{ name: "x", status: "idle" }] });
  });

  test("反例：同一条请求内层不签 → 对方照旧 401 unsigned（验签没放宽），提示说升级、不叫人删 peer", async () => {
    const out = createE2eOutbound(defaultOutboundDeps());
    const raw = (url: string, init: { method: "POST"; headers: Record<string, string>; body: Uint8Array }) => {
      const u = new URL(url);
      return fetch(url, { ...init, headers: { ...init.headers, ...signedHeaders("POST", u.pathname + u.search, init.body) } });
    };
    const res = (await out.fetch(`${e2eBase}/api/v1/agents`, { headers: { Authorization: `Bearer ${secret}` } }, raw))!;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string; reason?: string; error?: string };
    expect(body).toMatchObject({ code: "peer_signature", reason: "unsigned" });
    for (const text of [body.error ?? "", peerAuthHint(body)]) {
      expect(text).toContain("claudestra update");
      expect(text).not.toContain("重新给你发一张邀请");
    }
  });

  test("老式明文 peer：行为不变（外层签名即请求签名），照常 200", async () => {
    const o = await runTest("legacy");
    expect(o).toMatchObject({ ok: true, reachable: true });
  });

  test("只单向加入过的记录（有 e2e、没地址）：不发请求，提示请对方发邀请给我加入，不叫人删 peer", async () => {
    const o = await runTest("oneway");
    expect(o.ok).toBe(false);
    expect(o.error).toContain("请对方生成一张邀请给你加入");
    expect(o.error).toContain("不用删掉 peer");
  });
});
