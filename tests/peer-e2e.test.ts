/**
 * peer 整体加密的进程内端到端（lib/peer-e2e-{client,serve,sessions,wire}.ts）：A 发起、B 响应，中间夹一个「中继」，
 * 它能录下、重放、并发重复投递、篡改、伪造错误、冒充 B 应答。按 docs/relay/e2e-design.md §4.1.4 与 §5.1 的降级 / 重放规则逐条钉住：
 * 任何一处都不回退明文，同一个内层请求最多被处理一次。
 */
import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { respond } from "../src/lib/e2e/handshake.ts";
import { generateEcdh } from "../src/lib/e2e/primitives.ts";
import { signE2eKey, type MachineE2eKey, type SignedE2eKey } from "../src/lib/e2e-machine-key.ts";
import { keyFingerprint, SIG_HEADERS, signedHeaders, verifySigned, type InstanceKey } from "../src/lib/instance-key.ts";
import { E2eError, E2eInnerError, E2eLocalError, E2eOuterError, PeerE2eClient } from "../src/lib/peer-e2e-client.ts";
import { peerCallFailureText } from "../src/lib/peer-auth-hints.ts";
import { serveE2e, type E2ePeer, type ServeDeps } from "../src/lib/peer-e2e-serve.ts";
import { SessionTable } from "../src/lib/peer-e2e-sessions.ts";
import { encodeHelloReply, PEER_E2E_LABEL } from "../src/lib/peer-e2e-wire.ts";
import { toB64url, utf8 } from "../src/lib/e2e/encoding.ts";
import { createE2eOutbound } from "../src/lib/peer-e2e-outbound.ts";

interface Machine {
  id: InstanceKey;
  fp: string;
  m: MachineE2eKey;
  blob: SignedE2eKey;
}

