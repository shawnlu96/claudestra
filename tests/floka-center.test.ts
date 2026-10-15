/**
 * rename-floka-CENTER1：中继中心双认与认证能力协商。全部跑在本机假端口上：
 *   真中心（src/relay/server.ts，旧 = 不给 rename、新 = 两档 on）× 真客户端（src/lib/relay-client.ts，旧 = 不给 rename、新 = 两档 on），
 *   另有一个脚本化的假中心（只为给客户端喂各种能力），和直接说协议的裸 WebSocket 客户端（造冲突头、伪来源、错签名）。
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createRelay, type Relay, type RelayOptions } from "../src/relay/server.ts";
import { connect, type RelayClient } from "../src/lib/relay-client.ts";
import { instanceKeySync, type InstanceKey } from "../src/lib/instance-key.ts";
import { authSignature, keyFingerprint, SUBPROTOCOL, verifyAuthSignature } from "../src/lib/relay-protocol.ts";
import { signRelayAuth } from "../src/lib/floka-compat/relay/handshake.ts";
import { CENTER_CAPABILITY_TTL_MS, admitCenterCapability, issueCenterCapability } from "../src/lib/floka-center/capability.ts";
import { centerForward, centerHello, centerSubprotocol, centerTunnel, centerVerifyAuth, centerWelcome } from "../src/lib/floka-center/center.ts";
import { CenterLink } from "../src/lib/floka-center/client.ts";
import { parseCenterRename } from "../src/lib/floka-center/gear.ts";

const BASE = "relay.test";
const NEW = { centerReceive: "on", centerSend: "on" };
const FLOKA = "floka-relay.v2";
const quiet = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = (): InstanceKey => instanceKeySync(mkdtempSync(join(tmpdir(), "floka-center-")))!;
const fpOf = (k: InstanceKey) => keyFingerprint(k.publicKey);

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting");
    await sleep(15);
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
afterAll(() => {
  for (const f of cleanup.splice(0)) f();
});

function center(rename?: object, extra: Partial<RelayOptions> = {}): Relay {
  const r = createRelay({ base: BASE, port: 0, db: ":memory:", log: quiet, ...extra, ...(rename ? { rename } : {}) });
  cleanup.push(() => r.stop());
  return r;
}

const wsUrl = (port: number) => `ws://127.0.0.1:${port}/v1/ws`;

/** 收到的 peer 请求：发起方指纹与头 */
type Seen = { from: string; headers: Record<string, string> };

function client(port: number, key: InstanceKey, slug: string, rename?: object, seen: Seen[] = []): RelayClient {
  const c = connect({
    relayUrl: wsUrl(port), key, name: slug, slug, log: quiet, ...(rename ? { rename } : {}),
    timing: { backoffMs: [30], fatalRetryMs: 30, heartbeatMs: 60_000 },
    onInbound: async (req, ctx) => {
      seen.push({ from: ctx.from, headers: req.headers });
      return { status: 200, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("ok") };
    },
  });
  cleanup.push(() => c.close());
  return c;
}

const online = (c: RelayClient) => waitFor(() => c.state === "online");

/** 断开再连：等它重新上线（中继顶掉连接后客户端按退避重连） */
async function reconnect(relay: Relay, c: RelayClient, key: InstanceKey): Promise<void> {
  expect(relay.dropConnection(fpOf(key))).toBe(true);
  await waitFor(() => c.state !== "online");
  await online(c);
}

