/**
 * i28-W3 出借方 hello（src/lib/lend-hello.ts，经 lend-loop.ts 每轮调）：正文构造与自检（W8 前没有 write、claude 0 槽、busy 含没领的单）、
 * 触发（启动第一轮、正文变了当轮发、保活、失败退避、收回立刻发 grant:null）、404 / 403 / 超时的回退与恢复、seq 跨重启只增、全部收回时 lendWanted。
 * A 是假的（hello / beat 按表回），时钟手拨（tests/lend-harness.ts）。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lendWanted } from "../src/lib/lend-deps.js";
import { helloBody, helloState, peerProto } from "../src/lib/lend-hello.js";
import { admitOrders, TICK_KEY } from "../src/lib/lend-inbox.js";
import { getMeta, openLendJournal, setMeta } from "../src/lib/lend-journal.js";
import { parseV2Request } from "../src/lib/lend-wire-v2.js";
import { FP, harness, polled } from "./lend-harness.js";

type Reply = { status: number; body: unknown } | "throw";
const OK_HELLO: Reply = { status: 200, body: { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 } };

/** 给 harness 接上 v2：hello / beat 的应答可改，发出去的正文都记下 */
function withV2(h: ReturnType<typeof harness>, boot = "boot-aaaa-0001") {
  const A2 = { hello: (_b: Record<string, unknown>): Reply => OK_HELLO, beat: (_b: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, v: 1, orders: [] } }) };
  const sent: { op: "hello" | "beat"; body: Record<string, unknown> }[] = [];
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
  h.d.v2 = { boot, call: async (_p, op, body) => {
    sent.push({ op, body });
    const r = A2[op](body);
    if (r === "throw") throw new Error("超时");
    return r;
  } };
  const hellos = () => sent.filter((s) => s.op === "hello").map((s) => s.body);
  return { A2, sent, hellos };
}

describe("正文", () => {
  test("有授权：until / roles / repos / 今日剩余，codex 总数 = 授权位数、busy 含已接下没领的单，claude 0 槽；整份过 A 的解析器", async () => {
    const h = harness();
    setMeta(h.db, TICK_KEY, String(h.d.now()));
    await admitOrders(h.d, { peer: "team-a", fp: FP }, [polled("o1")], "push");
    const b = helloBody(h.db, h.lend.lend[0], h.d.now());
    expect(b).toEqual({ proto: 2, paused: null, slots: { codex: { total: 2, busy: 1 }, claude: { total: 0, busy: 0 } },
      grant: { until: Date.parse(h.lend.lend[0].until!), roles: ["review"], repos: ["shawnlu96/claudestra"], ordersPerDay: 5, ordersLeftToday: 4 } });
    expect(parseV2Request("hello", { v: 1, ...b, boot: "boot-aaaa-0001", seq: 1 }).ok).toBe(true);
  });

  test("W8 前就算条目里写了 write，正文 roles 也不会有 write；没有授权 = grant:null、0 槽", () => {
    const h = harness();
    expect(helloBody(h.db, { ...h.lend.lend[0], roles: ["review", "write"] }, h.d.now()).grant!.roles).toEqual(["review"]);
    expect(helloBody(h.db, undefined, h.d.now())).toMatchObject({ grant: null, slots: { codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } } });
  });

  test("自检过不了（仓库名 A 不收）就不发，原因记给 doctor", async () => {
    const h = harness({ entry: { repos: ["o/."] } });
    const v = withV2(h);
    await h.tick();
    expect(v.hellos()).toEqual([]);
    expect(helloState(h.db, "team-a")!.selfCheck).toContain("grant.repos[0]");
    expect(JSON.parse(getMeta(h.db, "status")!).peers["team-a"].selfCheck).toContain("grant.repos[0]");
  });
});