async function machine(v = 1): Promise<Machine> {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const id = { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
  const pair = await generateEcdh();
  return { id, fp: keyFingerprint(id.publicKey), m: { pair, ts: 1790000000 }, blob: signE2eKey(id, pair.pub, v, 1790000000) };
}

const asPeer = (x: Machine, name: string): E2ePeer => ({ name, fp: x.fp, idk: x.id.publicKey, ek: x.blob });

/**
 * B 的内层路由替身：记下处理过的请求；非 GET 按 T25 authApi 的样子查内层签名——签名时间早于本次启动 → before_start，
 * 见过 → replay（401 {code:"peer_signature", reason}）。restart() = 进程重启：去重表清空、启动时刻前移。
 */
function router() {
  const handled: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
  let seenSig = new Set<string>();
  let startedAt = 0;
  const reject = (reason: string) => Response.json({ ok: false, code: "peer_signature", reason }, { status: 401 });
  const dispatch = async (req: Request) => {
    const sig = req.headers.get(SIG_HEADERS.sig) ?? "";
    if (req.method !== "GET" && Number(req.headers.get(SIG_HEADERS.ts)) < startedAt) return reject("before_start");
    if (req.method !== "GET" && seenSig.has(sig)) return reject("replay");
    seenSig.add(sig);
    const body = req.method === "GET" ? "" : await req.text();
    handled.push({ method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body });
    return Response.json({ ok: true, echo: body, n: handled.length }, { status: req.method === "POST" ? 201 : 200 });
  };
  const restart = (clock: number) => {
    seenSig = new Set();
    startedAt = clock + 1;
  };
  return { handled, dispatch, restart };
}

type Relay = (req: Request, forward: (r: Request) => Promise<Response>) => Promise<Response>;

async function world(opts: { relay?: Relay; limits?: ConstructorParameters<typeof SessionTable>[0]; now?: () => number; bodyLimits?: { idleMs?: number; totalMs?: number } } = {}) {
  const a = await machine(), b = await machine();
  const r = router();
  let bKnowsA: E2ePeer | null = asPeer(a, "a");
  let aKnowsB = asPeer(b, "b");
  const seenOuter = new Set<string>();
  const pinnedByA: SignedE2eKey[] = [];
  const bDeps: ServeDeps = {
    myFp: b.fp,
    machine: async () => b.m,
    mySignedKey: async () => b.blob,
    sessions: new SessionTable(opts.limits, opts.now),
    peerByFp: (fp) => (bKnowsA && fp === bKnowsA.fp ? bKnowsA : null),
    pinNewer: async () => {},
    outerSigned: (req, body, idk) => {
      const h = (k: string) => req.headers.get(k) ?? "";
      if (h(SIG_HEADERS.key) !== idk || seenOuter.has(h(SIG_HEADERS.sig))) return false;
      seenOuter.add(h(SIG_HEADERS.sig));
      return verifySigned(idk, { method: req.method, path: new URL(req.url).pathname, ts: h(SIG_HEADERS.ts), sig: h(SIG_HEADERS.sig), body }) === "ok";
    },
    dispatch: (inner) => r.dispatch(inner),
  };
  const toB = async (req: Request) => (await serveE2e(req, new URL(req.url).pathname, bDeps, { sender: a.fp })) ?? new Response("not found", { status: 404 });
  const posted: string[] = [];
  const client = new PeerE2eClient({
    myFp: a.fp,
    peer: () => aKnowsB,
    machine: async () => a.m,
    mySignedKey: async () => a.blob,
    pinNewer: async (_p, k) => {
      pinnedByA.push(k);
    },
    post: async (path, body, contentType) => {
      posted.push(path);
      const req = new Request(`http://b.local${path}`, { method: "POST", body, headers: { "content-type": contentType, ...signedHeaders("POST", path, body, a.id) } });
      return opts.relay ? opts.relay(req, toB) : toB(req);
    },
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.bodyLimits ? { bodyLimits: opts.bodyLimits } : {}),
  });
  /** 模拟调用方：内层带 Bearer、一个每次唯一的内层签名和签名时刻（单调时钟） */
  let clock = 0;
  const call = (method: string, path: string, body?: string) =>
    client.fetch(method, path, {
      authorization: "Bearer tok", [SIG_HEADERS.sig]: randomUUID(), [SIG_HEADERS.ts]: String(++clock), host: "evil", "x-forwarded-for": "127.0.0.1",
    }, body === undefined ? undefined : utf8(body));
  /** B 进程重启：会话全丢，内层去重表清空，之前签的非 GET 都算「重启前」 */
  const restartB = () => {
    bDeps.sessions = new SessionTable(opts.limits, opts.now);
    r.restart(clock);
  };
  return {
    a, b, r, bDeps, client, call, posted, pinnedByA, restartB,
    setBKnowsA: (p: E2ePeer | null) => (bKnowsA = p),
    setAKnowsB: (p: E2ePeer) => (aKnowsB = p),
  };
}

const copy = async (req: Request) => new Request(req.url, { method: req.method, headers: req.headers, body: await req.clone().arrayBuffer() });

describe("peer E2E：正常往返", () => {
  test("POST / GET 都能往返；内层头走白名单，host、x-forwarded-for 这类到不了路由", async () => {
    const w = await world();
    const res = await w.call("POST", "/api/v1/agents/x/messages", "hi");
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, echo: "hi", n: 1 });
    expect((await w.call("GET", "/api/v1/agents")).status).toBe(200);
    expect(w.r.handled.map((h) => [h.method, h.path])).toEqual([["POST", "/api/v1/agents/x/messages"], ["GET", "/api/v1/agents"]]);
    expect(w.r.handled[0].headers.authorization).toBe("Bearer tok");
    expect(w.r.handled[0].headers["x-forwarded-for"]).toBeUndefined();
    expect(w.r.handled[0].headers.host).not.toBe("evil");
    expect(w.posted.filter((p) => p.endsWith("/hello"))).toHaveLength(1); // 一个会话复用
    expect(w.posted.every((p) => p.startsWith("/api/v1/e2e/"))).toBe(true);
  });

  test("中继看到的字节里没有内层路径、token、正文", async () => {
    const seen: string[] = [];
    const w = await world({ relay: async (req, fwd) => {
      seen.push(Buffer.from(await req.clone().arrayBuffer()).toString("latin1"));
      const res = await fwd(req);
      seen.push(Buffer.from(await res.clone().arrayBuffer()).toString("latin1"));
      return res;
    } });
    await w.call("POST", "/api/v1/agents/secretproj/messages", "机密内容");
    const all = seen.join("\n");
    for (const needle of ["secretproj", "Bearer", "tok", "机密", "echo"]) expect(all.includes(needle)).toBe(false);
  });
});

