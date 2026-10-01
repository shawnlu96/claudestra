/**
 * i28-Q1 hello 的可选 quota（src/lib/lend-hello.ts + lend-wire-v2.ts）：有授权才带、只有百分比和重置时刻（多一个键 A 就拒）、
 * 不进正文哈希、旧版 A 只因 quota 字段 400 时当场去掉重发并记「不收」（换 boot 或 6 小时后再试），别的失败不回退。
 * A 是假的，按旧版 / 新版两种解析器回（旧版 = 不认 quota 的 parseHello，就是去掉 quota 前的那份规则）。
 */
import { describe, expect, test } from "bun:test";
import { helloState } from "../src/lib/lend-hello.js";
import { parseV2Request, type HelloQuota } from "../src/lib/lend-wire-v2.js";
import { harness } from "./lend-harness.js";

const OK = { status: 200, body: { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 } };
const QUOTA: HelloQuota = { codex: { weekUsedPct: 37, resetAt: 9_000_000_000_000 } };
type Reply = { status: number; body: unknown };

/** 新版 A：整份过 parseV2Request；旧版 A：同一个解析器，但正文里有 quota 就按旧版原话拒 */
const newA = (b: Record<string, unknown>): Reply => {
  const p = parseV2Request("hello", { v: 1, ...b });
  return p.ok ? OK : { status: 400, body: { ok: false, code: "invalid", error: p.error } };
};
const oldA = (b: Record<string, unknown>): Reply =>
  "quota" in b ? { status: 400, body: { ok: false, code: "invalid", error: "$: 不认识的字段 quota" } } : newA(b);

function setup(opts: { quota?: () => Promise<HelloQuota>; boot?: string; entry?: Record<string, unknown> } = {}) {
  const h = harness(opts.entry ? { entry: opts.entry } : {});
  let answer = newA;
  const hellos: Record<string, unknown>[] = [];
  h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
  const port = (boot: string) => ({ boot, quota: opts.quota ?? (async () => QUOTA), call: async (_p: string, op: string, body: Record<string, unknown>) => {
    if (op === "hello") hellos.push(body);
    return op === "hello" ? answer(body) : { status: 200, body: { ok: true, v: 1, orders: [] } };
  } });
  h.d.v2 = port(opts.boot ?? "boot-aaaa-0001") as never;
  return { h, hellos, setA: (a: typeof newA) => void (answer = a), reboot: (boot: string) => void (h.d.v2 = port(boot) as never) };
}

describe("wire：quota 是可选字段，只认百分比 + 重置时刻", () => {
  const base = { v: 1, proto: 2, boot: "boot-aaaa-0001", seq: 1, grant: null, slots: { codex: { total: 0, busy: 0 }, claude: { total: 0, busy: 0 } }, paused: null };
  test("不带照旧；带两家或一家都收；空对象也收", () => {
    expect(parseV2Request("hello", base).ok).toBe(true);
    expect(parseV2Request("hello", { ...base, quota: QUOTA })).toMatchObject({ ok: true, value: { quota: QUOTA } });
    expect(parseV2Request("hello", { ...base, quota: { ...QUOTA, claude: { weekUsedPct: 0, resetAt: 1 } } }).ok).toBe(true);
    expect(parseV2Request("hello", { ...base, quota: {} }).ok).toBe(true);
  });
  test("token / 账号 / 会话 id 之类多一个键都拒；百分比越界、非整数、家族名不认也拒（验收线 3）", () => {
    const bad = [
      { ...QUOTA, token: "sk-x" }, { codex: { ...QUOTA.codex, account: "a@b" } }, { codex: { ...QUOTA.codex, sessionId: "s" } },
      { codex: { weekUsedPct: 101, resetAt: 1 } }, { codex: { weekUsedPct: 1.5, resetAt: 1 } }, { codex: { weekUsedPct: -1, resetAt: 1 } },
      { gemini: { weekUsedPct: 1, resetAt: 1 } }, { codex: { weekUsedPct: 1 } }, [], "37%",
    ];
    for (const q of bad) expect([q, parseV2Request("hello", { ...base, quota: q }).ok]).toEqual([q, false]);
  });
});