describe("什么时候发", () => {
  test("启动第一轮就发；不到保活时间不再发；到了（helloMs 夹在 30–120 秒）再发；正文变了当轮就发", async () => {
    const h = harness();
    const v = withV2(h);
    await h.tick();
    expect(v.hellos()).toHaveLength(1);
    h.advanceTime(5_000);
    await h.tick();
    expect(v.hellos()).toHaveLength(1);
    h.advanceTime(55_000);
    await h.tick();
    expect(v.hellos()).toHaveLength(2);
    setMeta(h.db, TICK_KEY, String(h.d.now()));
    await admitOrders(h.d, { peer: "team-a", fp: FP }, [polled("o9")], "push"); // busy 变了
    h.advanceTime(1_000);
    await h.tick();
    expect(v.hellos()).toHaveLength(3);
    expect((v.hellos()[2].slots as { codex: { busy: number } }).codex.busy).toBe(1);
  });

  test("收回：当轮（不等保活）发 grant:null；A 收到之后不再给它发；正文从不带 write", async () => {
    const h = harness();
    const v = withV2(h);
    await h.tick();
    h.advanceTime(1_000);
    h.lend.lend = [];
    await h.tick();
    expect(v.hellos().map((b) => b.grant === null)).toEqual([false, true]);
    h.advanceTime(200_000);
    await h.tick();
    expect(v.hellos()).toHaveLength(2);
  });

  test("失败退避：第一次下个 pass 就重试，之后 5 / 15 / 30 / 60 秒；授权变了不等退避", async () => {
    const h = harness();
    const v = withV2(h);
    v.A2.hello = () => "throw";
    const at: number[] = [];
    for (let i = 0; i < 40; i++) {
      const before = v.hellos().length;
      await h.tick();
      if (v.hellos().length > before) at.push(h.d.now());
      h.advanceTime(5_000);
    }
    expect(at.slice(1, 7).map((t, i) => t - at[i])).toEqual([5_000, 5_000, 15_000, 30_000, 60_000, 60_000]);
    h.lend.lend[0].ordersPerDay = 4; // 授权变了
    const n = v.hellos().length;
    await h.tick();
    expect(v.hellos().length).toBe(n + 1);
  });
});

describe("回退与恢复", () => {
  test("A 回 404（旧版）：记 proto 1，退回 30 秒轮询和逐单续租；之后 A 升级了，hello 一成功就回到 proto 2、续租只走 beat", async () => {
    const h = harness();
    const v = withV2(h);
    v.A2.hello = () => ({ status: 404, body: null });
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [polled("o1")], pollAfterMs: 30_000 } });
    for (let i = 0; i < 5; i++) await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(1);
    h.advanceTime(61_000);
    await h.tick();
    expect(h.ops().filter((o) => o === "poll").length).toBeGreaterThanOrEqual(2);
    expect(h.ops()).toContain("lease"); // 逐单续租
    v.A2.hello = () => OK_HELLO;
    v.A2.beat = (b) => ({ status: 200, body: { ok: true, v: 1, orders: (b.orders as { orderId: string; gen: number }[]).map((o) => ({ orderId: o.orderId,
      verdict: "ok", lease: { gen: o.gen, expiresAt: 0, ms: 600_000 } })) } });
    h.advanceTime(61_000);
    const leasesBefore = h.ops().filter((o) => o === "lease").length;
    await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(2);
    h.advanceTime(61_000);
    await h.tick();
    expect(h.ops().filter((o) => o === "lease").length).toBe(leasesBefore);
    expect(v.sent.some((s) => s.op === "beat")).toBe(true);
  });

  test("回 403 messages_only / 超时：这一轮按 proto 1（立刻 poll、逐单续租）；超时的那个 peer 本轮别的出站全跳过", async () => {
    const h = harness();
    const v = withV2(h);
    await h.tick();
    expect(peerProto(h.db, "team-a")).toBe(2);
    const polls = () => h.ops().filter((o) => o === "poll").length;
    const p0 = polls();
    v.A2.hello = () => ({ status: 403, body: { ok: false, code: "messages_only", error: "只能投递消息" } });
    h.advanceTime(61_000);
    await h.tick();
    expect(polls()).toBe(p0 + 1);
    v.A2.hello = () => "throw";
    h.advanceTime(61_000);
    const before = h.calls.length;
    await h.tick();
    expect(h.calls.length).toBe(before); // 超时之后本轮对它一个 v1 请求都不发
  });
});