describe("peer E2E：重放与重复投递", () => {
  test("中继事后重放录下的记录 → 409，路由没再处理", async () => {
    let captured: Request | null = null;
    const w = await world({ relay: async (req, fwd) => {
      if (new URL(req.url).pathname !== "/api/v1/e2e/hello" && !captured) captured = await copy(req);
      return fwd(req);
    } });
    await w.call("POST", "/api/v1/agents/x/messages", "once");
    const again = (await serveE2e(captured!, new URL(captured!.url).pathname, w.bDeps, { sender: w.a.fp }))!;
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe("e2e_replay");
    expect(w.r.handled).toHaveLength(1);
  });

  test("同一条记录并发投两份：只有一份通过（查并记同步），另一份 409", async () => {
    const statuses: number[] = [];
    const w = await world({ relay: async (req, fwd) => {
      if (new URL(req.url).pathname === "/api/v1/e2e/hello") return fwd(req);
      const dup = await copy(req);
      const [r1, r2] = await Promise.all([fwd(req), fwd(dup)]);
      statuses.push(r1.status, r2.status);
      return r1.status === 200 ? r1 : r2;
    } });
    expect((await w.call("POST", "/api/v1/x", "dup")).status).toBe(201);
    expect(statuses.sort()).toEqual([200, 409]);
    expect(w.r.handled).toHaveLength(1);
  });

  test("原请求已被处理、中继伪造 401 e2e_session：发起方重握手重发同一份内层，收方认出重放，不处理第二次", async () => {
    let forged = false;
    const w = await world({ relay: async (req, fwd) => {
      const res = await fwd(req);
      if (!forged && new URL(req.url).pathname !== "/api/v1/e2e/hello") {
        forged = true;
        return Response.json({ ok: false, code: "e2e_session" }, { status: 401 });
      }
      return res;
    } });
    const err = await w.call("POST", "/api/v1/agents/x/messages", "pay once").catch((e: E2eError) => e);
    expect(err).toMatchObject({ code: "e2e_duplicate" }); // 已处理过：明确告诉调用方别重发
    expect(w.r.handled).toHaveLength(1);
    expect(w.posted.filter((p) => p.endsWith("/hello"))).toHaveLength(2);
  });

  test("会话只是被淘汰（对方没重启）：重握手后原样重发成功，只处理一次", async () => {
    const w = await world();
    await w.call("GET", "/api/v1/agents");
    w.bDeps.sessions = new SessionTable();
    expect((await w.call("POST", "/api/v1/x", "evicted")).status).toBe(201);
    expect(w.r.handled.filter((h) => h.method === "POST")).toHaveLength(1);
  });

  test("对方真的重启过：重启前签的非 GET 被拒；认证只证明重试被拒，报「结果未知」不说请重发（T59），新签的照常", async () => {
    const w = await world();
    await w.call("GET", "/api/v1/agents");
    // 调用方先签好，发出前对方重启：模拟「会话在、签名在，进程换了」
    const signed = w.call("POST", "/api/v1/x", "before restart");
    w.restartB();
    const err = await signed.catch((e: E2eError) => e);
    expect(err).toMatchObject({ code: "e2e_outcome_unknown", sent: true });
    expect(peerCallFailureText("peer b/x", err, "b")).not.toContain("请重发");
    expect(w.r.handled.filter((h) => h.method === "POST")).toHaveLength(0);
    expect((await w.call("POST", "/api/v1/x", "resent")).status).toBe(201);
  });

  test("第一次发就被内层拒（本机时钟慢、同一签名发了两次）：原样交回 401 给 peerAuthHint，不报成「重启过」「已处理过」", async () => {
    const w = await world();
    await w.call("GET", "/api/v1/agents");
    w.r.restart(1_000); // 会话还在：签名时间早于对方启动只可能是本机时钟慢
    const slow = await w.call("POST", "/api/v1/x", "slow clock");
    expect(slow.status).toBe(401);
    expect(await slow.json()).toMatchObject({ code: "peer_signature", reason: "before_start" });
    const same = { authorization: "Bearer tok", [SIG_HEADERS.sig]: randomUUID(), [SIG_HEADERS.ts]: "2000" };
    expect((await w.client.fetch("POST", "/api/v1/x", same, utf8("once"))).status).toBe(201);
    const twice = await w.client.fetch("POST", "/api/v1/x", same, utf8("once"));
    expect(twice.status).toBe(401);
    expect(await twice.json()).toMatchObject({ code: "peer_signature", reason: "replay" });
    expect(w.r.handled.filter((h) => h.method === "POST")).toHaveLength(1);
  });
});

