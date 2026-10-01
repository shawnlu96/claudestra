/**
 * i28-W3 批量心跳 beat（src/lib/lend-beat.ts → lend-drive.ts heartbeat）：分批与 phase 映射、每一种 verdict、应答异常时一单不续、
 * 失败时截止不放宽（过了照常自停）、proto 2 下没有逐单 renew、invalid 置空摘要重发一次、摘要的脱敏 / 截断 / 控制字符。
 * 收回停单的 ended 在 tests/lend-beat-revoke.test.ts。A 与 worker 都是假的（tests/lend-harness.ts），时钟手拨。
 */
import { describe, expect, test } from "bun:test";
import { excerptOf, phaseOf } from "../src/lib/lend-beat.js";
import { workerName } from "../src/lib/lend-drive.js";
import { advance, getOrder, localDay, recordAsked, type LendRow } from "../src/lib/lend-journal.js";
import { payloadSha } from "../src/lib/lend-submit.js";
import { parseV2Request } from "../src/lib/lend-wire-v2.js";
import { FP, harness, polled, TEXT, wire } from "./lend-harness.js";

type Reply = { status: number; body: unknown } | "throw";
type Line = { orderId: string; gen: number; phase: string; excerpt: string };

/** v2 接上：hello 一律成功，beat 默认逐单 ok（同代、10 分钟）；latency = A 回应答前时钟走多久 */
function v2(h: ReturnType<typeof harness>) {
  const s = { latency: 0, beats: [] as Line[][], beat: (lines: Line[]): Reply => ({ status: 200, body: { ok: true, v: 1,
    orders: lines.map((o) => ({ orderId: o.orderId, verdict: "ok", lease: { gen: o.gen, expiresAt: 0, ms: 600_000 } })) } }) };
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
  h.d.v2 = { boot: "boot-beat-0001", excerpt: async () => ({ text: "跑测试中", at: 42 }), call: async (_p, op, body) => {
    if (op === "hello") return { status: 200, body: { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 } };
    const lines = body.orders as Line[];
    s.beats.push(lines);
    h.advanceTime(s.latency);
    const r = s.beat(lines);
    if (r === "throw") throw new Error("超时");
    return r;
  } };
  return s;
}

/** 直接在 journal 里造一张已起 worker 的单（state 可停在更早的阶段） */
function started(h: ReturnType<typeof harness>, id: string, upTo: "claimed" | "cloned" | "started" = "started"): LendRow {
  const now = h.d.now();
  recordAsked(h.db, { orderId: id, peer: "team-a", fp: FP, family: "codex", preview: { ...polled(id) } }, now);
  let row = advance(h.db, id, "asked", "claimed", { wire: { order: wire(id), text: TEXT }, day: localDay(now), leaseGen: 1, leaseUntil: now + 600_000, lastBeatAt: now }, now);
  if (upTo === "claimed") return row;
  row = advance(h.db, id, "claimed", "cloned", { dir: `/lend/work/${id}` }, now);
  if (upTo === "cloned") return row;
  const agent = workerName(id);
  h.registry.set(agent, { sessionId: `s-${id}`, cwd: `/lend/work/${id}` });
  return advance(h.db, id, "cloned", "started", { agent, sessionId: `s-${id}`, startedAt: now, submit: "sent", notices: { start: now } }, now);
}

const renewOps = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.op === "lease" && c.body.action === "renew").length;

