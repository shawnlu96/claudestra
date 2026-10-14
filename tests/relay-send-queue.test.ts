/**
 * 中继上行发送队列（src/lib/relay-send-queue.ts）：控制帧插队、正文分道交错、按探针确认放行窗口、取消丢弃、不丢不乱序。
 * 单测直接驱动队列；后两组接上 InboundRouter / 真客户端 + 假中继，测 1MB 在途时 5KB 响应与 pong 不排在它后面。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { keyFingerprint } from "../src/lib/relay-protocol.js";
import { InboundRouter } from "../src/lib/relay-client-inbound.js";
import { b64 } from "../src/lib/relay-stream.js";
import { RelaySendQueue, type SendQueueOptions } from "../src/lib/relay-send-queue.js";
import { connect, type InboundHandler, type RelayClient } from "../src/lib/relay-client.js";
import { startFakeRelay, type FakeRelay } from "./relay-fake-relay.js";

type F = Record<string, unknown> & { t: string };
const OPTS: SendQueueOptions = { minWindowBytes: 128 * 1024, maxWindowBytes: 128 * 1024, targetMs: 400 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 不可压的 1MB（伪随机字节），压缩不会替它缩水，交错效果只能来自调度 */
const noise = (n: number) => { let x = 7; return new Uint8Array(n).map(() => (x = (x * 1103515245 + 12345) & 0x7fffffff) & 0xff); };

/** 记录写出的帧；autoAck = 每个 ping 写出后下一个宏任务回 pong（模拟中继按序确认） */
function rig(opts = OPTS, autoAck = true) {
  const wire: F[] = [];
  const q: RelaySendQueue = new RelaySendQueue((raw) => {
    const f = JSON.parse(raw) as F;
    wire.push(f);
    if (autoAck && f.t === "ping") setTimeout(() => q.onPong(f.ts), 0);
    return true;
  }, opts);
  return { q, wire };
}

const dataFrames = (n: number, id: string) => Array.from({ length: n }, (_, i) => ({ t: "data", id, b64: b64.enc(noise(64 * 1024).map((v) => (v + i) & 0xff)) }));

