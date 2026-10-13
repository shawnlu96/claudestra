/**
 * MRGSTALE2：阶段是 merge 的卡（重审通过、在合并队列里排队）一律算合并在途，不算「只剩旧待审查记录」。
 * 排队期间轮到合并槽之前不会生成新的合并记录，最新一条仍是 update-branch 留下的 await_review。
 * 夹具同 scheduler-lock-yield-merge.test.ts：真台账 + 真取数 + 真 tick。复刻 hardening-CCIDLE1 / team-project-S2F6：
 * 持文件锁、await_review 记录之后重审通过进 merge、没有活的意图和出借单、2 小时无进展。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { laneYielded } from "../src/lib/dag-lane-lock-yield.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getEventByDedup, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask } from "../src/lib/ledger-write.js";
import { observeDedupKey, type RecoveryMode, type RecoveryPolicy, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import {
  LOCK_YIELD_STALL_MS, mergeStaleCandidate, observeActionKey, planLockYield, stallOf, type YieldCard,
} from "../src/lib/scheduler-lock-yield.js";
import { lockYieldStep } from "../src/lib/scheduler-lock-yield-deps.js";
import { readYieldCards, readYieldFacts } from "../src/lib/scheduler-lock-yield-read.js";
import { lockYieldWrite, parseLockYieldWire } from "../src/lib/scheduler-lock-yield-write.js";

const MIN = 60_000, H2 = LOCK_YIELD_STALL_MS;
// CCIDLE1 的时刻：03:15 update-branch 留下 await_review，05:21 重审通过进 merge，09:08 被记「本可让锁」
const T_AWAIT = Date.UTC(2026, 9, 12, 3, 15), T_MERGE = Date.UTC(2026, 9, 12, 5, 21), NOW = Date.UTC(2026, 9, 12, 9, 8);
const FILES = ["src/bridge.ts", "src/lib/a.ts"];
const owner = { actor: "owner" };
const MODES: RecoveryMode[] = ["on", "observe", "off"];
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

type Modes = { lockYield: RecoveryMode; mergeStaleYield: RecoveryMode };
const port = (m: Modes): RecoveryPolicyPort => (_p, k) => ({ mode: k === "mergeStaleYield" ? m.mergeStaleYield : m.lockYield,
  manualAfterMs: null, source: "config" } as RecoveryPolicy);

function intent(db: Database, id: string, action: string, status: string, at: number) {
  db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES (?, 'C1', 'p', 'merge', ?, 0, 1, 1, 2, ?, 'x', ?, ?)`, [id, action, status, at, at]);
}

/** 一条合并记录（连同它的 merge 意图，意图已结） */
function merge(db: Database, id: string, phase: string, at: number) {
  intent(db, id, "merge", "done", at);
  db.run(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES (?, 'C1', 'p', '1', 'b', 'h', '[]', ?, ?, ?)`, [id, phase, at, at]);
}

/**
 * 项目 p：卡 C1 持 FILES，最新合并记录是 T_AWAIT 的 await_review（没有活的 merge 意图），最后一次进展是 T_MERGE 的阶段事件。
 * stage = merge：重审通过回到合并队列（CCIDLE1 / S2F6）；stage = review：还在等重审（N3 形状）。
 */
function ledger(stage: "merge" | "review", record = true) {
  const dir = mkdtempSync(join(tmpdir(), "mrgstale2-")), path = join(dir, "l.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const t0 = T_AWAIT - 10 * MIN;
  createTask(db, { ...owner, now: t0 }, { project: "p", id: "C1", title: "c1", kind: "code", agent: "agent-c1", extra: { fileGlobs: FILES } });
  setWorkflow(db, { ...owner, now: t0 }, { taskId: "C1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
  db.run("UPDATE tasks SET agent = NULL, stage = ? WHERE id = 'C1'", [stage]);
  intent(db, "i-w", "dispatch", "done", t0);
  for (const r of FILES) db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'C1', 'i-w', ?, 'card')", [r, t0]);
  if (record) merge(db, "m-old", "await_review", T_AWAIT);
  insertEvent(db, { actor: "scheduler", now: T_MERGE }, { project: "p", target: "C1", kind: "stage",
    data: stage === "merge" ? { from: "review", to: "merge" } : { from: "merge", to: "review" } }, false);
  return db;
}

const c1 = (db: Database): YieldCard => readYieldCards(db, "p", ["C1"])[0]!;
const plan = (db: Database, ms: RecoveryMode, now = NOW) => planLockYield(readYieldFacts(db, "p"), () => [], now, undefined, ms);
const observed = (db: Database, since: number) =>
  getEventByDedup(db, observeDedupKey({ project: "p", mechanism: "mergeStaleYield", target: "C1", actionKey: observeActionKey(since) }));
const locks = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE taskId = 'C1'").get() as { n: number }).n;
const notes = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'note'").get() as { n: number }).n;

/** 写侧重核要读得到 registry：测试状态目录里放一份空的（C1 没绑定 agent） */
function registry() {
  if (existsSync(REGISTRY_PATH)) return;
  mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: {} }));
  cleanups.push(() => rmSync(REGISTRY_PATH, { force: true }));
}

/** 真 tick：manager 直连写侧（不起子进程），本机 agent 活动为空 */
async function tick(db: Database, m: Modes, now = NOW) {
  registry();
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    try { return lockYieldWrite(db, { actor: "scheduler", now }, args[2]!, parseLockYieldWire(args[4]!), port(m), new Map()); }
    catch (e) { return { ok: false, code: (e as { code?: string }).code, error: (e as Error).message }; }
  };
  const logs = spyOn(console, "log").mockImplementation(() => {}), errs = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await lockYieldStep(db, { projects: { p: {} } } as unknown as SchedulerConfig, manager, async () => {}, port(m), { agents: async () => new Map(), now: () => now });
  } finally { logs.mockRestore(); errs.mockRestore(); }
}

describe("[红测 1] stage=merge + 最新合并记录 await_review + 没有活的 merge 意图 + 持锁停滞超过 2 小时", () => {
  test("夹具成立：已停滞超过 2 小时，没有活的意图", () => {
    const db = ledger("merge");
    expect(NOW - T_MERGE).toBeGreaterThan(H2);
    expect(c1(db)).toMatchObject({ stage: "merge", progressAt: T_MERGE, liveIntents: [], liveOrders: [] });
    expect(locks(db)).toBe(2);
  });

  test("readYieldCards：mergeOpen 真、mergeAwaitReview null", () => {
    const c = c1(ledger("merge"));
    expect(c.mergeOpen).toBe(true);
    expect(c.mergeAwaitReview).toBeNull();
  });

  test("observe：mergeStaleCandidate 返回 null，计划里不列「本可让锁」", () => {
    const db = ledger("merge"), f = readYieldFacts(db, "p");
    expect(mergeStaleCandidate(f, f.cards.find((c) => c.id === "C1")!, [], NOW, "observe")).toBeNull();
    expect(plan(db, "observe")).toMatchObject({ candidates: [], skipped: [{ taskId: "C1", why: "合并在途" }], mergeStale: [] });
  });

  test("on：stallOf 判 skip（合并在途），不出让锁候选", () => {
    const db = ledger("merge"), f = readYieldFacts(db, "p");
    expect(stallOf(f.cards.find((c) => c.id === "C1")!, f.held, [], NOW, H2, "on")).toEqual({ kind: "skip", why: "合并在途" });
    expect(plan(db, "on")).toMatchObject({ candidates: [], skipped: [{ taskId: "C1", why: "合并在途" }], mergeStale: [] });
  });

  test.each(MODES)("tick 全链 mergeStaleYield %s：锁不动，什么都不记", async (ms) => {
    const db = ledger("merge");
    expect(await tick(db, { lockYield: "on", mergeStaleYield: ms })).toEqual([]);
    expect(locks(db)).toBe(2);
    expect(notes(db)).toBe(0);
    expect(observed(db, T_MERGE)).toBeNull();
  });

  test("写侧重核：伪造的让锁 / 「本可让锁」请求都拒", () => {
    const db = ledger("merge");
    registry();
    const wire = { v: 1 as const, phase: "yield" as const, basis: "idle" as const, since: T_MERGE, resources: FILES, recentMs: 10 * MIN };
    const write = (w: typeof wire & { stale?: true }, ms: RecoveryMode) => () =>
      lockYieldWrite(db, { actor: "scheduler", now: NOW }, "C1", w, port({ lockYield: "on", mergeStaleYield: ms }), new Map());
    expect(write(wire, "on")).toThrow("合并在途");
    expect(write({ ...wire, stale: true }, "observe")).toThrow("不是只因 await_review");
    expect(locks(db)).toBe(2);
    expect(notes(db)).toBe(0);
  });

  test("stage=merge 不看最新合并记录是什么 phase：没有记录 / merged / resolved 也算在途", () => {
    expect(c1(ledger("merge", false))).toMatchObject({ mergeOpen: true, mergeAwaitReview: null });
    for (const phase of ["merged", "resolved", "await_review"]) {
      const db = ledger("merge");
      merge(db, "m-new", phase, T_AWAIT + MIN);
      expect(c1(db)).toMatchObject({ mergeOpen: true, mergeAwaitReview: null });
      for (const ms of MODES) expect(plan(db, ms)).toMatchObject({ candidates: [], skipped: [{ why: "合并在途" }], mergeStale: [] });
    }
  });
});

describe("[保持测] 同样的记录、stage=review（N3 形状）：MRGSTALE1 的行为不变", () => {
  test("readYieldCards：mergeOpen 假、mergeAwaitReview 是那一条", () => {
    expect(c1(ledger("review"))).toMatchObject({ mergeOpen: false, mergeAwaitReview: { intentId: "m-old", updatedAt: T_AWAIT } });
  });

  test("observe：仍是「本可让锁」候选，tick 记一条，锁不动", async () => {
    const db = ledger("review"), f = readYieldFacts(db, "p");
    expect(mergeStaleCandidate(f, f.cards.find((c) => c.id === "C1")!, [], NOW, "observe"))
      .toMatchObject({ candidate: { taskId: "C1", basis: "idle", since: T_MERGE, resources: FILES }, merge: { intentId: "m-old" } });
    expect(plan(db, "observe")).toMatchObject({ candidates: [], skipped: [{ taskId: "C1", why: "合并在途" }], mergeStale: [{ candidate: { taskId: "C1" } }] });
    await tick(db, { lockYield: "on", mergeStaleYield: "observe" });
    expect(locks(db)).toBe(2);
    expect(observed(db, T_MERGE)?.data).toMatchObject({ op: "recovery_observe", mechanism: "mergeStaleYield", merge: { intentId: "m-old", updatedAt: T_AWAIT } });
  });

  test("on：stallOf 判停滞，出让锁候选；off 照旧『合并在途』", () => {
    const db = ledger("review"), f = readYieldFacts(db, "p");
    expect(stallOf(f.cards.find((c) => c.id === "C1")!, f.held, [], NOW, H2, "on")).toMatchObject({ kind: "stalled", basis: "idle", since: T_MERGE });
    expect(plan(db, "on")).toMatchObject({ candidates: [{ taskId: "C1", basis: "idle", since: T_MERGE, resources: FILES }], mergeStale: [] });
    expect(plan(db, "off")).toMatchObject({ candidates: [], skipped: [{ taskId: "C1", why: "合并在途" }], mergeStale: [] });
  });

  test("fix 阶段同 review", () => {
    const db = ledger("review");
    db.run("UPDATE tasks SET stage = 'fix' WHERE id = 'C1'");
    expect(c1(db)).toMatchObject({ mergeOpen: false, mergeAwaitReview: { intentId: "m-old" } });
    expect(plan(db, "on").candidates).toMatchObject([{ taskId: "C1" }]);
  });
});

describe("[车道] dag-lane-lock-yield 对 stage=merge 的卡按合并在途跳过", () => {
  test("正式让过锁、最新合并记录 await_review：review 时 on 进让出集合；进了 merge 三态都不进", () => {
    const db = ledger("review");
    db.run("UPDATE tasks SET stage = 'blocked' WHERE id = 'C1'");
    insertEvent(db, { actor: "pm", now: T_MERGE + MIN }, { project: "p", target: "C1", kind: "stage", data: { from: "review", to: "blocked" } }, false);
    lockYieldWrite(db, { actor: "scheduler", now: NOW }, "C1", { v: 1, phase: "yield", basis: "blocked", since: T_MERGE + MIN, resources: FILES, recentMs: 10 * MIN },
      port({ lockYield: "on", mergeStaleYield: "on" }), new Map());
    expect(locks(db)).toBe(0);
    db.run("UPDATE tasks SET stage = 'review' WHERE id = 'C1'"); // 只改阶段、不记事件：下面三态的差别只来自合并事实
    expect(laneYielded(db, "p", ["C1"], "on")).toEqual(new Set(["C1"]));
    db.run("UPDATE tasks SET stage = 'merge' WHERE id = 'C1'");
    for (const ms of MODES) expect(laneYielded(db, "p", ["C1"], ms)).toEqual(new Set());
  });
});