/** 说协议的裸客户端：自己挑提议的子协议与签名的族 */
async function raw(port: number, key: InstanceKey, offer: string[], signAs: "legacy" | "floka" = "legacy") {
  const frames: Record<string, unknown>[] = [];
  const ws = new WebSocket(wsUrl(port), offer);
  cleanup.push(() => ws.close());
  const closed = new Promise<number>((r) => (ws.onclose = (ev) => r(ev.code)));
  ws.onmessage = (ev) => {
    const f = JSON.parse(String(ev.data));
    frames.push(f);
    if (f.t !== "hello") return;
    const a = { key: key.publicKey, nonce: f.nonce, name: "raw", slug: "raw" };
    const sig = signAs === "legacy" ? authSignature(key.privateKey, a.nonce, a.key, a.name, a.slug) : signRelayAuth("floka", key.privateKey, a);
    ws.send(JSON.stringify({ t: "auth", v: 2, ...a, sig }));
  };
  const opened = await new Promise<boolean>((r) => {
    ws.onopen = () => r(true);
    ws.onerror = () => r(false);
  });
  return { ws, frames, closed, opened, find: (t: string) => frames.find((f) => f.t === t) };
}

// ── 验收线 1：四向矩阵 ─────────────────────────────────────────────────

describe("[验收线 1] 旧 / 新客户端 × 旧 / 新中心", () => {
  const cases = [
    { center: "old", client: "old", second: "legacy" },
    { center: "old", client: "new", second: "legacy" },
    { center: "new", client: "old", second: "legacy" },
    { center: "new", client: "new", second: "floka" },
  ] as const;

  for (const k of cases) {
    test(`${k.client} 客户端连 ${k.center} 中心：上线、互发请求，重连后族 = ${k.second}`, async () => {
      const relay = center(k.center === "new" ? NEW : undefined);
      const keyA = newKey(), keyB = newKey();
      const seenB: Seen[] = [];
      const a = client(relay.port, keyA, "alpha", k.client === "new" ? NEW : undefined);
      const b = client(relay.port, keyB, "beta", undefined, seenB);
      await Promise.all([online(a), online(b)]);
      expect(a.family).toBe("legacy"); // 第一次连接谁都还没有中心的能力
      expect(a.info().fp).toBe(fpOf(keyA));
      await reconnect(relay, a, keyA);
      expect(a.family).toBe(k.second);
      expect(a.info()).toMatchObject({ fp: fpOf(keyA), slug: "alpha" });
      a.setContacts([fpOf(keyB)]);
      b.setContacts([fpOf(keyA)]);
      await sleep(80);
      const res = await a.request(fpOf(keyB), { method: "GET", path: "/api/v1/ping", headers: {} });
      expect(res.status).toBe(200);
      expect(seenB.at(-1)?.from).toBe(fpOf(keyA));
    });
  }

  test("新中心上一字未改的旧握手（只提议旧子协议、旧用途签名）照常上线，能力字段不影响它", async () => {
    const relay = center(NEW);
    const key = newKey();
    const c = await raw(relay.port, key, [SUBPROTOCOL]);
    expect(c.opened).toBe(true);
    expect(c.ws.protocol).toBe(SUBPROTOCOL);
    await waitFor(() => !!c.find("welcome"));
    expect(c.find("welcome")).toMatchObject({ t: "welcome", v: 2, fp: fpOf(key), slug: "raw" });
    expect(c.find("hello")!.subprotocol).toBeUndefined(); // 旧族连接的 hello 一字不变
    expect(relay.online()).toEqual([fpOf(key)]);
  });

  test("旧中心不发能力：新客户端反复重连都停在旧族", async () => {
    const relay = center();
    const key = newKey();
    const c = client(relay.port, key, "alpha", NEW);
    await online(c);
    for (let i = 0; i < 2; i++) await reconnect(relay, c, key);
    expect(c.family).toBe("legacy");
  });
});

// ── 验收线 2：冲突头、伪来源、验签失败、未知能力 ─────────────────────────