describe("批量与 phase", () => {
  test("60 单 → 一批 50、一批 10；proto 2 下一次逐单 renew 都没有", async () => {
    const h = harness({ entry: { families: { codex: 16 }, ordersPerDay: 200 } });
    const s = v2(h);
    for (let i = 0; i < 60; i++) started(h, `o${i}`);
    await h.tick();
    expect(s.beats.map((b) => b.length)).toEqual([50, 10]);
    h.advanceTime(61_000);
    await h.tick();
    expect(renewOps(h)).toBe(0);
  });

  test("phase：claimed → cloning，cloned → starting，started → working，交了 work 没正文 → publishing，有正文 → result_pending", () => {
    const h = harness();
    expect(phaseOf(started(h, "a", "claimed"))).toBe("cloning");
    expect(phaseOf(started(h, "b", "cloned"))).toBe("starting");
    const c = started(h, "c");
    expect(phaseOf(c)).toBe("working");
    const work = { head: "f".repeat(40), summary: "s", selfCheck: "c" };
    expect(phaseOf({ ...c, state: "result_pending", work })).toBe("publishing");
    expect(phaseOf({ ...c, state: "result_pending", work, payload: { v: 1 } })).toBe("result_pending");
    expect(phaseOf({ ...c, state: "result_pending", payload: { v: 1 } })).toBe("result_pending");
  });

  test("还没起 worker 的单摘要是空串；起了的带摘要（端口给的原文过一遍处理）", async () => {
    const h = harness();
    const s = v2(h);
    started(h, "a", "cloned");
    started(h, "b");
    await h.tick();
    const byId = Object.fromEntries(s.beats[0].map((l) => [l.orderId, l]));
    expect(byId.a.excerpt).toBe("");
    expect(byId.b.excerpt).toBe("跑测试中");
  });
});

describe("逐个 verdict", () => {
  test("ok 同代：本地截止 = 收到应答的时刻 + ms（不是发出的时刻）", async () => {
    const h = harness();
    const s = v2(h);
    started(h, "o1");
    s.latency = 3_000;
    const t0 = h.d.now();
    await h.tick();
    expect(getOrder(h.db, "o1")!.leaseUntil).toBe(t0 + 3_000 + 600_000);
  });

  test("ok 但代数对不上 → 按 stale_gen：停 worker、记 stopped、不再通知 A", async () => {
    const h = harness();
    const s = v2(h);
    started(h, "o1");
    s.beat = (lines) => ({ status: 200, body: { ok: true, v: 1, orders: lines.map((o) => ({ orderId: o.orderId, verdict: "ok", lease: { gen: 7, expiresAt: 0, ms: 600_000 } })) } });
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("stale_gen") });
    expect(h.log.killed).toEqual([workerName("o1")]);
    expect(h.calls.filter((c) => c.op === "lease")).toEqual([]);
  });

  test("cancelled → cancelled；lease_expired / stale_gen / not_found → stopped；都停 worker、不发 v1 release", async () => {
    for (const [verdict, state] of [["cancelled", "cancelled"], ["lease_expired", "stopped"], ["stale_gen", "stopped"], ["not_found", "stopped"]] as const) {
      const h = harness();
      const s = v2(h);
      started(h, "o1");
      s.beat = (lines) => ({ status: 200, body: { ok: true, v: 1, orders: lines.map((o) => ({ orderId: o.orderId, verdict, lease: null })) } });
      await h.tick();
      expect([verdict, getOrder(h.db, "o1")!.state]).toEqual([verdict, state]);
      expect(h.log.killed).toEqual([workerName("o1")]);
      expect(h.calls.filter((c) => c.op === "lease")).toEqual([]);
    }
  });

  test("done：等回执的 result_pending 只停 worker、照常原字节转发取回执；其余记 stopped", async () => {
    const h = harness();
    const s = v2(h);
    started(h, "o1");
    started(h, "o2");
    const payload = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 } };
    advance(h.db, "o1", "started", "result_pending", { payload, payloadSha: payloadSha(JSON.stringify(payload)) });
    s.beat = (lines) => ({ status: 200, body: { ok: true, v: 1, orders: lines.map((o) => ({ orderId: o.orderId, verdict: "done", lease: null })) } });
    await h.tick();
    expect(getOrder(h.db, "o2")).toMatchObject({ state: "stopped", reason: expect.stringContaining("done") });
    expect(h.log.killed).toContain(workerName("o1"));
    expect(h.calls.filter((c) => c.op === "result").map((c) => c.body.orderId)).toEqual(["o1"]);
    expect(getOrder(h.db, "o1")!.state).toBe("acked"); // 回执照常取到
  });
});

