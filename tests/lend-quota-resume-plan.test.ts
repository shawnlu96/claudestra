/** 额度停止恢复：合成事实 + 临时 SQLite 里的旧单，边界红绿；不碰生产 state、不联网 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { getLendOrder } from "../src/lib/ledger-lend.ts";
import { LEND_SCHEMA } from "../src/lib/ledger-lend-schema.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAUSE_FALLBACK_MS } from "../src/lib/lend-health.ts";
import type { HelloQuota } from "../src/lib/lend-wire-v2.ts";
import { verifyQuotaStop, type OrderSnap, type QuotaStopFact, type VerifiedQuotaStop } from "../src/lib/lend-quota-resume-facts.ts";
import { planQuotaResume, resumeKey, type ResumeInput, type ResumePlan } from "../src/lib/lend-quota-resume-plan.ts";

const T0 = Date.UTC(2026, 9, 5, 9, 0);
const RESET = Date.UTC(2026, 9, 5, 10, 50);
const PEER = "peer:B";
/** 新 hello 里停止家族明确有余量的读数 */
const OKQ = { claude: { weekUsedPct: 10, resetAt: RESET + 7 * 86_400_000 } };
const ORDER = "lend:demo:s1:r0:a1";

function orderDb(over: Record<string, unknown> = {}): Database {
  const db = new Database(":memory:");
  LEND_SCHEMA(db);
  const row: Record<string, unknown> = {
    orderId: ORDER, taskId: "demo", project: "p", peer: PEER, family: "claude", step: "write", specRev: 1, round: 0, head: "a".repeat(40),
    repo: "o/r", pr: null, wire: "{}", text: "", sha256: "x", status: "unknown", worker: "w1", leaseGen: 1, leaseMs: 60_000, leaseUntil: null,
    resultSha: null, receipt: null, eventSeq: null, reason: "stopped：撞额度", supersedes: null, createdBy: "pm", createdAt: T0 - 60_000,
    updatedAt: T0, branch: "lend/demo-b1a2", base: "a".repeat(40), seenAt: null, ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO lend_orders (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(row) as never[]));
  return db;
}

const snap = (db: Database): OrderSnap => getLendOrder(db, ORDER) as OrderSnap;

const fact = (over: Partial<QuotaStopFact> = {}): QuotaStopFact => ({
  source: { kind: "lease_release", ref: "ev#7", peer: PEER, authenticated: true }, orderId: ORDER, peer: PEER, gen: 1, family: "claude",
  observedAt: T0, cause: "quota", stopped: true, resultCommitted: false, resultPending: false, sideEffects: "none", resetAt: RESET, ...over,
});

const grant = (over: Record<string, unknown> = {}) => ({ until: RESET + 86_400_000, roles: ["review", "write"] as ("review" | "write")[],
  repos: ["o/r"], ordersPerDay: 10, ordersLeftToday: 5, ...over });

function input(stop: ResumeInput["stop"], order: OrderSnap, at: number, over: Partial<ResumeInput> = {}): ResumeInput {
  return {
    stop, order, task: { head: order.head, specRev: order.specRev, round: order.round },
    worker: { value: "stopped", source: "beat#9", observedAt: at - 1_000 },
    pendingResult: { value: false, source: "beat#9", observedAt: at - 1_000 },
    settlement: { value: { orderId: ORDER, gen: 1, settled: true }, source: "receipt#3", observedAt: at - 1_000 },
    hello: { value: { grant: grant(), paused: null, quota: OKQ }, source: "hello#42", observedAt: at - 1_000 },
    writeLease: { peer: PEER, state: "held" }, consumed: new Set(), ...over,
  };
}

function verified(facts: QuotaStopFact[], db = orderDb(), now = T0 + 1_000): VerifiedQuotaStop {
  const v = verifyQuotaStop(facts, snap(db), now);
  if (v.kind !== "verified") throw new Error(`expected verified, got ${v.kind}: ${v.why}`);
  return v.stop;
}
const kindOf = (p: ResumePlan): string => p.kind;

