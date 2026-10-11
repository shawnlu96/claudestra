/**
 * peer 加密的两处加固（规格 peer-PEERE2E1，验收线编号写在各用例名里）：
 *   整理（lib/peer-tidy.ts）不把 required peer 降级成明文——合并后的记录带着 e2e，加密配置对不上的组不动；
 *   E2E 入口（lib/peer-e2e-serve.ts）不整读流式响应、内层请求跟着外层取消、非流式响应有上限。
 * 全部内存数据、现生成的合成密钥；不读 peers / 密钥文件，不联网。
 */
import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { utf8 } from "../src/lib/e2e/encoding.ts";
import { generateEcdh } from "../src/lib/e2e/primitives.ts";
import { signE2eKey } from "../src/lib/e2e-machine-key.ts";
import { keyFingerprint, signedHeaders } from "../src/lib/instance-key.ts";
import { PeerE2eClient } from "../src/lib/peer-e2e-client.ts";
import { e2ePeerOf, peerE2eRefusal, type LocalE2e } from "../src/lib/peer-e2e-local.ts";
import { createE2eOutbound } from "../src/lib/peer-e2e-outbound.ts";
import { serveE2e, type ServeDeps } from "../src/lib/peer-e2e-serve.ts";
import { SessionTable } from "../src/lib/peer-e2e-sessions.ts";
import { E2E_RESPONSE_MAX, e2eError, encodeResponseHead } from "../src/lib/peer-e2e-wire.ts";
import { activePeerTokens, applyPeerTidy, planPeerTidy } from "../src/lib/peer-tidy.ts";
import type { HttpPeer } from "../src/lib/peers.ts";
import type { Principal } from "../src/lib/principals.ts";