describe("peer E2E：篡改与降级", () => {
  test("改请求记录 → 400，窗口不动：原样再发同一个 rid 仍能通过", async () => {
    let saved: Request | null = null;
    const w = await world({ relay: async (req, fwd) => {
      if (new URL(req.url).pathname === "/api/v1/e2e/hello" || saved) return fwd(req);
      saved = await copy(req);
      const b = new Uint8Array(await req.arrayBuffer());
      b[b.length - 1] ^= 1;
      const bad = await fwd(new Request(req.url, { method: "POST", headers: req.headers, body: b }));
      expect(bad.status).toBe(400);
      return fwd(saved);
    } });
    expect((await w.call("POST", "/api/v1/x", "intact")).status).toBe(201);
    expect(w.r.handled).toHaveLength(1);
  });

  test("改响应、互换两个请求的响应 → 发起方抛 e2e_record", async () => {
    const w = await world({ relay: async (req, fwd) => {
      const res = await fwd(req);
      if (new URL(req.url).pathname === "/api/v1/e2e/hello") return res;
      const b = new Uint8Array(await res.arrayBuffer());
      b[10] ^= 1;
      return new Response(b, { status: 200, headers: res.headers });
    } });
    await expect(w.call("GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_record" });

    let first: Uint8Array | null = null;
    const w2 = await world({ relay: async (req, fwd) => {
      const res = await fwd(req);
      if (new URL(req.url).pathname === "/api/v1/e2e/hello") return res;
      const body = new Uint8Array(await res.arrayBuffer());
      first ??= body; // 第二个请求拿到第一个的响应
      return new Response(first, { status: 200, headers: res.headers });
    } });
    await w2.call("GET", "/api/v1/agents");
    await expect(w2.call("GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_record" });
  });

  test("中继冒充 B 应答 hello（没有 B 的 M）→ confirm 对不上，一个内层请求都没发出", async () => {
    const evil = await generateEcdh();
    const w = await world({ relay: async (req, fwd) => {
      if (new URL(req.url).pathname !== "/api/v1/e2e/hello") return fwd(req);
      const h = (await req.json()) as { ce: string };
      const ce = Uint8Array.from(Buffer.from(h.ce, "base64url"));
      const r = await respond({ fp: w.b.fp, devId: utf8(w.a.fp), label: PEER_E2E_LABEL }, { local: evil, remoteStatic: w.a.m.pair.pub, ce });
      return new Response(encodeHelloReply({ be: r.be, sid: r.sid, ttl: 86400, confirm: r.confirm, key: w.b.blob }));
    } });
    await expect(w.call("POST", "/api/v1/x", "secret")).rejects.toMatchObject({ code: "e2e_confirm" });
    expect(w.posted).toEqual(["/api/v1/e2e/hello"]);
  });

  test("对方不支持（404）、中继报错（502）、任何非记录流的 200 → 抛错，绝不换明文重试", async () => {
    const fakes: [string, number, Record<string, string>][] = [["nope", 404, {}], ["bad gateway", 502, {}], ['{"ok":true}', 200, { "content-type": "application/json" }]];
    for (const [body, status, headers] of fakes) {
      const w = await world({ relay: async (req, fwd) => (new URL(req.url).pathname === "/api/v1/e2e/hello" ? fwd(req) : new Response(body, { status, headers })) });
      await expect(w.call("POST", "/api/v1/x", "p")).rejects.toBeInstanceOf(E2eError);
      expect(w.posted.every((p) => p.startsWith("/api/v1/e2e/"))).toBe(true);
      expect(w.r.handled).toHaveLength(0);
    }
  });
});