describe("RelaySendQueue", () => {
  test("控制帧直写：窗口满、正文排着 1MB 时 pong 仍是下一帧，前面未确认的字节不超过窗口 + 一帧", () => {
    const { q, wire } = rig(OPTS, false);
    q.reply({ t: "res", id: "big", status: 200, headers: {}, more: true });
    for (const f of dataFrames(16, "big")) q.reply(f);
    expect(q.queued).toBeGreaterThan(10); // 没有确认：大部分正文还在队列里，没灌进 ws
    const before = wire.length;
    const ahead = wire.reduce((n, f) => n + JSON.stringify(f).length, 0);
    q.send({ t: "pong", ts: 1 });
    expect(wire.length).toBe(before + 1);
    expect(wire.at(-1)).toEqual({ t: "pong", ts: 1 });
    expect(ahead).toBeLessThan(OPTS.maxWindowBytes + 90 * 1024);
  });

  test("交错：1MB 在途时后到的 5KB 响应首帧只等一个数据块，且早于大响应发完", async () => {
    const { q, wire } = rig();
    q.reply({ t: "res", id: "big", status: 200, headers: {}, more: true });
    for (const f of dataFrames(16, "big")) q.reply(f);
    q.reply({ t: "end", id: "big" });
    const writtenAtArrival = wire.filter((f) => f.id === "big").length;
    q.reply({ t: "res", id: "small", status: 200, headers: {}, body: b64.enc(noise(5 * 1024)), more: false });
    while (q.queued) await sleep(1);
    const smallAt = wire.findIndex((f) => f.id === "small");
    const bigBeforeSmall = wire.slice(0, smallAt).filter((f) => f.id === "big").length;
    expect(bigBeforeSmall - writtenAtArrival).toBeLessThanOrEqual(1);
    expect(smallAt).toBeLessThan(wire.findIndex((f) => f.t === "end"));
  });

  test("不丢不乱序：两道交错后各自按入队顺序到达，探针 ts 单调递增", async () => {
    const { q, wire } = rig();
    const a = dataFrames(6, "a");
    const b = dataFrames(6, "b");
    for (let i = 0; i < 6; i++) {
      q.reply(a[i]);
      q.reply(b[i]);
    }
    while (q.queued) await sleep(1);
    expect(wire.filter((f) => f.id === "a").map((f) => f.b64)).toEqual(a.map((f) => f.b64));
    expect(wire.filter((f) => f.id === "b").map((f) => f.b64)).toEqual(b.map((f) => f.b64));
    const ts = wire.filter((f) => f.t === "ping").map((f) => f.ts as number);
    expect(ts.length).toBeGreaterThan(2);
    expect(ts.every((v, i) => i === 0 || v > ts[i - 1])).toBe(true);
  });

  test("取消：cancel 帧丢掉本道排着的正文并插队直写；drop 同理；其它道照常", async () => {
    const { q, wire } = rig(OPTS, false);
    for (const f of dataFrames(8, "x")) q.reply(f);
    for (const f of dataFrames(8, "y")) q.reply({ ...f, to: "peer-fp" });
    q.reply({ t: "cancel", id: "x" });
    expect(wire.at(-1)).toEqual({ t: "cancel", id: "x" });
    q.drop("peer-fp", "y");
    expect(q.queued).toBe(0);
    const n = wire.length;
    for (const f of wire.filter((w) => w.t === "ping")) q.onPong(f.ts);
    await sleep(1);
    expect(wire.length).toBe(n); // 确认放开窗口后也不会再冒出被取消的帧
  });

  test("本机发出的请求帧（send）不排队：窗口满时照样直写，回帖照旧排着", () => {
    const { q, wire } = rig(OPTS, false);
    for (const f of dataFrames(8, "resp")) q.reply(f);
    const n = wire.length;
    q.send({ t: "req", id: "mine", to: "peer-fp", method: "GET", path: "/api/v1/agents", headers: {}, more: false });
    expect(wire.length).toBe(n + 1);
    expect(wire.at(-1)).toMatchObject({ t: "req", id: "mine" });
    expect(q.queued).toBeGreaterThan(0);
  });

  test("窗口被大控制帧占满、没有在途探针时补发探针，确认后正文继续走", async () => {
    const { q, wire } = rig({ minWindowBytes: 4096, maxWindowBytes: 4096, targetMs: 400 });
    q.send({ t: "contacts", fps: ["x".repeat(8000)] });
    q.reply({ t: "data", id: "z", b64: "AAAA" });
    await sleep(5);
    expect(q.queued).toBe(0);
    expect(wire.some((f) => f.id === "z")).toBe(true);
  });

  test("窗口自调：慢链路收敛到下限，快链路涨到上限（送达速率 × targetMs）", () => {
    const run = (bytesPerMs: number) => {
      let clock = 0;
      let total = 0;
      const pings: { ts: number; upTo: number }[] = [];
      const q = new RelaySendQueue((raw) => {
        total += raw.length;
        const f = JSON.parse(raw) as F;
        if (f.t === "ping") pings.push({ ts: f.ts as number, upTo: total });
        return true;
      }, { minWindowBytes: 32 * 1024, maxWindowBytes: 2 * 1024 * 1024, targetMs: 400 }, () => clock);
      for (const f of dataFrames(60, "w")) q.reply(f);
      while (q.queued && pings.length) {
        const p = pings.shift()!;
        clock = Math.max(clock, p.upTo / bytesPerMs); // 链路按这个速率依次送达：探针到中继的时刻
        q.onPong(p.ts);
      }
      return { win: q.window };
    };
    expect(run(32).win).toBe(32 * 1024); // 32 KB/s：0.4 s 只有 13 KB，夹到下限
    expect(run(100_000).win).toBe(2 * 1024 * 1024); // 100 MB/s：涨到上限
  });

  test("近来发得多的道让路：老 SSE 早先发过更多，5 秒后来一条事件仍插在正在灌的大列表前面", () => {
    let clock = 0;
    const wire: F[] = [];
    const q = new RelaySendQueue((raw) => (wire.push(JSON.parse(raw) as F), true), { minWindowBytes: 200 * 1024, maxWindowBytes: 200 * 1024, targetMs: 400 }, () => clock);
    for (const f of dataFrames(2, "sse")) q.reply(f); // 两帧 ~174 KB 立刻写出，sse 道记账 174 KB（道空了记账仍留着）
    clock = 5000; // 5 个半衰期后只剩 1/32
    for (const f of dataFrames(6, "list")) q.reply(f); // 窗口只够再写一帧：list 记账 87 KB，其余排着
    q.reply({ t: "data", id: "sse", b64: "ZXZlbnQ=" });
    const pings = wire.filter((f) => f.t === "ping").map((f) => f.ts as number);
    wire.length = 0;
    for (const ts of pings) q.onPong(ts);
    expect(wire.find((f) => f.t === "data")).toMatchObject({ id: "sse", b64: "ZXZlbnQ=" }); // 不衰减的话 174 KB > 87 KB，会是 list 先走
  });

  test("响应发完（end 或内联 res）就清掉这道的记账，不随请求数增长", () => {
    const { q } = rig(OPTS, false);
    for (let i = 0; i < 50; i++) q.reply({ t: "res", id: `s${i}`, status: 200, headers: {}, body: "e30=", more: false });
    q.reply({ t: "res", id: "long", status: 200, headers: {}, more: true });
    q.reply({ t: "data", id: "long", b64: "AAAA" });
    expect((q as unknown as { served: Map<string, unknown> }).served.size).toBe(1);
    q.reply({ t: "end", id: "long" });
    expect((q as unknown as { served: Map<string, unknown> }).served.size).toBe(0);
  });

  test("reset 清空排队与探针记账", () => {
    const { q } = rig(OPTS, false);
    for (const f of dataFrames(8, "r")) q.reply(f);
    q.reset();
    expect(q.queued).toBe(0);
  });
});