async function machine(v = 1): Promise<LocalE2e> {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const key = { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
  const pair = await generateEcdh();
  return { key, fp: keyFingerprint(key.publicKey), machine: { pair, ts: 1790000000 }, signed: signE2eKey(key, pair.pub, v, 1790000000) };
}

const BASE = "http://10.0.0.2:3847";
const OUT = "o".repeat(64);
const byFp = (p: HttpPeer) => p.fp ?? null;
const e2eOf = (x: LocalE2e) => ({ idk: x.key.publicKey, ek: x.signed });
const tok = (id: string, peer: string): Principal => ({
  id: `token:${id}`, role: "external", name: `peer-${peer}`, agents: ["a"], secret: "s", peer, createdAt: "2026-10-01T00:00:00.000Z",
});
/** P：他先连过我（只有入站）；P-2：我加入他的邀请撞名（只有出站）。同指纹同公钥，e2e 各自给 */
const pair = (them: LocalE2e, e2e: { p?: HttpPeer["e2e"]; p2?: HttpPeer["e2e"] }): HttpPeer[] => [
  { name: "P", addedAt: "2026-10-01T00:00:00.000Z", inTokenId: "tok_in", fp: them.fp, publicKey: them.key.publicKey, ...(e2e.p ? { e2e: e2e.p } : {}) },
  { name: "P-2", addedAt: "2026-10-02T00:00:00.000Z", baseUrl: BASE, outToken: OUT, fp: them.fp, publicKey: them.key.publicKey, ...(e2e.p2 ? { e2e: e2e.p2 } : {}) },
];

function tidy(peers: HttpPeer[]) {
  const principals = [tok("tok_in", "P")];
  const plan = planPeerTidy(peers, activePeerTokens(principals), byFp);
  return { plan, principals, ...applyPeerTidy(peers, principals, plan) };
}

/** 出站走哪条路：记下外层实际发出的地址；null = 交回调用方按明文发 */
async function outboundPaths(me: LocalE2e, peers: HttpPeer[]): Promise<string[] | null> {
  const sent: string[] = [];
  const out = createE2eOutbound({ local: async () => me, peers: async () => peers, pin: async () => {} });
  const res = await out
    .fetch(`${BASE}/api/v1/agents`, { headers: { authorization: `Bearer ${OUT}` } }, async (url) => {
      sent.push(new URL(url).pathname);
      return e2eError(503, "e2e_unavailable"); // 握手到此为止：只看它有没有走 E2E
    })
    .catch(() => "threw" as const);
  return res === null ? null : sent;
}

describe("整理不降级加密", () => {
  test("[验收线 1] P（无 e2e）+ P-2（有 e2e、有效出站）：合并后带 e2e，明文入站仍拒，出站仍走 E2E", async () => {
    const me = await machine(), them = await machine();
    const peers = pair(them, { p2: e2eOf(them) });
    const r = tidy(peers);
    expect(r.plan.map((g) => [g.finalName, g.skip])).toEqual([["P", undefined]]);
    expect(r.httpPeers).toEqual([
      { name: "P", addedAt: "2026-10-01T00:00:00.000Z", inTokenId: "tok_in", baseUrl: BASE, outToken: OUT, fp: them.fp, publicKey: them.key.publicKey, e2e: e2eOf(them) },
    ]);
    expect(peerE2eRefusal("P", undefined, r.httpPeers)).toBe("e2e_required");
    expect(e2ePeerOf(r.httpPeers[0])).toMatchObject({ name: "P", fp: them.fp });
    expect(await outboundPaths(me, r.httpPeers)).toEqual(["/api/v1/e2e/hello"]);
    expect(JSON.stringify(r.plan)).not.toContain(OUT);
  });

  test("[验收线 1] 两条 e2e 相同、以及只有入站的组：照常合并，e2e 留着", async () => {
    const them = await machine();
    const same = tidy(pair(them, { p: e2eOf(them), p2: e2eOf(them) }));
    expect(same.httpPeers).toHaveLength(1);
    expect(same.httpPeers[0].e2e).toEqual(e2eOf(them));
    // 没有出站可作底：P 有 token，P-2 两个方向都没有（死记录），e2e 相同
    const inbound: HttpPeer[] = [
      { name: "P", addedAt: "2026-10-01T00:00:00.000Z", inTokenId: "tok_in", fp: them.fp, e2e: e2eOf(them) },
      { name: "P-2", addedAt: "2026-10-02T00:00:00.000Z", fp: them.fp, e2e: e2eOf(them) },
    ];
    const r = tidy(inbound);
    expect(r.httpPeers).toEqual([{ name: "P", addedAt: "2026-10-01T00:00:00.000Z", inTokenId: "tok_in", fp: them.fp, e2e: e2eOf(them) }]);
    expect(peerE2eRefusal("P", undefined, r.httpPeers)).toBe("e2e_required");
  });

  test("[验收线 1] 以出站记录为底：白名单外的字段不丢；底里的旧入站 token 不带过来", async () => {
    const them = await machine();
    const peers = pair(them, { p2: e2eOf(them) });
    Object.assign(peers[1], { inTokenId: "tok_stale", futureField: { keep: true } });
    const r = tidy(peers);
    expect(r.httpPeers[0]).toMatchObject({ name: "P", inTokenId: "tok_in", futureField: { keep: true } });
    // 组里没有有效入站 token：合并后的记录不带 inTokenId
    const none = applyPeerTidy(peers, [], planPeerTidy(peers, [], byFp));
    expect(none.httpPeers).toHaveLength(1);
    expect("inTokenId" in none.httpPeers[0]).toBe(false);
    expect(none.httpPeers[0].e2e).toEqual(e2eOf(them));
  });

  test("[验收线 2] e2e 不一致（两条不同 / 保留的出站记录不带而另一条带）：整组 skip，apply 后两条原样", async () => {
    const them = await machine(), rotated = { ...them, signed: signE2eKey(them.key, them.machine.pair.pub, 2, 1790000001) };
    const cases = [pair(them, { p: e2eOf(them), p2: e2eOf(rotated) }), pair(them, { p: e2eOf(them) })];
    for (const peers of cases) {
      const before = structuredClone(peers);
      const r = tidy(peers);
      expect(r.plan).toHaveLength(1);
      expect(r.plan[0].skip).toContain("加密配置不一致");
      expect(r.plan[0].desc).toBe(r.plan[0].skip!);
      expect(r.httpPeers).toEqual(before);
      expect(r.revoked).toEqual([]);
      expect(r.principals).toEqual([tok("tok_in", "P")]);
    }
  });

  test("[验收线 2] 一组 skip 不影响别的组", async () => {
    const them = await machine();
    const peers: HttpPeer[] = [
      ...pair(them, { p: e2eOf(them) }),
      { name: "Q", addedAt: "2026-10-01T00:00:00.000Z" },
      { name: "Q-2", addedAt: "2026-10-02T00:00:00.000Z", baseUrl: "http://10.0.0.3:3847", outToken: OUT },
    ];
    const r = tidy(peers);
    expect(r.plan.map((g) => [g.finalName, !!g.skip])).toEqual([["P", true], ["Q", false]]);
    expect(r.httpPeers.map((p) => p.name)).toEqual(["P", "P-2", "Q"]);
  });
});

/** A 经 E2E 调 B；内层路由由用例给。post 造的外层 Request 带用例控制的 signal */
async function world(dispatch: (inner: Request) => Promise<Response> | Response) {
  const a = await machine(), b = await machine();
  const outer = new AbortController();
  const outerStatus: number[] = [];
  const deps: ServeDeps = {
    myFp: b.fp,
    machine: async () => b.machine,
    mySignedKey: async () => b.signed,
    sessions: new SessionTable(),
    peerByFp: (fp) => (fp === a.fp ? { name: "a", fp: a.fp, idk: a.key.publicKey, ek: a.signed } : null),
    pinNewer: async () => {},
    outerSigned: () => true,
    dispatch: async (inner) => dispatch(inner),
  };
  const client = new PeerE2eClient({
    myFp: a.fp,
    peer: () => ({ name: "b", fp: b.fp, idk: b.key.publicKey, ek: b.signed }),
    machine: async () => a.machine,
    mySignedKey: async () => a.signed,
    pinNewer: async () => {},
    post: async (path, body, contentType) => {
      const req = new Request(`http://b.local${path}`, {
        method: "POST", body, signal: outer.signal, headers: { "content-type": contentType, ...signedHeaders("POST", path, body, a.key) },
      });
      const res = (await serveE2e(req, path, deps, { sender: a.fp })) ?? new Response("not found", { status: 404 });
      outerStatus.push(res.status);
      return res;
    },
  });
  const get = (path: string) => client.fetch("GET", path, { authorization: "Bearer t" }, undefined);
  return { get, outer, outerStatus };
}

const settled = <T>(p: Promise<T>, ms = 2000): Promise<T | "pending"> =>
  Promise.race([p.catch((e) => e as T), new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);

/** 不会自己结束的响应体：start 时登记一个订阅，cancel 时收掉 */
function endless(subs: Set<string>, first?: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      subs.add("sub");
      if (first) c.enqueue(first);
    },
    cancel() {
      subs.delete("sub");
    },
  });
}