describe("peer E2E：hello 的准入", () => {
  test("未知 peer 403、发给别人 400、套件不认识 400、外层没签名 401、中继盖的发送方对不上 403", async () => {
    const w = await world();
    const hello = async (body: Record<string, unknown>, signed = true, sender = w.a.fp) => {
      const raw = utf8(JSON.stringify(body));
      const req = new Request("http://b.local/api/v1/e2e/hello", { method: "POST", body: raw, headers: signed ? signedHeaders("POST", "/api/v1/e2e/hello", raw, w.a.id) : {} });
      const res = (await serveE2e(req, "/api/v1/e2e/hello", w.bDeps, { sender }))!;
      return [res.status, ((await res.json()) as { code: string }).code];
    };
    const base = { v: 1, suite: { kem: 16, kdf: 1, aead: 2 }, from: w.a.fp, to: w.b.fp, ce: toB64url((await generateEcdh()).pub), key: w.a.blob };
    expect(await hello({ ...base, suite: { kem: 16, kdf: 1, aead: 1 } })).toEqual([400, "e2e_suite"]);
    expect(await hello({ ...base, to: "0000-0000-0000-0000" })).toEqual([400, "e2e_wrong_target"]);
    expect(await hello(base, false)).toEqual([401, "e2e_signature"]);
    expect(await hello(base, true, "1111-1111-1111-1111")).toEqual([403, "e2e_peer_mismatch"]);
    w.setBKnowsA(null);
    expect(await hello(base)).toEqual([403, "e2e_unknown_peer"]);
  });

  test("对方拿出比钉住的更旧的块 → e2e_key_stale；更新的块在 confirm 之后才钉", async () => {
    const w = await world();
    w.setAKnowsB({ ...asPeer(w.b, "b"), ek: { ...w.b.blob, v: 2 } });
    await expect(w.call("GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_key_stale" });

    const w2 = await world();
    const rotated = await generateEcdh();
    w2.b.m = { pair: rotated, ts: 1790000100 };
    w2.b.blob = signE2eKey(w2.b.id, rotated.pub, 2, 1790000100);
    expect((await w2.call("GET", "/api/v1/agents")).status).toBe(200);
    expect(w2.pinnedByA.map((k) => k.v)).toEqual([2]);
  });
});

describe("peer E2E：会话生命期", () => {
  test("peer 在会话期间被删：下一条 401，重握手被拒 → 状态未知（原因 e2e_unknown_peer），路由没处理", async () => {
    const w = await world();
    await w.call("GET", "/api/v1/agents");
    w.setBKnowsA(null);
    await expect(w.call("POST", "/api/v1/x", "late")).rejects.toMatchObject({ code: "e2e_retry_failed", sent: true, cause: { code: "e2e_unknown_peer" } }); // 第一次的记录帧已发出：只能报状态未知
    expect(w.r.handled).toHaveLength(1);
  });

  test("解密的 await 期间 peer 被删（第 3 步再查）→ 401，不分发", async () => {
    let kill: (() => void) | null = null;
    const w = await world({ relay: async (req, fwd) => {
      const p = fwd(req); // 收方同步跑到第一个 await 就让出，这时删 peer = 删在解密期间
      if (new URL(req.url).pathname !== "/api/v1/e2e/hello") kill?.();
      return p;
    } });
    await w.call("GET", "/api/v1/agents");
    kill = () => w.setBKnowsA(null);
    await expect(w.call("POST", "/api/v1/x", "race")).rejects.toMatchObject({ code: "e2e_retry_failed", sent: true, cause: { code: "e2e_unknown_peer" } }); // 第一次的记录帧已发出：只能报状态未知
    expect(w.r.handled).toHaveLength(1);
  });

  test("用量耗尽、TTL 到期 → 换新会话；每个发起方最多留 16 个", async () => {
    let now = 1_800_000_000_000;
    const w = await world({ limits: { maxRequests: 2 }, now: () => now });
    for (let k = 0; k < 3; k++) await w.call("GET", "/api/v1/agents");
    expect(w.posted.filter((p) => p.endsWith("/hello"))).toHaveLength(2);
    now += 25 * 3600_000;
    await w.call("GET", "/api/v1/agents");
    expect(w.posted.filter((p) => p.endsWith("/hello"))).toHaveLength(3);

    const t = new SessionTable({ perPeer: 16 });
    const keys = { c2b: {} as CryptoKey, b2c: {} as CryptoKey, th: new Uint8Array(32) };
    for (let n = 0; n < 20; n++) t.add("aaaa-aaaa-aaaa-aaaa", crypto.getRandomValues(new Uint8Array(16)), keys);
    t.add("bbbb-bbbb-bbbb-bbbb", crypto.getRandomValues(new Uint8Array(16)), keys);
    expect(t.size).toBe(17);
  });

  test("内层路径不合规（套娃 /api/v1/e2e/、不在 /api/v1/ 下）→ 加密的 400，路由不处理", async () => {
    const w = await world();
    expect((await w.client.fetch("GET", "/api/v1/e2e/hello", {})).status).toBe(400);
    expect((await w.client.fetch("GET", "/admin", {})).status).toBe(400);
    expect(w.r.handled).toHaveLength(0);
  });
});