describe("verifyQuotaStop：只认认证来源的精确额度停止", () => {
  test("认证、同 peer/order/gen、已停、无结果 → verified，截止取事实里的 reset", () => {
    const s = verified([fact()]);
    expect([s.deadline, s.deadlineFrom, s.evidence]).toEqual([RESET, "reset", ["lease_release:ev#7@" + T0]]);
  });

  test("A 侧 resultSha 为空 + reason 写着额度，但没有结构化事实 → wait，不推断", () => {
    const v = verifyQuotaStop([], snap(orderDb({ reason: "stopped：worker 撞了额度" })), T0);
    expect(v.kind).toBe("wait");
  });

  test("未认证 / 别的 peer 冒报 → 不参与，等认证事实", () => {
    const db = orderDb();
    expect(verifyQuotaStop([fact({ source: { kind: "beat", ref: "x", peer: PEER, authenticated: false } })], snap(db), T0).kind).toBe("wait");
    expect(verifyQuotaStop([fact({ source: { kind: "beat", ref: "x", peer: "peer:C", authenticated: true } })], snap(db), T0).kind).toBe("wait");
  });

  test("只有别的租约代的事实 → manual（gen 不同）", () => {
    const v = verifyQuotaStop([fact({ gen: 2 })], snap(orderDb()), T0);
    expect(v.kind).toBe("manual");
  });

  test("auth / 内容拒绝 / 普通 error / 未知原因 / 副作用不明 → manual 且不可恢复（不换家族绕开）", () => {
    for (const over of [{ cause: "auth" }, { cause: "provider_refusal" }, { cause: "error" }, { cause: "unknown" }, { sideEffects: "unknown" },
      { sideEffects: null }] as Partial<QuotaStopFact>[]) {
      const v = verifyQuotaStop([fact(over)], snap(orderDb()), T0);
      expect(v.kind === "manual" && !v.recoverable).toBe(true);
    }
  });

  test("已提交 / 待转交结果 → 结果优先，不可恢复；不知道 → wait", () => {
    for (const over of [{ resultCommitted: true }, { resultPending: true }] as Partial<QuotaStopFact>[]) {
      const v = verifyQuotaStop([fact(over)], snap(orderDb()), T0);
      expect(v.kind === "manual" && !v.recoverable).toBe(true);
    }
    expect(verifyQuotaStop([fact({ resultPending: null })], snap(orderDb()), T0).kind).toBe("wait");
    expect(verifyQuotaStop([fact({ stopped: null })], snap(orderDb()), T0).kind).toBe("wait");
    expect(verifyQuotaStop([fact({ stopped: false })], snap(orderDb()), T0).kind).toBe("wait");
  });

  test("晚到结果已入账（resultSha / done）→ manual，原证据带回", () => {
    const v = verifyQuotaStop([fact()], snap(orderDb({ status: "done", resultSha: "r".repeat(64) })), T0);
    expect(v.kind === "manual" && v.evidence.length === 1 && !v.recoverable).toBe(true);
  });

  test("矛盾 / 缺观察时刻 / 观察时刻在未来 → manual", () => {
    const db = orderDb();
    expect(verifyQuotaStop([fact(), fact({ resetAt: RESET + 1 })], snap(db), T0).kind).toBe("manual");
    expect(verifyQuotaStop([fact({ observedAt: null })], snap(db), T0).kind).toBe("manual");
    expect(verifyQuotaStop([fact({ observedAt: T0 + 5 })], snap(db), T0).kind).toBe("manual");
  });

  test("认证停止事实来源引用空白 → manual，不出不可追溯的 verified", () => {
    for (const ref of ["", "  "]) {
      const v = verifyQuotaStop([fact({ source: { kind: "lease_release", ref, peer: PEER, authenticated: true } })], snap(orderDb()), T0 + 1_000);
      expect(v.kind).toBe("manual");
    }
  });

  test("原 reset 早于观察时刻（晚看到）→ 原样保留，已到期；非有限 reset → manual，不静默兜底", () => {
    const s = verified([fact({ resetAt: 1_060_000, observedAt: 1_060_100 })], orderDb(), 1_061_000);
    expect([s.deadline, s.deadlineFrom]).toEqual([1_060_000, "reset"]);
    for (const resetAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(verifyQuotaStop([fact({ resetAt })], snap(orderDb()), T0 + 1_000).kind).toBe("manual");
    }
  });

  test("没 reset → 停止观察时刻 + PAUSE_FALLBACK_MS；重复观察同一事实不往后推", () => {
    const once = verified([fact({ resetAt: null })]);
    const again = verified([fact({ resetAt: null }), fact({ resetAt: null, source: { kind: "beat", ref: "b2", peer: PEER, authenticated: true },
      observedAt: T0 + 600_000 })], orderDb(), T0 + 700_000);
    expect([once.deadline, once.deadlineFrom, again.deadline]).toEqual([T0 + PAUSE_FALLBACK_MS, "fallback", T0 + PAUSE_FALLBACK_MS]);
    expect([again.stoppedAt, again.lastObservedAt]).toEqual([T0, T0 + 600_000]);
  });
});

