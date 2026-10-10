/**
 * RLOCK2 判定（纯函数）与 `ledger scheduler-lock-yield` 写侧重核。停滞两条依据、豁免、阈值边界、等锁的卡、恢复后拿不回锁的判定。
 * 生产接法（只读句柄 + 子进程）在 scheduler-lock-yield-prod.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecoveryPolicy } from "../src/lib/recovery-policy.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getEventByDedup, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import {
  contentionOf, LOCK_YIELD_STALL_MS, planLockYield, stallOf, yieldDedupKey, type YieldAgent, type YieldCard, type YieldFacts, type YieldHeld,
} from "../src/lib/scheduler-lock-yield.js";
import { readYieldFacts } from "../src/lib/scheduler-lock-yield-read.js";
import { lockYieldWrite, parseLockYieldWire } from "../src/lib/scheduler-lock-yield-write.js";

const NOW = 100 * 3_600_000, MIN = 60_000, H2 = LOCK_YIELD_STALL_MS;
const card = (over: Partial<YieldCard> = {}): YieldCard => ({
  id: "A", project: "p", stage: "blocked", branch: "feat/a", extra: { fileGlobs: ["src/lib/**"] }, workflow: { template: "code", mode: "auto" },
  blockedAt: NOW - H2, progressAt: NOW - H2, liveIntents: [], intentAt: NOW - 5 * H2, liveOrders: [], orderAt: null, mergeOpen: false, ...over,
});
const lock = (taskId: string, resource: string, acquiredAt = NOW - 5 * H2): YieldHeld => ({ resource, taskId, intentId: `i-${taskId}`, acquiredAt, scope: "card" });
const HELD = [lock("A", "src/lib/**")];
const idle: YieldAgent[] = [{ name: "agent-a", recent: false, lastAt: NOW - 3 * H2 }];

describe("停滞的定义", () => {
  test("a：blocked 满 2 小时即算，以进 blocked 的阶段事件为准；1 小时 59 分不算", () => {
    expect(stallOf(card(), HELD, idle, NOW)).toMatchObject({ kind: "stalled", basis: "blocked", since: NOW - H2 });
    const young = card({ blockedAt: NOW - H2 + MIN, progressAt: NOW - H2 + MIN });
    expect(stallOf(young, HELD, idle, NOW)).toMatchObject({ kind: "skip" });
  });

  test("b：2 小时无意图 / 出借单 / 进展事件 / 活动回合才算；任一活着都不算", () => {
    const fix = card({ stage: "fix", blockedAt: null });
    expect(stallOf(fix, HELD, idle, NOW)).toMatchObject({ kind: "stalled", basis: "idle", since: NOW - H2 });
    expect(stallOf({ ...fix, progressAt: NOW - H2 + MIN }, HELD, idle, NOW)).toMatchObject({ kind: "skip", why: expect.stringContaining("未满") });
    expect(stallOf({ ...fix, liveIntents: ["i1"] }, HELD, idle, NOW)).toMatchObject({ kind: "skip", why: expect.stringContaining("i1") });
    expect(stallOf({ ...fix, liveOrders: ["o1"] }, HELD, idle, NOW)).toMatchObject({ kind: "skip", why: expect.stringContaining("o1") });
    expect(stallOf(fix, HELD, [{ name: "agent-a", recent: true, lastAt: NOW - 3 * H2 }], NOW)).toMatchObject({ kind: "skip", why: expect.stringContaining("活动回合") });
    expect(stallOf(fix, HELD, [{ name: "agent-a", recent: false, lastAt: NOW - MIN * 90 }], NOW)).toMatchObject({ kind: "skip" });
    expect(stallOf(fix, HELD, null, NOW)).toMatchObject({ kind: "skip", why: expect.stringContaining("读不了") });
    expect(stallOf(fix, [lock("A", "src/lib/**", NOW - MIN)], idle, NOW)).toMatchObject({ kind: "skip" }); // 刚拿的锁也是进展
  });

  test("blocked 时 a 先于 b：同一段停滞的起点不随依据漂移（去重键稳定）", () => {
    const c = card({ progressAt: NOW - H2 }), s = stallOf(c, HELD, idle, NOW + H2);
    expect(s).toMatchObject({ basis: "blocked", since: NOW - H2 });
    expect(stallOf(c, HELD, idle, NOW + 3 * H2)).toEqual(s);
  });

  test("不持锁不判", () => expect(stallOf(card(), [lock("B", "src/x.ts")], idle, NOW)).toMatchObject({ kind: "skip", why: "没持锁" }));
});

describe("豁免一律不让", () => {
  test.each([
    ["冻结名单", card({ id: "T82" }), [lock("T82", "src/lib/**")]],
    ["frozen 标记", card({ extra: { fileGlobs: ["src/lib/**"], frozen: true } }), HELD],
    ["extra 读不了", card({ extra: null }), HELD],
    ["security 模板", card({ workflow: { template: "security", mode: "auto" } }), HELD],
    ["没有流程记录", card({ workflow: null }), HELD],
    ["合并在途（merges / merge 意图）", card({ mergeOpen: true }), HELD],
    ["合并在途（持合并锁）", card(), [...HELD, lock("A", "merge:p")]],
  ] as const)("%s", (_name, c, held) => {
    expect(stallOf(c, held, idle, NOW + 10 * H2)).toMatchObject({ kind: "skip" });
  });

  test("取数不完整：整轮不让", () => {
    const f: YieldFacts = { project: "p", cards: [card()], held: HELD, unknown: ["scheduler_resources 读不了"] };
    expect(planLockYield(f, () => idle, NOW).candidates).toEqual([]);
  });
});

describe("计划与恢复", () => {
  const waiter = (id: string, globs: string[], stage = "build"): YieldCard => card({ id, stage, extra: { fileGlobs: globs }, blockedAt: null, progressAt: NOW });

  test("列出会释放的资源和因此能开工 / 仍被挡的卡", () => {
    const f: YieldFacts = { project: "p", unknown: [], held: [...HELD, lock("A", "slot:p:1"), lock("C", "src/lib/y.ts", NOW)],
      cards: [card(), waiter("B", ["src/lib/x.ts"]), waiter("D", ["src/lib/y.ts"]), waiter("E", ["web/z.ts"]), waiter("F", ["src/lib/q.ts"], "review")] };
    const plan = planLockYield(f, (id) => (id === "A" ? idle : []), NOW);
    expect(plan.candidates).toEqual([{ taskId: "A", basis: "blocked", since: NOW - H2, evidence: expect.any(String), resources: ["slot:p:1", "src/lib/**"],
      waiters: [{ taskId: "B", files: ["src/lib/**"], canStart: true, stillBlockedBy: [] }, { taskId: "D", files: ["src/lib/**"], canStart: false, stillBlockedBy: ["C"] }] }]);
  });

  test("恢复后拿不回锁：只看 auto 卡的 build / fix，报出占锁卡、重叠文件与分支", () => {
    const back = card({ stage: "build", blockedAt: null });
    const f = { cards: [back, card({ id: "B", branch: "feat/b" })], held: [lock("B", "src/lib/x.ts"), lock("B", "task:B")] };
    expect(contentionOf(back, f)).toEqual({ holders: [{ taskId: "B", branch: "feat/b", files: ["src/lib/x.ts"] }] });
    expect(contentionOf({ ...back, stage: "review" }, f)).toBeNull();
    expect(contentionOf({ ...back, workflow: { template: "code", mode: "manual" } }, f)).toBeNull();
    expect(contentionOf(back, { ...f, held: [lock("B", "web/x.ts")] })).toBeNull();
  });
});

describe("ledger scheduler-lock-yield 写侧", () => {
  let dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) { closeLedger(join(d, "l.sqlite")); rmSync(d, { recursive: true, force: true }); } });
  const policy = (mode: RecoveryPolicy["mode"]) => () => ({ mode, manualAfterMs: null, source: "config" as const });

  function ledger() {
    const dir = mkdtempSync(join(tmpdir(), "rlock2-")), db = openLedger(join(dir, "l.sqlite"));
    dirs.push(dir);
    const t0 = Date.now() - 3 * H2;
    createTask(db, { actor: "owner", now: t0 }, { project: "p", id: "A", title: "a", kind: "code", extra: { fileGlobs: ["src/lib/**"] } });
    setWorkflow(db, { actor: "owner", now: t0 }, { taskId: "A", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
    db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('i-A', 'A', 'p', 'write', 'dispatch', 0, 1, 1, 2, 'done', 'w', ?, ?)`, [t0, t0]);
    db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/lib/**', 'A', 'i-A', ?, 'card')", [t0]);
    db.run("UPDATE tasks SET stage = 'blocked', stageBefore = 'build' WHERE id = 'A'");
    const blockedAt = Date.now() - H2 - MIN;
    insertEvent(db, { actor: "pm", now: blockedAt }, { project: "p", target: "A", kind: "stage", data: { from: "build", to: "blocked" } }, false);
    const wire = { v: 1 as const, phase: "yield" as const, basis: "blocked" as const, since: blockedAt, resources: ["src/lib/**"], recentMs: 10 * MIN };
    return { db, wire, blockedAt };
  }

  test("只给调度服务；停滞依据或锁清单变了就拒（conflict），不删锁", () => {
    const { db, wire } = ledger();
    expect(() => lockYieldWrite(db, { actor: "pm" }, "A", wire, policy("on"), new Map())).toThrow(/调度服务/);
    expect(() => lockYieldWrite(db, { actor: "scheduler" }, "A", { ...wire, since: wire.since + 1 }, policy("on"), new Map())).toThrow(/已变/);
    expect(() => lockYieldWrite(db, { actor: "scheduler" }, "A", { ...wire, resources: [] }, policy("on"), new Map())).toThrow(/已变/);
    expect(() => lockYieldWrite(db, { actor: "scheduler" }, "A", wire, policy("off"), new Map())).toThrow(/不让/);
    expect(readYieldFacts(db, "p").held).toHaveLength(1);
  });

  test("on：删这张卡的锁行、记一次（按卡 + 停滞起点去重）；重放不再动", () => {
    const { db, wire, blockedAt } = ledger();
    const first = lockYieldWrite(db, { actor: "scheduler" }, "A", wire, policy("on"), new Map());
    expect(first).toMatchObject({ ok: true, mode: "on", duplicate: false, released: ["src/lib/**"] });
    expect(readYieldFacts(db, "p").held).toEqual([]);
    expect(getEventByDedup(db, yieldDedupKey("A", blockedAt))?.data).toMatchObject({ op: "lock_yield_released", basis: "blocked" });
    expect(lockYieldWrite(db, { actor: "scheduler" }, "A", wire, policy("on"), new Map())).toMatchObject({ duplicate: true });
  });

  test("--data 严格解析", () => {
    expect(() => parseLockYieldWire("{")).toThrow(/JSON/);
    expect(() => parseLockYieldWire(JSON.stringify({ v: 1, phase: "yield", basis: "other", since: 1, resources: [], recentMs: 1 }))).toThrow(/basis/);
    expect(() => parseLockYieldWire(JSON.stringify({ v: 1, phase: "contend", releaseSeq: 0 }))).toThrow(/releaseSeq/);
    expect(parseLockYieldWire(JSON.stringify({ v: 1, phase: "yield", basis: "idle", since: 1, resources: ["b", "a"], recentMs: 600_000 })))
      .toEqual({ v: 1, phase: "yield", basis: "idle", since: 1, resources: ["a", "b"], recentMs: 600_000 });
    expect(() => parseLockYieldWire(JSON.stringify({ v: 1, phase: "yield", basis: "idle", since: 1, resources: [], recentMs: 0 }))).toThrow(/recentMs/);
  });
});