describe("[验收线 2] 不降级、不切新", () => {
  // 中心这一侧（centerSubprotocol）on 档认单独的新族提议，见验收线 3 的单元用例；front 的 426 闸在 src/relay/front.ts，不在本卡范围
  test("只提议新族子协议：front 照旧 426，中心不因此切新", async () => {
    const relay = center(NEW);
    const c = await raw(relay.port, newKey(), [FLOKA]);
    expect(c.opened).toBe(false);
    expect(relay.online()).toEqual([]);
  });

  test("新族连接用旧用途签名：拒（auth_failed），不降级到旧族", async () => {
    const relay = center(NEW);
    const c = await raw(relay.port, newKey(), [FLOKA, SUBPROTOCOL], "legacy");
    await c.closed;
    expect(c.find("hello")!.subprotocol).toBe(FLOKA); // 客户端按 hello 报的族签，不读 ws.protocol
    expect(c.find("error")).toMatchObject({ code: "auth_failed" });
    expect(c.find("welcome")).toBeUndefined();
  });

  test("旧族连接用新用途签名：拒，不切新", async () => {
    for (const relay of [center(NEW), center()]) {
      const c = await raw(relay.port, newKey(), [SUBPROTOCOL], "floka");
      expect(c.ws.protocol).toBe(SUBPROTOCOL);
      await c.closed;
      expect(c.find("error")).toMatchObject({ code: "auth_failed" });
    }
  });

  test("接收不是 on 的中心收到两族提议：一律旧族；新用途签名照旧拒", async () => {
    for (const rename of [undefined, { centerReceive: "observe" }, { centerReceive: "observe", centerSend: "on" }]) {
      const relay = center(rename);
      const ok = await raw(relay.port, newKey(), [FLOKA, SUBPROTOCOL]);
      expect(ok.ws.protocol).toBe(SUBPROTOCOL);
      await waitFor(() => !!ok.find("welcome"));
      expect(ok.find("welcome")!.capability).toBeUndefined();
      const bad = await raw(relay.port, newKey(), [FLOKA, SUBPROTOCOL], "floka");
      await bad.closed;
      expect(bad.find("error")).toMatchObject({ code: "auth_failed" });
    }
  });

  test("peer 请求自带两族的来源头 / 标记头：新中心转发前去掉，其余头不动", async () => {
    const relay = center(NEW);
    const keyB = newKey();
    const seenB: Seen[] = [];
    const b = client(relay.port, keyB, "beta", undefined, seenB);
    const keyA = newKey();
    const a = await raw(relay.port, keyA, [SUBPROTOCOL]);
    await Promise.all([online(b), waitFor(() => !!a.find("welcome"))]);
    b.setContacts([fpOf(keyA)]);
    a.ws.send(JSON.stringify({ t: "contacts", fps: [fpOf(keyB)] }));
    await sleep(80);
    const forged = {
      "x-claudestra-relay-from": fpOf(keyB), "x-floka-relay-from": fpOf(keyB), "x-floka-relay-base": "evil.test",
      "x-claudestra-relay-mark": "m", "x-floka-relay-mark": "m", "x-claudestra-tunnel-mark": "t", "x-floka-tunnel-mark": "t",
    };
    const keep = { "content-type": "application/json", "x-claudestra-key": "k", "x-floka-ts": "1" };
    a.ws.send(JSON.stringify({ t: "req", id: "r1", to: fpOf(keyB), method: "GET", path: "/api/v1/ping", headers: { ...forged, ...keep } }));
    await waitFor(() => seenB.length === 1);
    expect(seenB[0].from).toBe(fpOf(keyA));
    for (const k of Object.keys(forged)) expect(seenB[0].headers[k]).toBeUndefined();
    expect(seenB[0].headers).toMatchObject(keep);
  });

  test("隧道请求夹带新族中继头 / 两族标记头：新中心转给实例前去掉，front 盖的旧族头留着", async () => {
    const relay = center(NEW, { trustProxy: true });
    const key = newKey();
    const seen: Seen[] = [];
    const c = client(relay.port, key, "beta", NEW, seen);
    await online(c);
    await reconnect(relay, c, key);
    expect(c.family).toBe("floka");
    const forged = { "x-floka-relay-from": fpOf(newKey()), "x-floka-relay-mark": "m", "x-floka-relay-base": "evil.test", "x-claudestra-tunnel-mark": "t" };
    const res = await fetch(`http://127.0.0.1:${relay.port}/api/v1/ping`, { headers: { "x-forwarded-host": `beta.${BASE}`, ...forged, accept: "*/*" } });
    expect(res.status).toBe(200);
    expect(seen.at(-1)!.from).toBe("relay");
    for (const k of Object.keys(forged)) expect(seen.at(-1)!.headers[k]).toBeUndefined();
    expect(seen.at(-1)!.headers).toMatchObject({ "x-claudestra-relay-base": BASE, accept: "*/*" });
  });

  test("centerTunnel：只动 from relay 的 req；off / observe 原样", () => {
    const headers: Record<string, string> = { "X-Floka-Relay-Base": "evil.test", "x-claudestra-relay-base": BASE, "x-floka-tunnel-mark": "t", accept: "*/*" };
    const req = { t: "req", id: "1", from: "relay", headers };
    expect(centerTunnel(req, { rename: NEW }).headers).toEqual({ "x-claudestra-relay-base": BASE, accept: "*/*" });
    const peer = { ...req, from: fpOf(newKey()) };
    expect(centerTunnel(peer, { rename: NEW })).toBe(peer);
    const data = { t: "data", id: "1", from: "relay", b64: "" };
    expect(centerTunnel(data, { rename: NEW })).toBe(data);
    for (const rename of [undefined, { centerReceive: "observe" }]) expect(centerTunnel(req, { rename, log: quiet })).toBe(req);
  });

  test("centerForward：大小写不同的伪来源头同样去掉", () => {
    const out = centerForward<{ headers: Record<string, string> }>({ headers: { "X-Floka-Relay-From": "x", "X-Claudestra-Relay-Prefix": "/m/x", accept: "*/*" } }, { rename: NEW });
    expect(out.headers).toEqual({ accept: "*/*" });
  });

  test("能力：认证前的、形状不对的、未知族、身份 / 版本不符、过期、有效期过长、签发在未来，都不切新", async () => {
    const key = newKey();
    const fp = fpOf(key);
    const now = Date.now();
    const good = issueCenterCapability(fp, now);
    const bad: [string, unknown][] = [
      ["not_object", "floka"],
      ["unknown_family", { ...good, families: ["legacy", "floka", "floka2"] }],
      ["no_legacy", { ...good, families: ["floka"] }],
      ["legacy_only", { ...good, families: ["legacy"] }],
      ["other_identity", { ...good, fp: fpOf(newKey()) }],
      ["version", { ...good, v: 3 }],
      ["subprotocol", { ...good, subprotocol: "floka-relay.v3" }],
      ["expired", { ...good, issuedAt: now - 2000, expiresAt: now - 1000 }],
      ["ttl", { ...good, expiresAt: good.issuedAt + CENTER_CAPABILITY_TTL_MS + 1 }],
      ["future", { ...good, issuedAt: now + 3_600_000, expiresAt: now + 3_700_000 }],
      ["fraction", { ...good, expiresAt: good.expiresAt + 0.5 }],
    ];
    for (const [, cap] of bad) expect(admitCenterCapability(cap, { fp, authenticated: true }, now).ok).toBe(false);
    expect(admitCenterCapability(good, { fp, authenticated: false }, now)).toEqual({ ok: false, reason: "unauthenticated_capability" });
    expect(admitCenterCapability(good, { fp, authenticated: true }, now)).toMatchObject({ ok: true, capability: good });

    // 端到端：脚本化的假中心按 bad 的顺序在 welcome（或 hello）里发能力，客户端下一次提议必须仍只有旧族
    const fake = fakeCenter([
      ...bad.map(([, cap]) => ({ welcome: cap })),
      { hello: good },
      { welcome: good },
    ]);
    const c = client(fake.port, key, "alpha", NEW);
    await online(c);
    for (let i = 1; i <= bad.length + 1; i++) {
      fake.drop();
      await waitFor(() => fake.offers.length === i + 1);
      await online(c);
      expect(fake.offers[i]).toEqual([SUBPROTOCOL]);
    }
    fake.drop();
    await waitFor(() => fake.offers.length === bad.length + 3);
    expect(fake.offers.at(-1)).toEqual([FLOKA, SUBPROTOCOL]); // 对照：合格能力才提议新族
    expect(c.family).toBe("legacy"); // 假中心选的是旧族：按选定的签，不按自己提议的签
  });
});