describe("seq 与 boot", () => {
  test("seq 存 journal：换 boot（调度服务重启）也只增不减；新 boot 第一轮立刻发", async () => {
    const h = harness();
    const v = withV2(h, "boot-aaaa-0001");
    await h.tick();
    h.advanceTime(1_000);
    h.lend.lend[0].ordersPerDay = 4;
    await h.tick();
    const w = withV2(h, "boot-bbbb-0002");
    h.advanceTime(1_000);
    await h.tick();
    const all = [...v.hellos(), ...w.hellos()];
    expect(all.map((b) => b.boot)).toEqual(["boot-aaaa-0001", "boot-aaaa-0001", "boot-bbbb-0002"]);
    expect(all.map((b) => b.seq)).toEqual([1, 2, 3]);
  });
});

describe("全部收回时 lendWanted", () => {
  const dir = mkdtempSync(join(tmpdir(), "lend-hello-wanted-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("总开关关、lend[] 空、没有活单：欠着 grant:null 的 peer 还在 180 秒内 → 仍要跑；说完或过了 180 秒 → 不跑", async () => {
    const lendPath = join(dir, "lend.json");
    const journal = join(dir, "journal.sqlite");
    writeFileSync(lendPath, JSON.stringify({ version: 2, enabled: false, lend: [], borrow: [] }));
    const db = openLendJournal(journal);
    const st = (grant: boolean, okAt: number) => JSON.stringify({ boot: "b", at: okAt, hash: "h", ok: true, okAt, grant, error: null, selfCheck: null, tries: 0,
      nextAt: 0, helloMs: 60_000, beatMs: 15_000 });
    setMeta(db, "hello:team-a", st(true, Date.now()));
    expect(await lendWanted(journal, lendPath)).toBe(true);
    setMeta(db, "hello:team-a", st(false, Date.now()));
    expect(await lendWanted(journal, lendPath)).toBe(false);
    setMeta(db, "hello:team-a", st(true, Date.now() - 181_000));
    expect(await lendWanted(journal, lendPath)).toBe(false);
    db.close();
  });

  test("一轮里：收回后整个出借关掉、没有活单，hello 照样把 grant:null 发出去", async () => {
    const h = harness();
    const v = withV2(h);
    await h.tick();
    h.lend.enabled = false;
    h.lend.lend = [];
    h.advanceTime(1_000);
    await h.tick();
    expect(v.hellos().at(-1)!.grant).toBeNull();
    expect(helloState(h.db, "team-a")!.grant).toBe(false);
  });
});

describe("doctor 的出借循环一行", () => {
  const dir = mkdtempSync(join(tmpdir(), "lend-hello-doctor-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("每个 peer 带协议 / hello / beat / 推送 / 轮询节奏；hello 自检没过、收到推送却没有同名授权列进 warn", async () => {
    const { checkLendLoop } = await import("../src/lib/doctor-lend.js");
    const lendPath = join(dir, "lend.json");
    const journal = join(dir, "journal.sqlite");
    const h = harness({ entry: { repos: ["o/."] } });
    withV2(h);
    await h.tick();
    writeFileSync(lendPath, JSON.stringify(h.lend));
    const db = openLendJournal(journal);
    setMeta(db, "status", getMeta(h.db, "status")!);
    setMeta(db, "pushAt:team-z", String(Date.now()));
    db.close();
    const [c] = await checkLendLoop(lendPath, journal, JSON.parse(getMeta(h.db, "status")!).at + 1000);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("协议 未协商");
    expect(c.detail).toContain("轮询每 30 秒");
    expect(c.detail).toContain("hello 自检没过");
    expect(c.detail).toContain("收到 team-z 的推送，但 lend.json 里没有叫这个名字的授权");
  });
});