describe("出借方 hello 带 quota", () => {
  test("有授权：带上；没接额度读取 / 一家都读不到：不带", async () => {
    const s = setup();
    await s.h.tick();
    expect(s.hellos.at(-1)).toMatchObject({ quota: QUOTA });
    const none = setup({ quota: async () => ({}) });
    await none.h.tick();
    expect(none.hellos.at(-1)).not.toHaveProperty("quota");
  });

  test("读额度抛错：照常发 hello、不带 quota", async () => {
    const s = setup({ quota: async () => { throw new Error("rollout 坏了"); } });
    await s.h.tick();
    expect(s.hellos).toHaveLength(1);
    expect(s.hellos[0]).not.toHaveProperty("quota");
    expect(helloState(s.h.db, "team-a")!.ok).toBe(true);
  });

  test("额度里混进坏值（NaN 重置时刻）：hello 照发、去掉 quota，授权和容量不受拖累（验收线 2）", async () => {
    const s = setup({ quota: async () => ({ codex: { weekUsedPct: 20, resetAt: NaN } }) });
    await s.h.tick();
    expect(s.hellos).toHaveLength(1);
    expect(s.hellos[0]).not.toHaveProperty("quota");
    expect(s.hellos[0]!.grant).not.toBeNull();
    expect(helloState(s.h.db, "team-a")).toMatchObject({ ok: true, selfCheck: null, grant: true });
  });

  test("百分比变了不算正文变了：保活时间之前不多发", async () => {
    let pct = 10;
    const s = setup({ quota: async () => ({ codex: { weekUsedPct: pct, resetAt: 9_000_000_000_000 } }) });
    await s.h.tick();
    pct = 55;
    s.h.advanceTime(5_000);
    await s.h.tick();
    expect(s.hellos).toHaveLength(1);
    s.h.advanceTime(60_000);
    await s.h.tick();
    expect(s.hellos.at(-1)).toMatchObject({ quota: { codex: { weekUsedPct: 55 } } });
  });
});

describe("旧版 A 的回退", () => {
  test("只因 quota 被 400：当轮去掉重发（seq 更大）、hello 记成功；之后同一 boot 6 小时内不带", async () => {
    const s = setup();
    s.setA(oldA);
    await s.h.tick();
    expect(s.hellos).toHaveLength(2);
    expect(s.hellos[0]).toHaveProperty("quota");
    expect(s.hellos[1]).not.toHaveProperty("quota");
    expect(s.hellos[1]!.seq as number).toBeGreaterThan(s.hellos[0]!.seq as number);
    expect(helloState(s.h.db, "team-a")).toMatchObject({ ok: true, error: null });
    s.h.advanceTime(61_000);
    await s.h.tick();
    expect(s.hellos).toHaveLength(3);
    expect(s.hellos[2]).not.toHaveProperty("quota");
  });

  test("等旧版 A 回 400 期间授权被收回：重发前重新现读，第二次是 grant:null、0 槽，记成没授权", async () => {
    const s = setup();
    s.setA((b) => {
      if ("quota" in b) {
        s.h.lend.lend = []; // owner 在第一次请求还没回时收回
        return oldA(b);
      }
      return newA(b);
    });
    await s.h.tick();
    expect(s.hellos).toHaveLength(2);
    expect(s.hellos[0]!.grant).not.toBeNull();
    expect(s.hellos[1]).toMatchObject({ grant: null, slots: { codex: { total: 0 } } });
    expect(s.hellos[1]!.seq as number).toBeGreaterThan(s.hellos[0]!.seq as number);
    expect(helloState(s.h.db, "team-a")).toMatchObject({ ok: true, grant: false });
  });

  test("「不收」会过期：过 6 小时，或本机重启换了 boot，再带一次试试", async () => {
    const s = setup();
    s.setA(oldA);
    await s.h.tick();
    s.setA(newA); // 对方升级了
    s.h.advanceTime(6 * 3_600_000 + 1);
    await s.h.tick();
    expect(s.hellos.at(-1)).toHaveProperty("quota");

    const r = setup();
    r.setA(oldA);
    await r.h.tick();
    r.setA(newA);
    r.reboot("boot-bbbb-0002");
    await r.h.tick();
    expect(r.hellos.at(-1)).toHaveProperty("quota");
  });

  test("别的 400 / 别的错不回退：只发一次，按原来的失败处理，也不记「不收」", async () => {
    const s = setup();
    s.setA(() => ({ status: 400, body: { ok: false, code: "invalid", error: "slots.codex.total: 要是 0–100 的整数" } }));
    await s.h.tick();
    expect(s.hellos).toHaveLength(1);
    expect(helloState(s.h.db, "team-a")).toMatchObject({ ok: false });
    s.setA(newA);
    s.h.advanceTime(10_000);
    await s.h.tick();
    expect(s.hellos.at(-1)).toHaveProperty("quota");
  });
});