describe("[验收线 2] 已切新之后：坏能力不降级，认证前的能力不切新", () => {
  test("先收到有效能力，再收到含未知族的声明：照留有效能力，下次仍提议新族；不带能力字段才撤回", async () => {
    const key = newKey();
    const good = issueCenterCapability(fpOf(key));
    const fake = fakeCenter([{ welcome: good }, { welcome: { ...good, families: ["legacy", "floka", "floka2"] } }, { welcome: { ...good, fp: fpOf(newKey()) } }, {}, {}]);
    const c = client(fake.port, key, "alpha", NEW);
    await online(c);
    for (let i = 1; i <= 4; i++) {
      fake.drop();
      await waitFor(() => fake.offers.length === i + 1);
      await online(c);
    }
    expect(fake.offers).toEqual([[SUBPROTOCOL], [FLOKA, SUBPROTOCOL], [FLOKA, SUBPROTOCOL], [FLOKA, SUBPROTOCOL], [SUBPROTOCOL]]);
  });

  test("中心不发 hello、直接发带匹配指纹与有效能力的 welcome：不收，下次仍只提议旧族", async () => {
    const key = newKey();
    const good = issueCenterCapability(fpOf(key));
    const fake = fakeCenter([{ early: good }, { early: good }]);
    const c = client(fake.port, key, "alpha", NEW);
    await online(c);
    fake.drop();
    await waitFor(() => fake.offers.length === 2);
    await online(c);
    expect(fake.offers).toEqual([[SUBPROTOCOL], [SUBPROTOCOL]]);
    expect(fake.auths).toBe(0);
  });

  test("CenterLink：能力只认本连接发出 auth 之后的第一个 welcome", () => {
    const key = newKey();
    const fp = fpOf(key);
    const good = issueCenterCapability(fp);
    const link = new CenterLink(NEW, key, quiet);
    link.offer();
    link.welcome({ capability: good }); // 还没签 auth
    expect(link.offer()).toEqual([SUBPROTOCOL]);
    link.sign(SUBPROTOCOL, "n", "a", "a");
    link.welcome({ capability: good });
    expect(link.offer()).toEqual([FLOKA, SUBPROTOCOL]);
    link.welcome({}); // 新连接还没认证：撤回也不算
    expect(link.offer()).toEqual([FLOKA, SUBPROTOCOL]);
    link.sign(FLOKA, "n", "a", "a");
    link.welcome({ capability: { ...good, families: ["legacy", "x"] } });
    expect(link.offer()).toEqual([FLOKA, SUBPROTOCOL]);
    link.sign(FLOKA, "n", "a", "a");
    link.welcome({});
    expect(link.offer()).toEqual([SUBPROTOCOL]);
  });
});