const isHello = (req: Request) => new URL(req.url).pathname === "/api/v1/e2e/hello";

describe("外层明文伪造不出可信的投递结局", () => {
  // 本机 / 认证过的内层才有资格用的 code：中继写进明文错误体，也只能换来「已发出、状态未知」
  const RESERVED = ["e2e_peer_restarted", "e2e_duplicate", "e2e_too_large", "e2e_unavailable", "e2e_bad_peer", "e2e_session"];
  test("收方已处理后，中继把响应换成带保留 code 的明文：一律是 sent 的外层错误，话术是「结果未知」，不说没送到 / 请重发 / 重启过", async () => {
    for (const code of RESERVED) {
      for (const status of [401, 413, 500]) {
        const w = await world({ relay: async (req, fwd) => {
          const res = await fwd(req);
          return isHello(req) ? res : Response.json({ ok: false, code }, { status });
        } });
        const err = await w.call("POST", "/api/v1/x", "pay once").catch((e) => e);
        expect(err).toBeInstanceOf(E2eOuterError);
        expect(err).not.toBeInstanceOf(E2eInnerError);
        expect(err).not.toBeInstanceOf(E2eLocalError);
        expect(err.sent).toBe(true);
        expect(w.r.handled).toHaveLength(1); // 确实已经处理过
        const text = peerCallFailureText("x@b", err, "b");
        expect(text).toContain("结果未知");
        expect(text).not.toMatch(/没送到|没有发出|请重发|重启过/);
      }
    }
  });

  test("对照：发出之前本机就拒的（加密后超限）是 E2eLocalError，话术「没送到」，一个记录帧都没发", async () => {
    const w = await world();
    const err = await w.call("POST", "/api/v1/x", "x".repeat(3 * 1024 * 1024)).catch((e) => e);
    expect(err).toBeInstanceOf(E2eLocalError);
    expect(peerCallFailureText("x@b", err, "b")).toContain("消息没送到");
    expect(w.posted.filter((p) => !p.endsWith("/hello"))).toEqual([]);
  });
});