describe("InboundRouter + 队列", () => {
  test("1MB 与 5KB 两个入站响应同时在途：5KB 的回帖早于 1MB 的 end，正文逐字节不变", async () => {
    const big = noise(1024 * 1024);
    const small = noise(5 * 1024);
    const { q, wire } = rig();
    const handler: InboundHandler = async (req) => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: req.path === "/big" ? big : small });
    const r = new InboundRouter((f) => q.reply(f as F), handler, () => {});
    r.onReq({ t: "req", id: "big", method: "GET", path: "/big", headers: {}, more: false });
    r.onReq({ t: "req", id: "small", method: "GET", path: "/small", headers: {}, more: false });
    while (r.size || q.queued) await sleep(1);
    const smallAt = wire.findIndex((f) => f.id === "small");
    const bigEnd = wire.findIndex((f) => f.id === "big" && f.t === "end");
    expect(smallAt).toBeGreaterThan(-1);
    expect(smallAt).toBeLessThan(bigEnd);
    expect(Buffer.from(b64.dec(wire[smallAt].body as string)).equals(Buffer.from(small))).toBe(true);
    const got = Buffer.concat(wire.filter((f) => f.id === "big" && f.t === "data").map((f) => b64.dec(f.b64 as string)));
    expect(got.equals(Buffer.from(big))).toBe(true);
  });
});

describe("真客户端 + 假中继", () => {
  const opened: Array<RelayClient | FakeRelay> = [];
  afterAll(() => {
    for (const x of opened) ("stop" in x ? x.stop() : x.close());
  });
  const start = (relayOpts: Parameters<typeof startFakeRelay>[0], handler: InboundHandler) => {
    const relay = startFakeRelay(relayOpts);
    const key = instanceKeySync(mkdtempSync(join(tmpdir(), "relay-sq-")))!;
    // 回环上确认极快，自适应窗口会一路长到上限：固定成 64 KB，断言才不随机器快慢抖
    const c = connect({ relayUrl: relay.url, key, name: "Q", slug: "q", onInbound: handler, log: () => {}, sendQueue: { minWindowBytes: 64 * 1024, maxWindowBytes: 64 * 1024, targetMs: 400 } });
    opened.push(relay, c);
    return { relay, c, fp: keyFingerprint(key.publicKey) };
  };
  const bigHandler: InboundHandler = async () => ({ status: 200, headers: { "content-type": "application/octet-stream" }, body: noise(1024 * 1024) });

  test("1MB 正文在途时中继发 ping：pong 前面最多压一个窗口，远早于正文发完", async () => {
    const { relay, c, fp } = start({ pongDelayMs: 50 }, bigHandler);
    await relay.waitOnline(fp);
    while (c.state !== "online") await sleep(5);
    relay.sendTo(fp, { t: "req", id: "big1", from: "relay", method: "GET", path: "/big", headers: {}, more: false });
    await relay.waitFor((r) => r.frame.t === "data" && r.frame.id === "big1");
    relay.sendTo(fp, { t: "ping", ts: 4242 });
    const pong = await relay.waitFor((r) => r.frame.t === "pong" && r.frame.ts === 4242);
    const at = relay.received.indexOf(pong);
    const dataBefore = relay.received.slice(0, at).filter((r) => r.frame.id === "big1" && r.frame.t === "data").length;
    expect(dataBefore).toBeLessThanOrEqual(12); // 64 块（16 KB 一块）里最多一个窗口（≈3 块）+ 中继回 ping 前已在路上的
    await relay.waitFor((r) => r.frame.t === "end" && r.frame.id === "big1", 10_000);
  });

  test("中继 cancel 后这条响应排着的正文不再上行", async () => {
    const { relay, c, fp } = start({ pongDelayMs: 100 }, bigHandler);
    await relay.waitOnline(fp);
    while (c.state !== "online") await sleep(5);
    relay.sendTo(fp, { t: "req", id: "big2", from: "relay", method: "GET", path: "/big", headers: {}, more: false });
    await relay.waitFor((r) => r.frame.t === "data" && r.frame.id === "big2");
    relay.sendTo(fp, { t: "cancel", id: "big2", from: "relay" });
    await sleep(50);
    const n = relay.received.filter((r) => r.frame.id === "big2").length;
    await sleep(500);
    expect(relay.received.filter((r) => r.frame.id === "big2").length).toBe(n);
    expect(n).toBeLessThan(30);
    expect(relay.received.some((r) => r.frame.id === "big2" && r.frame.t === "end")).toBe(false);
  });
});