describe("异常与失败：一单不续、截止不放宽", () => {
  const cases: [string, (lines: Line[]) => Reply][] = [
    ["没发过的单号", (l) => ({ status: 200, body: { ok: true, v: 1, orders: [...l, { orderId: "ghost", gen: 1 }].map((o) => ({ orderId: o.orderId, verdict: "ok", lease: { gen: 1, expiresAt: 0, ms: 600_000 } })) } })],
    ["重复单号", (l) => ({ status: 200, body: { ok: true, v: 1, orders: [...l, l[0]].map((o) => ({ orderId: o.orderId, verdict: "ok", lease: { gen: 1, expiresAt: 0, ms: 600_000 } })) } })],
    ["看不懂", () => ({ status: 200, body: { ok: true, v: 1, orders: [{ orderId: "o1", verdict: "great" }] } })],
    ["多字段", (l) => ({ status: 200, body: { ok: true, v: 1, extra: 1, orders: l.map((o) => ({ orderId: o.orderId, verdict: "ok", lease: null })) } })],
    ["超时", () => "throw"],
    ["500", () => ({ status: 500, body: { ok: false, code: "internal", error: "x" } })],
    ["401", () => ({ status: 401, body: { ok: false, code: "unauthorized", error: "x" } })],
  ];
  for (const [why, beat] of cases) {
    test(`${why}：两单都不续，截止不动；过了截止照常自停`, async () => {
      const h = harness();
      const s = v2(h);
      started(h, "o1");
      started(h, "o2");
      const before = [getOrder(h.db, "o1")!.leaseUntil, getOrder(h.db, "o2")!.leaseUntil];
      s.beat = beat;
      h.advanceTime(20_000);
      await h.tick();
      expect([getOrder(h.db, "o1")!.leaseUntil, getOrder(h.db, "o2")!.leaseUntil]).toEqual(before);
      expect(renewOps(h)).toBe(0);
      h.advanceTime(600_000);
      await h.tick();
      expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("心跳过期") });
    });
  }

  test("被 A 以 invalid 拒：摘要全部置空重发一次，续租照常", async () => {
    const h = harness();
    const s = v2(h);
    started(h, "o1");
    const ok = s.beat;
    s.beat = (lines) => (lines.some((l) => l.excerpt) ? { status: 400, body: { ok: false, code: "invalid", error: "摘要不合格" } } : ok(lines));
    const t0 = h.d.now();
    await h.tick();
    expect(s.beats.map((b) => b.map((l) => l.excerpt))).toEqual([["跑测试中"], [""]]);
    expect(getOrder(h.db, "o1")!.leaseUntil).toBe(t0 + 600_000);
  });
});

describe("摘要", () => {
  test("脱敏三类反例：家目录、token、内网地址都不出 B", () => {
    const out = excerptOf("读 /Users/alice/secret.txt；token ghp_abcdefghijklmnopqrstuvwxyz0123；连 192.168.1.20:8080 和 100.101.102.103");
    expect(out).not.toContain("alice");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(out).not.toContain("192.168.1.20");
    expect(out).not.toContain("100.101.102.103");
    expect(out).toContain("[已脱敏");
  });

  test("先脱敏后截断：token 跨在 1 KiB 截断线上也认得出来", () => {
    const token = "sk-" + "A1b2C3d4E5f6G7h8".repeat(4);
    const raw = `${token}${"x".repeat(1024 - 20)}`;
    expect(excerptOf(raw)).not.toMatch(/A1b2C3d4/);
  });

  test("5 KiB 输入 → 末尾 ≤1024 字节；多字节字符不切断；ANSI 与 \\r 等控制字符去掉，\\n / \\t 保留；整批过 A 的解析器", () => {
    const big = excerptOf(`${"字".repeat(2000)}结尾`);
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(1024);
    expect(big.endsWith("结尾")).toBe(true);
    expect(big).not.toContain("�");
    const ctl = excerptOf("\x1b[31m红\x1b[0m\r\n第二行\t制表\x07铃\u0000零\x1b]0;title\x07");
    expect(ctl).toBe("红\n第二行\t制表铃零");
    const line = { orderId: "o1", gen: 1, phase: "working", lastActivityAt: 1, excerpt: big };
    expect(parseV2Request("beat", { v: 1, orders: [line, { ...line, orderId: "o2", excerpt: ctl }] }).ok).toBe(true);
  });
});