/**
 * 只给客户端喂能力的假中心：第 n 次连接按 script[n] 在 hello 或 welcome 里附 capability，子协议总选旧族；
 * early：不发 hello，open 后直接发 welcome（带匹配指纹与 capability）。
 */
function fakeCenter(script: { hello?: unknown; welcome?: unknown; early?: unknown }[], fp?: string) {
  const offers: string[][] = [];
  let auths = 0;
  const conns = new Set<Bun.ServerWebSocket<{ n: number }>>();
  const srv: Server<{ n: number }> = Bun.serve<{ n: number }>({
    port: 0, hostname: "127.0.0.1",
    fetch(req, s) {
      offers.push((req.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim()));
      const ok = s.upgrade(req, { data: { n: offers.length - 1 }, headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL } });
      return ok ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.add(ws);
        const s = script[ws.data.n] ?? {};
        if ("early" in s) {
          const cap = s.early as { fp: string };
          return void ws.send(JSON.stringify({ t: "welcome", v: 2, fp: fp ?? cap.fp, slug: "alpha", name: "alpha", base: BASE, capability: s.early }));
        }
        ws.send(JSON.stringify({ t: "hello", v: 2, nonce: "n", ts: Math.floor(Date.now() / 1000), ...("hello" in s ? { capability: s.hello } : {}) }));
      },
      message(ws, m) {
        const f = JSON.parse(String(m));
        if (f.t !== "auth") return;
        auths++;
        const s = script[ws.data.n] ?? {};
        const welcome = { t: "welcome", v: 2, fp: keyFingerprint(f.key), slug: f.slug, name: f.name, base: BASE };
        ws.send(JSON.stringify({ ...welcome, ...("welcome" in s ? { capability: s.welcome } : {}) }));
      },
      close(ws) {
        conns.delete(ws);
      },
    },
  });
  cleanup.push(() => srv.stop(true));
  return { port: srv.port!, offers, get auths() { return auths; }, drop: () => conns.forEach((ws) => ws.close(4500, "drop")) };
}