describe("E2E 入口：流式、取消、上限", () => {
  test("[验收线 3] 内层是 SSE：外层马上收到加密的 501 e2e_stream_unsupported，响应体已取消，订阅不残留", async () => {
    const subs = new Set<string>();
    const w = await world(() => new Response(endless(subs, utf8(": hi\n\n")), { headers: { "content-type": "text/event-stream; charset=utf-8" } }));
    const res = await settled(w.get("/api/v1/events"));
    if (!(res instanceof Response)) throw new Error(`外层没等到回包: ${String(res)}`);
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ ok: false, code: "e2e_stream_unsupported" });
    expect(w.outerStatus).toEqual([200, 200]); // hello + 一条加密响应：错误写在密文里
    expect(subs.size).toBe(0);
  });

  test("[验收线 4] 外层 abort：内层 signal 跟着 aborted，挂着的响应体被取消，入口不再等", async () => {
    const subs = new Set<string>();
    let inner: Request | undefined;
    const w = await world((req) => {
      inner = req;
      queueMicrotask(() => setTimeout(() => w.outer.abort(), 20));
      return new Response(endless(subs), { headers: { "content-type": "application/json" } });
    });
    const res = await settled(w.get("/api/v1/agents"));
    expect(res).not.toBe("pending");
    expect(inner!.signal.aborted).toBe(true);
    expect(subs.size).toBe(0);
  });

  test("[验收线 4] 外层在内层路由还没回时就断了：路由回来的响应体直接取消", async () => {
    const subs = new Set<string>();
    let innerAborted = false;
    const w = await world(async (req) => {
      w.outer.abort();
      innerAborted = req.signal.aborted;
      return new Response(endless(subs, utf8("{}")), { headers: { "content-type": "application/json" } });
    });
    expect(await settled(w.get("/api/v1/agents"))).not.toBe("pending");
    expect(innerAborted).toBe(true);
    expect(subs.size).toBe(0);
  });

  /** 分块给 total 字节；记下给出去多少、有没有被取消 */
  function chunked(total: number, chunk = 1024 * 1024) {
    const state = { sent: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        const n = Math.min(chunk, total - state.sent);
        if (n <= 0) return c.close();
        state.sent += n;
        c.enqueue(new Uint8Array(n).fill(0x61));
      },
      cancel() {
        state.cancelled = true;
      },
    }, { highWaterMark: 0 });
    return { state, res: new Response(body, { headers: { "content-type": "application/json" } }) };
  }

  /** 发起方的读上限把响应头那一条也算在内：正文最多这么大 */
  const BODY_MAX = E2E_RESPONSE_MAX - utf8(encodeResponseHead(200, new Headers({ "content-type": "application/json" }))).length;

  test("[验收线 5] 非流式响应超过上限：取消响应体，回明文 502 e2e_record（发起方按「响应不能用」报，不重发）", async () => {
    for (const size of [BODY_MAX + 1, E2E_RESPONSE_MAX * 4]) {
      const big = chunked(size);
      const w = await world(() => big.res);
      const err = await settled(w.get("/api/v1/agents"), 10_000);
      expect(err).toMatchObject({ code: "e2e_record", sent: true });
      expect(w.outerStatus.at(-1)).toBe(502); // 是收方拒的，不是发起方收下 8 MiB 之后自己数出来的
      expect(big.state.cancelled).toBe(true);
      expect(big.state.sent).toBeLessThanOrEqual(E2E_RESPONSE_MAX + 2 * 1024 * 1024); // 过线就停，不把剩下的读完
    }
  });

  test("[验收线 5] 上限以内（含正好等于上限）照常往返", async () => {
    for (const size of [0, 3 * 1024 * 1024 + 7, BODY_MAX]) {
      const ok = chunked(size);
      const w = await world(() => ok.res);
      const res = await w.get("/api/v1/agents");
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(size);
      expect(ok.state.cancelled).toBe(false);
    }
    const w = await world(() => Response.json({ ok: true, n: 1 }, { status: 201 }));
    const res = await w.get("/api/v1/agents");
    expect([res.status, await res.json()]).toEqual([201, { ok: true, n: 1 }]);
  });
});
