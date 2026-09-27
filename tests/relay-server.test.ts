/**
 * 中继服务端（src/relay/server.ts）端到端：真实 Bun.serve（port 0）+ tests/relay-test-client.ts 的裸协议客户端。
 * 覆盖握手各失败路径、顶替、slug 分配、联系人门控与在线状态、req/res、流式、cancel、超时、断线。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CLOSE, keyFingerprint, REDEEM_PATH } from "../src/lib/relay-protocol.ts";
import { createRelay, type Relay } from "../src/relay/server.ts";
import { keyFromSeed, seedOf, TestClient } from "./relay-test-client.ts";

let relay: Relay;
let url: string;
const logs: string[] = [];

beforeAll(() => {
  relay = createRelay({
    base: "relay.test", port: 0, db: ":memory:", sweepMs: 50, touchEveryMs: 60_000,
    limits: { authTimeoutMs: 300, nonceTtlMs: 300, idleTimeoutMs: 1500, defaultReqTimeoutMs: 1000, streamIdleMs: 300, streamMaxMs: 5_000, redeemPerMinute: 2, authPerIpPerMinute: 1000 },
    log: (_l, m) => void logs.push(m),
  });
  url = `ws://127.0.0.1:${relay.port}/v1/ws`;
});
afterAll(() => relay.stop());

const key = (n: number) => keyFromSeed(seedOf(n));
const pair = async (a: number, b: number, opts?: { slugA?: string; slugB?: string; mutual?: boolean }) => {
  const A = await TestClient.connect(url, key(a), { name: `A${a}`, slug: opts?.slugA ?? `box-${a}` });
  const B = await TestClient.connect(url, key(b), { name: `B${b}`, slug: opts?.slugB ?? `box-${b}` });
  if (opts?.mutual !== false) {
    await A.contacts([B.fp]);
    await B.contacts([A.fp]);
  }
  return { A, B };
};

describe("握手", () => {
  test("hello → auth → welcome，slug 按请求给", async () => {
    const c = await TestClient.connect(url, key(1), { name: "Mac mini", slug: "mini" });
    expect(c.welcome).toMatchObject({ t: "welcome", v: 2, slug: "mini", name: "Mac mini", base: "relay.test" });
    expect(c.fp).toBe(keyFingerprint(key(1).publicKey));
    c.close();
  });

  test("签名错 → auth_failed + 4401", async () => {
    const c = await TestClient.connect(url, key(2), { sig: "AAAA" });
    expect(c.welcome).toBeNull();
    expect(c.authError?.code).toBe("auth_failed");
    expect((await c.closed).code).toBe(CLOSE.AUTH);
  });

  test("版本不对 → protocol_version + 4400", async () => {
    const c = await TestClient.connect(url, key(3), { v: 1 });
    expect(c.authError?.code).toBe("protocol_version");
    expect((await c.closed).code).toBe(CLOSE.PROTOCOL);
  });

  test("auth 太晚 → nonce_expired（关闭 4401）；从不 auth → auth_timeout 4408", async () => {
    const late = await TestClient.connect(url, key(4), { authDelayMs: 400 });
    expect(String(late.authError?.code)).toMatch(/nonce_expired|auth_timeout/);
    const never = await TestClient.connect(url, key(5), { manualAuth: true });
    expect((await never.closed).code).toBe(CLOSE.TIMEOUT);
  });

  test("welcome 前发业务帧 → not_authenticated 4400", async () => {
    const c = await TestClient.connect(url, key(6), { manualAuth: true });
    c.send({ t: "contacts", fps: [] });
    expect((await c.closed).code).toBe(CLOSE.PROTOCOL);
  });

  test("同钥匙第二条连接顶掉第一条：旧的收 replaced + 4409，新的正常", async () => {
    const first = await TestClient.connect(url, key(7), { slug: "dup" });
    const second = await TestClient.connect(url, key(7), { slug: "dup" });
    expect(second.welcome?.slug).toBe("dup");
    const closed = await first.closed;
    expect(closed.code).toBe(CLOSE.REPLACED);
    expect(relay.online().filter((fp) => fp === second.fp)).toHaveLength(1);
    second.close();
  });

  test("slug 冲突：第二把钥匙拿到带指纹后缀的 slug；同钥匙改 slug 释放旧的", async () => {
    const a = await TestClient.connect(url, key(8), { slug: "studio" });
    const b = await TestClient.connect(url, key(9), { slug: "studio" });
    expect(b.slug).toBe(`studio-${b.fp.replace(/-/g, "").slice(0, 4)}`);
    a.close();
    await a.closed;
    const a2 = await TestClient.connect(url, key(8), { slug: "studio-two" });
    expect(a2.slug).toBe("studio-two");
    expect(relay.directory.bySlug("studio")).toBeNull();
    a2.close();
    b.close();
  });

  test("二进制帧 → 4400；连续坏 JSON 三次 → 4400", async () => {
    const c = await TestClient.connect(url, key(10));
    c.sendRaw(new Uint8Array([1, 2, 3]));
    expect((await c.closed).code).toBe(CLOSE.PROTOCOL);
    const d = await TestClient.connect(url, key(10));
    d.sendRaw("{not json");
    d.sendRaw("[1]");
    d.sendRaw("42");
    expect((await d.closed).code).toBe(CLOSE.PROTOCOL);
  });

  test("ping → pong；心跳判死 4408", async () => {
    const c = await TestClient.connect(url, key(11));
    c.send({ t: "ping", ts: 123 });
    expect((await c.next((f) => f.t === "pong")).ts).toBe(123);
    expect((await c.closed).code).toBe(CLOSE.TIMEOUT); // idleTimeoutMs 内没有任何帧
  });
});

describe("联系人与在线状态", () => {
  test("peers 只对双向联系人给 online；单向 mutual:false", async () => {
    const A = await TestClient.connect(url, key(12), { slug: "a12" });
    const B = await TestClient.connect(url, key(13), { slug: "b13" });
    const oneWay = await A.contacts([B.fp]);
    expect(oneWay.peers).toEqual([expect.objectContaining({ fp: B.fp, slug: "b13", online: false, mutual: false })]);
    const back = await B.contacts([A.fp]);
    expect(back.peers).toEqual([expect.objectContaining({ fp: A.fp, online: true, mutual: true })]);
    // B 列出 A 的那一刻，A 收到 B 的 presence(online)
    const pres = await A.next((f) => f.t === "presence");
    expect(pres.peer).toMatchObject({ fp: B.fp, slug: "b13", online: true });
    B.close();
    const off = await A.next((f) => f.t === "presence" && (f.peer as { online: boolean }).online === false);
    expect((off.peer as { fp: string }).fp).toBe(B.fp);
    A.close();
  });

  test("不在目录里的指纹从 peers 里略过；contacts 超形状 → frame_invalid", async () => {
    const A = await TestClient.connect(url, key(14));
    const r = await A.contacts(["0000-0000-0000-0000"]);
    expect(r.peers).toEqual([]);
    A.send({ t: "contacts", fps: ["not-a-fp"] });
    expect((await A.next((f) => f.t === "error")).code).toBe("frame_invalid");
    A.close();
  });
});

describe("请求路由", () => {
  const req = (to: string, id: string, path = "/api/v1/agents", method = "GET", extra: Record<string, unknown> = {}) => ({
    t: "req", id, to, method, path, headers: { "x-test": "1" }, body: "", ...extra,
  });

  test("未被列为联系人 → peer_unknown；列了 → req 到达接收方并盖 from，res 回到发起方", async () => {
    const { A, B } = await pair(15, 16, { mutual: false });
    A.send(req(B.fp, "r1"));
    expect((await A.next((f) => f.t === "error")).code).toBe("peer_unknown");
    await B.contacts([A.fp]);
    A.send(req(B.fp, "r2", "/api/v1/agents?x=1", "POST", { body: Buffer.from("hi").toString("base64") }));
    const got = await B.next((f) => f.t === "req");
    expect(got).toMatchObject({ id: "r2", from: A.fp, method: "POST", path: "/api/v1/agents?x=1", headers: { "x-test": "1" } });
    expect(got.to).toBeUndefined();
    expect(got.timeoutMs).toBe(1000);
    B.send({ t: "res", id: "r2", to: A.fp, status: 201, headers: { "content-type": "text/plain" }, body: Buffer.from("ok").toString("base64") });
    const res = await A.next((f) => f.t === "res");
    expect(res).toMatchObject({ id: "r2", from: B.fp, status: 201, body: Buffer.from("ok").toString("base64") });
    A.close();
    B.close();
  });

  test("兑换邀请：陌生实例可以敲门，限流后 rate_limited；目标不在线一律 peer_unknown", async () => {
    const { A, B } = await pair(17, 18, { mutual: false });
    for (let i = 0; i < 2; i++) {
      A.send(req(B.fp, `k${i}`, REDEEM_PATH, "POST"));
      expect((await B.next((f) => f.t === "req")).id).toBe(`k${i}`);
    }
    A.send(req(B.fp, "k3", REDEEM_PATH, "POST"));
    expect((await A.next((f) => f.t === "error")).code).toBe("rate_limited");
    B.close();
    await B.closed;
    A.send(req(B.fp, "k4", REDEEM_PATH, "POST"));
    expect((await A.next((f) => f.t === "error" && f.id === "k4")).code).toBe("peer_unknown");
    A.close();
  });

  test("列了联系人但对方掉线 → peer_offline；duplicate_id", async () => {
    const { A, B } = await pair(19, 20);
    A.send(req(B.fp, "d1"));
    await B.next((f) => f.t === "req");
    A.send(req(B.fp, "d1"));
    expect((await A.next((f) => f.t === "error")).code).toBe("duplicate_id");
    // B 断线：在途的 d1 变 peer_disconnected；之后再发 → 对方不在线，但 B 的联系人清单随连接消失 → peer_unknown
    B.close();
    expect((await A.next((f) => f.t === "error" && f.id === "d1")).code).toBe("peer_disconnected");
    A.close();
  });

  test("超时：发起方收 timeout，接收方收 cancel；迟到的 res → unknown_request", async () => {
    const { A, B } = await pair(21, 22);
    A.send(req(B.fp, "t1"));
    await B.next((f) => f.t === "req");
    const alive = setInterval(() => {
      A.send({ t: "ping", ts: 0 });
      B.send({ t: "ping", ts: 0 });
    }, 300);
    expect((await A.next((f) => f.t === "error", 2500)).code).toBe("timeout");
    clearInterval(alive);
    expect((await B.next((f) => f.t === "cancel")).id).toBe("t1");
    B.send({ t: "res", id: "t1", to: A.fp, status: 200, headers: {}, body: "" });
    expect((await B.next((f) => f.t === "error")).code).toBe("unknown_request");
    A.close();
    B.close();
  });

  test("发起方 cancel → 接收方收 cancel 并结束 pending", async () => {
    const { A, B } = await pair(23, 24);
    A.send(req(B.fp, "c1"));
    await B.next((f) => f.t === "req");
    A.send({ t: "cancel", id: "c1", to: B.fp });
    expect((await B.next((f) => f.t === "cancel")).id).toBe("c1");
    B.send({ t: "res", id: "c1", to: A.fp, status: 200, headers: {}, body: "" });
    expect((await B.next((f) => f.t === "error")).code).toBe("unknown_request");
    A.close();
    B.close();
  });

  test("接收方 error（origin peer）转给发起方并补 from", async () => {
    const { A, B } = await pair(25, 26);
    A.send(req(B.fp, "e1"));
    await B.next((f) => f.t === "req");
    B.send({ t: "error", id: "e1", to: A.fp, code: "bad_signature", message: "nope" });
    expect(await A.next((f) => f.t === "error")).toMatchObject({ id: "e1", from: B.fp, code: "bad_signature", message: "nope", origin: "peer" });
    A.close();
    B.close();
  });

  test("流式：请求正文 data/end 顺序到达接收方；响应 more + data/end 顺序回到发起方", async () => {
    const { A, B } = await pair(27, 28);
    A.send(req(B.fp, "s1", "/api/v1/agents", "POST", { more: true }));
    A.send({ t: "data", id: "s1", to: B.fp, b64: Buffer.from("part1").toString("base64") });
    A.send({ t: "data", id: "s1", to: B.fp, b64: Buffer.from("part2").toString("base64") });
    A.send({ t: "end", id: "s1", to: B.fp });
    const head = await B.next((f) => f.t === "req");
    expect(head.more).toBe(true);
    const d1 = await B.next((f) => f.t === "data");
    const d2 = await B.next((f) => f.t === "data");
    const end = await B.next((f) => f.t === "end");
    expect([d1.b64, d2.b64].map((b) => Buffer.from(String(b), "base64").toString())).toEqual(["part1", "part2"]);
    expect(end.id).toBe("s1");
    B.send({ t: "res", id: "s1", to: A.fp, status: 200, headers: { "content-type": "text/event-stream" }, body: "", more: true });
    B.send({ t: "data", id: "s1", to: A.fp, b64: Buffer.from("event: a\n\n").toString("base64") });
    B.send({ t: "data", id: "s1", to: A.fp, b64: Buffer.from("event: b\n\n").toString("base64") });
    B.send({ t: "end", id: "s1", to: A.fp });
    expect((await A.next((f) => f.t === "res")).more).toBe(true);
    const r1 = await A.next((f) => f.t === "data");
    const r2 = await A.next((f) => f.t === "data");
    expect([r1.b64, r2.b64].map((b) => Buffer.from(String(b), "base64").toString())).toEqual(["event: a\n\n", "event: b\n\n"]);
    expect((await A.next((f) => f.t === "end")).id).toBe("s1");
    // 流已收尾，pending 结束：再发 data → unknown_request
    B.send({ t: "data", id: "s1", to: A.fp, b64: "" });
    expect((await B.next((f) => f.t === "error")).code).toBe("unknown_request");
    A.close();
    B.close();
  });

  test("流态空闲超时 → 发起方 stream_idle，接收方 cancel", async () => {
    const { A, B } = await pair(29, 30);
    A.send(req(B.fp, "i1"));
    await B.next((f) => f.t === "req");
    B.send({ t: "res", id: "i1", to: A.fp, status: 200, headers: {}, body: "", more: true });
    await A.next((f) => f.t === "res");
    expect((await A.next((f) => f.t === "error", 1500)).code).toBe("stream_idle");
    expect((await B.next((f) => f.t === "cancel")).id).toBe("i1");
    A.close();
    B.close();
  });

  test("req 没有 to / 路径不合法形状 → frame_invalid 带 id", async () => {
    const A = await TestClient.connect(url, key(31));
    A.send({ t: "req", id: "x1", method: "GET", path: "/api/v1/agents", headers: {} });
    expect(await A.next((f) => f.t === "error")).toMatchObject({ code: "frame_invalid", id: "x1" });
    A.send({ t: "nonsense", id: "x2" });
    expect(await A.next((f) => f.t === "error")).toMatchObject({ code: "frame_invalid", id: "x2" });
    A.close();
  });
});

describe("配对短码", () => {
  test("put 后目录能查到；del 删掉；第 6 个 → rate_limited", async () => {
    const A = await TestClient.connect(url, key(32), { slug: "codes" });
    const exp = Math.floor(Date.now() / 1000) + 300;
    const codes = ["AAAAAAA2", "AAAAAAA3", "AAAAAAA4", "AAAAAAA5", "AAAAAAA6"];
    for (const c of codes) A.send({ t: "code", op: "put", code: c, exp });
    A.send({ t: "ping", ts: 1 });
    await A.next((f) => f.t === "pong");
    expect(relay.directory.lookupCode("AAAAAAA2")?.slug).toBe("codes");
    A.send({ t: "code", op: "put", code: "AAAAAAA7", exp });
    expect((await A.next((f) => f.t === "error")).code).toBe("rate_limited");
    A.send({ t: "code", op: "del", code: "aaaa-aaa2" });
    A.send({ t: "ping", ts: 2 });
    await A.next((f) => f.t === "pong");
    expect(relay.directory.lookupCode("AAAAAAA2")).toBeNull();
    A.close();
  });
});