// ── 验收线 3：off / observe 不变，回切旧发送不中断身份 ───────────────────

describe("[验收线 3] off / observe 与原接受结果相同", () => {
  const key = newKey();
  const fp = fpOf(key);
  const a = { key: key.publicKey, nonce: "nonce-1", name: "n", slug: "s" };
  const legacySig = authSignature(key.privateKey, a.nonce, a.key, a.name, a.slug);
  const flokaSig = signRelayAuth("floka", key.privateKey, a);
  const offers = [[SUBPROTOCOL], [FLOKA, SUBPROTOCOL], [SUBPROTOCOL, FLOKA], [FLOKA], [], ["x", SUBPROTOCOL]];
  const req = (o: string[]) => new Request("http://x/v1/ws", { headers: o.length ? { "sec-websocket-protocol": o.join(", ") } : {} });

  for (const rename of [undefined, {}, { centerReceive: "off" }, { centerReceive: "observe", centerSend: "observe" }, { centerReceive: "bogus" }]) {
    test(`中心 ${JSON.stringify(rename)}：选旧族、验签同 verifyAuthSignature、welcome 无能力、peer 头原样`, () => {
      const logs: string[] = [];
      const opts = { rename, log: (_: string, m: string) => void logs.push(m) } as Parameters<typeof centerWelcome>[1];
      for (const o of offers) {
        const conn = {};
        expect(centerSubprotocol(req(o), conn, opts)).toBe(SUBPROTOCOL);
        expect(centerHello(conn)).toEqual({});
        for (const sig of [legacySig, flokaSig, "garbage"]) {
          expect(centerVerifyAuth(conn, a, sig, opts)).toBe(verifyAuthSignature(a.key, a.nonce, a.name, a.slug, sig));
        }
      }
      expect(centerWelcome(fp, opts)).toEqual({});
      const frame = { headers: { "x-floka-relay-from": "x", "x-claudestra-relay-from": "y" } };
      expect(centerForward(frame, opts)).toBe(frame);
      if (rename && "centerReceive" in rename && rename.centerReceive === "observe") expect(logs.some((l) => l.includes("on 档会选 floka"))).toBe(true);
    });
  }

  test("中心 on：提议了新族（单独或与旧族并提）就选新族，只按选定的族验签", () => {
    const opts = { rename: NEW, log: quiet };
    for (const o of offers) {
      const conn = {};
      const both = o.includes(FLOKA);
      expect(centerSubprotocol(req(o), conn, opts)).toBe(both ? FLOKA : SUBPROTOCOL);
      expect(centerHello(conn)).toEqual(both ? { subprotocol: FLOKA } : {});
      expect(centerVerifyAuth(conn, a, legacySig, opts)).toBe(!both);
      expect(centerVerifyAuth(conn, a, flokaSig, opts)).toBe(both);
    }
    expect(centerWelcome(fp, opts).capability).toMatchObject({ families: ["legacy", "floka"], fp, v: 2, subprotocol: FLOKA });
  });

  for (const rename of [undefined, { centerReceive: "observe", centerSend: "observe" }, { centerReceive: "on" }, { centerSend: "on" }]) {
    test(`客户端 ${JSON.stringify(rename)}：有合格能力也只提议旧族，签名与现行逐字节相同`, () => {
      const link = new CenterLink(rename, key, quiet);
      link.offer();
      link.sign(SUBPROTOCOL, a.nonce, a.name, a.slug);
      link.welcome({ capability: issueCenterCapability(fp) });
      expect(link.offer()).toEqual([SUBPROTOCOL]);
      expect(link.sign(FLOKA, a.nonce, a.name, a.slug)).toBe(legacySig); // 没提议过的子协议不认
      expect(link.sign(SUBPROTOCOL, a.nonce, a.name, a.slug)).toBe(legacySig);
      expect(link.family).toBe("legacy");
    });
  }

  test("客户端 on：能力过期后回到只提议旧族；welcome 不再带能力就清掉", () => {
    const link = new CenterLink(NEW, key, quiet);
    const now = Date.now();
    link.offer(now);
    link.sign(SUBPROTOCOL, a.nonce, a.name, a.slug);
    link.welcome({ capability: issueCenterCapability(fp, now) }, now);
    expect(link.offer(now)).toEqual([FLOKA, SUBPROTOCOL]);
    expect(link.sign(FLOKA, a.nonce, a.name, a.slug)).toBe(flokaSig);
    expect(link.offer(now + CENTER_CAPABILITY_TTL_MS)).toEqual([SUBPROTOCOL]);
    link.sign(SUBPROTOCOL, a.nonce, a.name, a.slug);
    link.welcome({}, now);
    expect(link.offer(now)).toEqual([SUBPROTOCOL]);
  });

  test("配置解析：缺省 off；发送 on 而接收不是 on 时发送按 observe；读不懂按 off", () => {
    expect(parseCenterRename(undefined)).toEqual({ rename: { receive: "off", send: "off" }, problems: [] });
    expect(parseCenterRename({ centerSend: "on" }).rename).toEqual({ receive: "off", send: "observe" });
    expect(parseCenterRename({ centerReceive: "observe", centerSend: "on" }).rename).toEqual({ receive: "observe", send: "observe" });
    expect(parseCenterRename({ centerReceive: "ON" })).toMatchObject({ rename: { receive: "off", send: "off" }, problems: [expect.any(String)] });
    expect(parseCenterRename("on")).toMatchObject({ rename: { receive: "off", send: "off" }, problems: [expect.any(String)] });
    expect(parseCenterRename(NEW).rename).toEqual({ receive: "on", send: "on" });
  });
});