describe("外层响应先封顶、边收边验", () => {
  /** 一个数着被拉了几段、被没被 cancel 的流 */
  const counted = (chunk: Uint8Array, max = Infinity) => {
    const st = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull: (c) => void (++st.pulled > max ? c.close() : c.enqueue(chunk)),
      cancel: () => void (st.cancelled = true),
    });
    return { st, stream };
  };
  const OCTET = { "content-type": "application/octet-stream" };

  test("记录响应换成 128 × 64 KiB 的零：第一条长度就不对，读一两段就掐断，e2e_record（sent）", async () => {
    const { st, stream } = counted(new Uint8Array(64 * 1024), 128);
    const w = await world({ relay: async (req, fwd) => (isHello(req) ? fwd(req) : new Response(stream, { status: 200, headers: OCTET })) });
    const err = await w.call("GET", "/api/v1/agents").catch((e) => e);
    expect(err).toMatchObject({ code: "e2e_record", sent: true });
    expect(st.pulled).toBeLessThan(4);
    expect(st.cancelled).toBe(true);
  });

  test("hello 回复、错误体灌无限的明文：读过 8 KiB 就掐断，按坏回复报", async () => {
    const hello = counted(utf8("{" + " ".repeat(4095)));
    const w = await world({ relay: async (req, fwd) => (isHello(req) ? new Response(hello.stream, { status: 200 }) : fwd(req)) });
    await expect(w.call("GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_bad_reply", sent: false });
    expect(hello.st.pulled).toBeLessThan(5);
    expect(hello.st.cancelled).toBe(true);
    const errBody = counted(utf8(" ".repeat(4096)));
    const w2 = await world({ relay: async (req, fwd) => (isHello(req) ? fwd(req) : new Response(errBody.stream, { status: 502 })) });
    await expect(w2.call("GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_http_502", sent: true });
    expect(errBody.st.pulled).toBeLessThan(5);
  });

  test("响应头到了正文挂着不动：空闲超时掐断（e2e_idle）", async () => {
    let cancelled = false;
    const stuck = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => void (cancelled = true) });
    const w = await world({ bodyLimits: { idleMs: 50 }, relay: async (req, fwd) => (isHello(req) ? fwd(req) : new Response(stuck, { status: 200, headers: OCTET })) });
    await expect(w.call("GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_idle", sent: true });
    expect(cancelled).toBe(true);
  });

  test("空段洪泛不算动静（e2e_idle）；一字节一字节地喂撑不过总时限（e2e_body_timeout）", async () => {
    const empties = new ReadableStream<Uint8Array>({ pull: async (c) => { await new Promise((r) => setTimeout(r, 6)); c.enqueue(new Uint8Array(0)); } });
    const w = await world({ bodyLimits: { idleMs: 10 }, relay: async (req, fwd) => (isHello(req) ? fwd(req) : new Response(empties, { status: 200, headers: OCTET })) });
    await expect(w.call("GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_idle", sent: true });
    let i = 0; // 先给一个合法的长度头（64 字节的记录），再 1 字节 1 字节地喂密文
    const trickle = new ReadableStream<Uint8Array>({ pull: async (c) => { await new Promise((r) => setTimeout(r, 5)); c.enqueue(new Uint8Array([i++ === 3 ? 64 : 0])); } });
    const w2 = await world({ bodyLimits: { idleMs: 50, totalMs: 120 }, relay: async (req, fwd) => (isHello(req) ? fwd(req) : new Response(trickle, { status: 200, headers: OCTET })) });
    const err = await w2.call("GET", "/api/v1/agents").catch((e) => e);
    expect(err).toMatchObject({ code: "e2e_body_timeout", sent: true });
  });

  test("认证过的响应也有总量上限：对方回 9 MiB → e2e_record；8 MiB 以内照常", async () => {
    const w = await world();
    w.bDeps.dispatch = async () => new Response(new Uint8Array(9 * 1024 * 1024));
    await expect(w.call("GET", "/api/v1/agents")).rejects.toMatchObject({ code: "e2e_record", sent: true });
    w.bDeps.dispatch = async () => new Response(new Uint8Array(1024 * 1024));
    expect((await w.call("GET", "/api/v1/agents")).status).toBe(200);
  });
});

// ── T59 回归（复现来自对方 Codex 的 review-probe，断言改成正确行为）──