describe("planQuotaResume：截止、出借方现状、结果优先、一次资格", () => {
  const stop = (): VerifiedQuotaStop => verified([fact()]);

  test("截止前 wait（until = reset），到点出计划：CAS → cancel → repool，同 peer 同家族、保留写租约、round 不变", () => {
    const s = stop(), o = snap(orderDb());
    const before = planQuotaResume(input(s, o, RESET - 1), RESET - 1);
    expect(before).toEqual({ kind: "wait", why: "等额度重置（reset）", until: RESET });
    const p = planQuotaResume(input(s, o, RESET), RESET);
    if (p.kind !== "plan") throw new Error(kindOf(p));
    expect(p.key).toBe(`qstop:${ORDER}:g1`);
    expect(p.steps.map((x) => x.op)).toEqual(["cas", "settle", "cancel", "repool"]);
    expect(p.steps[1]).toEqual({ op: "settle", orderId: ORDER, gen: 1, peer: PEER, require: "settled", evidence: "receipt#3" });
    expect(p.steps[0]).toMatchObject({ expect: { status: "unknown", leaseGen: 1, resultSha: null, peer: PEER, round: 0 } });
    expect(p.steps[3]).toMatchObject({ peer: PEER, family: "claude", step: "write", round: 0, specRev: 1, supersedes: ORDER, keepWriteLease: true });
  });

  test("无 deadline 的兜底截止跨 tick 稳定：两次 tick 都等同一个 until", () => {
    const s = verified([fact({ resetAt: null })]), o = snap(orderDb());
    const a = planQuotaResume(input(s, o, T0 + 60_000), T0 + 60_000), b = planQuotaResume(input(s, o, T0 + 120_000), T0 + 120_000);
    expect([a, b].map((p) => p.kind === "wait" && p.until)).toEqual([T0 + PAUSE_FALLBACK_MS, T0 + PAUSE_FALLBACK_MS]);
  });

  test("新 hello 仍暂停 / 家族额度满 → wait 到其截止；授权撤销 / 过期 / 仓库或角色不允许 → manual", () => {
    const s = stop(), o = snap(orderDb()), at = RESET + 1;
    const hello = (v: Partial<NonNullable<ResumeInput["hello"]>["value"]>) => ({ hello: { value: { grant: grant(), paused: null, quota: OKQ, ...v },
      source: "hello#43", observedAt: at - 1 } });
    expect(planQuotaResume(input(s, o, at, hello({ paused: { reason: "额度", until: at + 9 } })), at)).toMatchObject({ kind: "wait", until: at + 9 });
    expect(planQuotaResume(input(s, o, at, hello({ quota: { claude: { weekUsedPct: 100, resetAt: at + 7 } } })), at))
      .toMatchObject({ kind: "wait", until: at + 7 });
    for (const g of [null, grant({ until: at }), grant({ repos: ["o/other"] }), grant({ roles: ["review"] })]) {
      expect(planQuotaResume(input(s, o, at, hello({ grant: g })), at).kind).toBe("manual");
    }
  });

  test("当前家族额度未知（quota 省略 / 空对象 / 只有别的家族）或读数已过 reset → wait；明确有余量 → plan", () => {
    const s = stop(), o = snap(orderDb()), at = RESET;
    const withQuota = (quota: HelloQuota | undefined) => {
      const value: NonNullable<ResumeInput["hello"]>["value"] = { grant: grant(), paused: null, ...(quota === undefined ? {} : { quota }) };
      return planQuotaResume(input(s, o, at, { hello: { value, source: "hello#44", observedAt: at } }), at);
    };
    // reset 已过（含恰好到点）的读数属于旧窗口：满额、99%、0% 都不算有余量
    for (const q of [undefined, {}, { codex: { weekUsedPct: 0, resetAt: at + 60_000 } }, { claude: { weekUsedPct: 100, resetAt: at } },
      { claude: { weekUsedPct: 99, resetAt: at - 1 } }, { claude: { weekUsedPct: 99, resetAt: at } }, { claude: { weekUsedPct: 0, resetAt: at - 1 } }]) {
      expect(withQuota(q)).toMatchObject({ kind: "wait", until: null });
    }
    expect(withQuota({ claude: { weekUsedPct: 100, resetAt: at + 60_000 } })).toMatchObject({ kind: "wait", until: at + 60_000 });
    expect(withQuota({ claude: { weekUsedPct: 10, resetAt: at + 60_000 } }).kind).toBe("plan");
    expect(withQuota({ claude: { weekUsedPct: 99, resetAt: at + 1 }, codex: { weekUsedPct: 100, resetAt: at + 60_000 } }).kind).toBe("plan");
  });

  test("hello 缺失 / 早于停止 / 过期 → wait", () => {
    const s = stop(), o = snap(orderDb()), at = RESET + 1, value = { grant: grant(), paused: null, quota: OKQ };
    for (const h of [null, { value, source: "h", observedAt: T0 - 1 }, { value, source: "h", observedAt: at - 200_000 }]) {
      expect(planQuotaResume(input(s, o, at, { hello: h }), at).kind).toBe("wait");
    }
  });

  test("worker 活着 / 不知道、待转交结果 true / 不知道 → wait，不出新单", () => {
    const s = stop(), o = snap(orderDb()), at = RESET + 1;
    for (const over of [{ worker: { value: "alive" as const, source: "b", observedAt: at } }, { worker: { value: "unknown" as const, source: "b", observedAt: at } },
      { worker: null }, { pendingResult: { value: true, source: "b", observedAt: at } }, { pendingResult: { value: null, source: "b", observedAt: at } },
      { pendingResult: { value: false, source: "b", observedAt: T0 - 1 } }]) {
      expect(planQuotaResume(input(s, o, at, over), at).kind).toBe("wait");
    }
  });

  test("并发正式结果先到：旧单 done → manual（结果优先，不撤已提交结果）", () => {
    const s = stop(), db = orderDb();
    db.prepare("UPDATE lend_orders SET status = 'done', resultSha = ? WHERE orderId = ?").run("r".repeat(64), ORDER);
    expect(planQuotaResume(input(s, snap(db), RESET), RESET)).toMatchObject({ kind: "manual", why: "旧单已有结论，结果优先" });
  });

  test("同任务新 head / spec / round / 新租约代 → manual，不消费旧资格", () => {
    const s = stop(), o = snap(orderDb()), at = RESET;
    for (const task of [{ head: "b".repeat(40), specRev: 1, round: 0 }, { head: o.head, specRev: 2, round: 0 }, { head: o.head, specRev: 1, round: 1 }]) {
      expect(planQuotaResume(input(s, o, at, { task }), at).kind).toBe("manual");
    }
    expect(planQuotaResume(input(s, { ...o, leaseGen: 2 }, at), at).kind).toBe("manual");
    expect(planQuotaResume(input(s, { ...o, status: "cancelled" }, at), at).kind).toBe("manual");
  });

  test("写租约不在原出借方 → manual；审查单不看写租约", () => {
    const at = RESET;
    expect(planQuotaResume(input(stop(), snap(orderDb()), at, { writeLease: { peer: "peer:C", state: "held" } }), at).kind).toBe("manual");
    expect(planQuotaResume(input(stop(), snap(orderDb()), at, { writeLease: { peer: PEER, state: "ended" } }), at).kind).toBe("manual");
    const review = orderDb({ step: "review", branch: null, base: null });
    const p = planQuotaResume(input(verified([fact()], review), snap(review), at, { writeLease: null }), at);
    expect(p.kind === "plan" && p.steps[3]).toMatchObject({ step: "review", keepWriteLease: false });
  });

  test("旧单收尾未结清 / 不知道 / 过期 / 早于停止 → wait；结清事实是别的单或别的代 → manual", () => {
    const s = stop(), o = snap(orderDb()), at = RESET + 1;
    const st = (v: Partial<{ orderId: string; gen: number; settled: boolean | null }>, observedAt = at - 1) =>
      ({ settlement: { value: { orderId: ORDER, gen: 1, settled: true, ...v }, source: "receipt#4", observedAt } });
    for (const over of [{ settlement: null }, st({ settled: false }), st({ settled: null }), st({}, at - 200_000), st({}, T0 - 1)]) {
      expect(planQuotaResume(input(s, o, at, over), at)).toMatchObject({ kind: "wait", until: null });
    }
    expect(planQuotaResume(input(s, o, at, st({ gen: 2 })), at).kind).toBe("manual");
    expect(planQuotaResume(input(s, o, at, st({ orderId: "lend:demo:s1:r0:a0" })), at).kind).toBe("manual");
  });

  test("worker / 待转交 / hello / 结清的来源空白 → wait，不出计划", () => {
    const s = stop(), o = snap(orderDb()), at = RESET + 1, base = input(s, o, at);
    for (const k of ["worker", "pendingResult", "hello", "settlement"] as const) {
      const over = { [k]: { ...base[k]!, source: " " } } as Partial<ResumeInput>;
      expect(planQuotaResume(input(s, o, at, over), at).kind).toBe("wait");
    }
  });

  test("同 beat 重复报停 + 已停 + 无结果：门槛不随重复观察移动，连续 tick 都能出计划", () => {
    const o = snap(orderDb());
    const orig = fact({ observedAt: 1_000_000, resetAt: 1_060_000 });
    for (const at of [1_061_000, 1_062_000]) {
      const beat = fact({ observedAt: at, resetAt: 1_060_000, source: { kind: "beat", ref: `b@${at}`, peer: PEER, authenticated: true } });
      const s = verified([orig, beat], orderDb(), at);
      expect([s.stoppedAt, s.deadline]).toEqual([1_000_000, 1_060_000]);
      const same = { source: `b@${at}`, observedAt: at };
      const p = planQuotaResume(input(s, o, at, { worker: { value: "stopped", ...same }, pendingResult: { value: false, ...same },
        hello: { value: { grant: grant({ until: at + 86_400_000 }), paused: null, quota: OKQ }, ...same },
        settlement: { value: { orderId: ORDER, gen: 1, settled: true }, ...same } }), at);
      expect(p.kind).toBe("plan");
    }
  });

  test("重启 + 重复 tick + 并发消费：同一资格只出一次计划", () => {
    const path = join(mkdtempSync(join(tmpdir(), "qstop-")), "audit.sqlite");
    const consume = (key: string): boolean => {
      const db = new Database(path);
      db.prepare("CREATE TABLE IF NOT EXISTS consumed (key TEXT PRIMARY KEY)").run();
      const n = db.prepare("INSERT OR IGNORE INTO consumed (key) VALUES (?)").run(key).changes;
      db.close();
      return n === 1;
    };
    const consumed = (): Set<string> => {
      const db = new Database(path);
      db.prepare("CREATE TABLE IF NOT EXISTS consumed (key TEXT PRIMARY KEY)").run();
      const keys = (db.query("SELECT key FROM consumed").all() as { key: string }[]).map((r) => r.key);
      db.close();
      return new Set(keys);
    };
    const s = stop(), o = snap(orderDb()), at = RESET;
    const a = planQuotaResume(input(s, o, at, { consumed: consumed() }), at), b = planQuotaResume(input(s, o, at, { consumed: consumed() }), at);
    if (a.kind !== "plan" || b.kind !== "plan") throw new Error("both ticks should plan before consumption");
    expect(a.key).toBe(b.key);
    expect([consume(a.key), consume(b.key)]).toEqual([true, false]);
    expect(planQuotaResume(input(s, o, at + 5_000, { consumed: consumed() }), at + 5_000)).toEqual({ kind: "consumed", key: resumeKey(s) });
    expect(resumeKey({ orderId: ORDER, gen: 2 })).not.toBe(a.key);
  });
});