describe("[验收线 3] 回切旧发送不中断身份", () => {
  test("客户端回切：同一把钥匙改回 off，旧族上线，指纹与 slug 不变", async () => {
    const relay = center(NEW);
    const key = newKey();
    const c = client(relay.port, key, "alpha", NEW);
    await online(c);
    await reconnect(relay, c, key);
    expect(c.family).toBe("floka");
    const before = c.info();
    c.close();
    const back = client(relay.port, key, "alpha");
    await online(back);
    expect(back.family).toBe("legacy");
    expect(back.info()).toMatchObject({ fp: before.fp, slug: before.slug });
  });

  test("中心回切：同一端口同一库换成旧中心，持能力的新客户端自动落到旧族，指纹与 slug 不变", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "floka-center-db-")), "relay.db");
    const first = createRelay({ base: BASE, port: 0, db, log: quiet, rename: NEW });
    const port = first.port;
    const key = newKey();
    const c = client(port, key, "alpha", NEW);
    await online(c);
    await reconnect(first, c, key);
    expect(c.family).toBe("floka");
    const before = c.info();
    first.stop();
    const old = center(undefined, { port, db });
    await waitFor(() => c.state === "online" && old.online().length === 1);
    expect(c.family).toBe("legacy");
    expect(c.info()).toMatchObject({ fp: before.fp, slug: before.slug });
    // 旧中心的 welcome 不带能力：之后的连接只提议旧族
    await reconnect(old, c, key);
    expect(c.family).toBe("legacy");
  });
});