describe("T59 P1-1：重握手后的 before_start 报「结果未知」，不诱导重发", () => {
  test("第一次已被处理、回执丢了、对方重启、认证过的重试被拒：code e2e_outcome_unknown、handled=1、没有「请重发」", async () => {
    let first = true;
    const w = await world({ relay: async (req, fwd) => {
      const res = await fwd(req);
      if (first && !req.url.endsWith("/hello")) { first = false; w.restartB(); return Response.json({ code: "e2e_session" }, { status: 401 }); }
      return res;
    } });
    const error = await w.call("POST", "/api/v1/agents/x/messages", "execute once").catch((e) => e);
    expect(w.r.handled.length).toBe(1);
    expect(error).toBeInstanceOf(E2eOuterError);
    expect(error).toMatchObject({ code: "e2e_outcome_unknown", sent: true });
    const text = peerCallFailureText("peer b/x", error, "b");
    expect(text).toContain("结果未知");
    expect(text).not.toContain("请重发");
    expect(error.message).not.toContain("请重发");
  });
});

describe("T59 P1-2：会话缓存，传输与 signal 按请求", () => {
  async function outbound() {
    const w = await world();
    const out = createE2eOutbound({
      local: async () => ({ key: w.a.id, fp: w.a.fp, machine: w.a.m, signed: w.a.blob }),
      peers: async () => [{ name: "b", baseUrl: "http://b.local", outToken: "tok", fp: w.b.fp, e2e: { idk: w.b.id.publicKey, ek: w.b.blob }, addedAt: "" }],
      pin: async () => {},
      sign: (m, p, b) => signedHeaders(m, p, b, w.a.id),
    });
    const serve = async (u: string, init: { method: "POST"; headers: Record<string, string>; body: Uint8Array }) =>
      (await serveE2e(new Request(u, init), new URL(u).pathname, w.bDeps, { sender: w.a.fp }))!;
    return { w, out, serve };
  }

  test("第一次的 signal 到期后，第二次换了新传输：走新的（secondUsed=1），调用成功", async () => {
    const { out, serve } = await outbound();
    const first = new AbortController();
    let secondUsed = 0;
    const raw1 = async (u: string, init: Parameters<typeof serve>[1]) => { first.signal.throwIfAborted(); return serve(u, init); };
    const raw2 = async (u: string, init: Parameters<typeof serve>[1]) => { secondUsed++; return serve(u, init); };
    expect((await out.fetch("http://b.local/api/v1/agents", { method: "GET" }, raw1))!.status).toBe(200);
    first.abort();
    const res = await out.fetch("http://b.local/api/v1/agents", { method: "GET" }, raw2);
    expect(secondUsed).toBe(1);
    expect(res!.status).toBe(200);
  });

  test("取消新调用只影响它自己：已取消的传输立刻失败，下一次照常", async () => {
    const { out, serve } = await outbound();
    const ok = async (u: string, init: Parameters<typeof serve>[1]) => serve(u, init);
    expect((await out.fetch("http://b.local/api/v1/agents", { method: "GET" }, ok))!.status).toBe(200);
    const cancelled = new AbortController();
    cancelled.abort();
    const raw = async (u: string, init: Parameters<typeof serve>[1]) => { cancelled.signal.throwIfAborted(); return serve(u, init); };
    await expect(out.fetch("http://b.local/api/v1/agents", { method: "GET" }, raw)).rejects.toMatchObject({ code: "e2e_transport" });
    expect((await out.fetch("http://b.local/api/v1/agents", { method: "GET" }, ok))!.status).toBe(200);
  });

  test("并发握手：发起握手的请求被取消，等它的请求用自己的传输重握成功，不陪着失败", async () => {
    const { out, serve } = await outbound();
    const aborting = async () => { await new Promise((r) => setTimeout(r, 20)); throw new DOMException("aborted", "AbortError"); };
    let bUsed = 0;
    const rawB = async (u: string, init: Parameters<typeof serve>[1]) => { bUsed++; return serve(u, init); };
    const a = out.fetch("http://b.local/api/v1/agents", { method: "GET" }, aborting);
    const b = out.fetch("http://b.local/api/v1/agents", { method: "GET" }, rawB);
    await expect(a).rejects.toThrow(); // 握手阶段的传输错误原样抛（记录帧还没发，不算状态未知）
    expect((await b)!.status).toBe(200);
    expect(bUsed).toBeGreaterThanOrEqual(2); // 自己的 hello + 记录帧
  });
});
