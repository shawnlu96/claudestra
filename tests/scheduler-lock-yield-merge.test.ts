/**
 * MRGSTALE1：只剩「待审查」旧合并记录（最新一条 scheduler_merges 是 await_review、没有活的 merge 意图）的卡，不再按合并在途豁免让锁。
 * 夹具是真台账（openLedger）+ 真取数（readYieldFacts / readYieldCards）+ 真 tick（lockYieldStep，manager 直连写侧 lockYieldWrite）。
 * 复刻 codex-compact-N3：review、持 src/bridge.ts 等文件锁、10-07 起的合并记录停在 await_review、没有活的意图和出借单、2 小时无进展。
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
import { observeDedupKey, RECOVERY_KEYS, recoveryPolicy, type RecoveryMode, type RecoveryPolicy, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import {
  LOCK_YIELD_STALL_MS, mergeExempt, observeActionKey, planLockYield, yieldDedupKey, type YieldCard,
} from "../src/lib/scheduler-lock-yield.js";
import { lockYieldStep } from "../src/lib/scheduler-lock-yield-deps.js";
import { lockYieldPolicyAt } from "../src/lib/scheduler-lock-yield-policy.js";
import { readYieldCards, readYieldFacts } from "../src/lib/scheduler-lock-yield-read.js";
import { lockYieldWrite, parseLockYieldWire } from "../src/lib/scheduler-lock-yield-write.js";

const MIN = 60_000, H2 = LOCK_YIELD_STALL_MS;
const NOW = Date.UTC(2026, 9, 10, 12), OCT7 = Date.UTC(2026, 9, 7, 23, 22);
const FILES = ["src/bridge.ts", "src/lib/a.ts"];
const owner = { actor: "owner" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

type Modes = { lockYield: RecoveryMode; mergeStaleYield: RecoveryMode };
const port = (m: Modes): RecoveryPolicyPort => (_p, k) => ({ mode: k === "mergeStaleYield" ? m.mergeStaleYield : m.lockYield,
  manualAfterMs: null, source: "config" } as RecoveryPolicy);

/** 项目 p：卡 N3（review、持 FILES、没有绑定 agent），进展停在 OCT7；mode = 流程 auto / manual */
function ledger(mode: "auto" | "manual" = "manual") {
  const dir = mkdtempSync(join(tmpdir(), "mrgstale-")), path = join(dir, "l.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  createTask(db, { ...owner, now: OCT7 - 10 * MIN }, { project: "p", id: "N3", title: "n3", kind: "code", agent: "agent-n3", extra: { fileGlobs: FILES } });
  setWorkflow(db, { ...owner, now: OCT7 - 10 * MIN }, { taskId: "N3", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
  db.run("UPDATE tasks SET agent = NULL, stage = 'review' WHERE id = 'N3'");
  db.run("UPDATE task_workflows SET mode = ? WHERE taskId = 'N3'", [mode]);
  intent(db, "i-w", "dispatch", "done", OCT7 - 9 * MIN);
  for (const r of FILES) db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'N3', 'i-w', ?, 'card')", [r, OCT7 - 9 * MIN]);
  insertEvent(db, { actor: "scheduler", now: OCT7 }, { project: "p", target: "N3", kind: "stage", data: { from: "build", to: "review" } }, false);
  return db;
}

function intent(db: Database, id: string, action: string, status: string, at: number) {
  db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES (?, 'N3', 'p', 'merge', ?, 0, 1, 1, 2, ?, 'x', ?, ?)`, [id, action, status, at, at]);
}

/** 一条合并记录（连同它的 merge 意图，意图默认已结） */
function merge(db: Database, id: string, phase: string, at: number, intentStatus = "done") {
  intent(db, id, "merge", intentStatus, at);
  db.run(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES (?, 'N3', 'p', '1', 'b', 'h', '[]', ?, ?, ?)`, [id, phase, at, at]);
}

const n3 = (db: Database): YieldCard => readYieldCards(db, "p", ["N3"])[0]!;
const plan = (db: Database, ms: RecoveryMode, now = NOW) => planLockYield(readYieldFacts(db, "p"), () => [], now, undefined, ms);
const observed = (db: Database, mechanism: "lockYield" | "mergeStaleYield", since: number) =>
  getEventByDedup(db, observeDedupKey({ project: "p", mechanism, target: "N3", actionKey: observeActionKey(since) }));
const locks = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE taskId = 'N3'").get() as { n: number }).n;
const notes = (db: Database) => (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'note'").get() as { n: number }).n;

/** 真 tick：manager 直连写侧（不起子进程），本机 agent 活动为空（N3 没绑定 agent；写侧重核要读得到 registry，测试状态目录里放一份空的） */
async function tick(db: Database, m: Modes, now = NOW) {
  if (!existsSync(REGISTRY_PATH)) {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: {} }));
    cleanups.push(() => rmSync(REGISTRY_PATH, { force: true }));
  }
  const manager = async (...args: string[]): Promise<Record<string, unknown>> => {
    expect(args.slice(0, 2)).toEqual(["ledger", "scheduler-lock-yield"]);
    try { return lockYieldWrite(db, { actor: "scheduler", now }, args[2]!, parseLockYieldWire(args[4]!), port(m), new Map()); }
    catch (e) { return { ok: false, code: (e as { code?: string }).code, error: (e as Error).message }; }
  };
  const logs = spyOn(console, "log").mockImplementation(() => {}), errs = spyOn(console, "error").mockImplementation(() => {});
  try {
    return await lockYieldStep(db, { projects: { p: {} } } as unknown as SchedulerConfig, manager, async () => {}, port(m), { agents: async () => new Map(), now: () => now });
  } finally { logs.mockRestore(); errs.mockRestore(); }
}

describe("[验收线 1] 取数只看最新一条合并记录", () => {
  test("10-07 的 await_review + 更新的 merging → mergeOpen 真、mergeAwaitReview null", () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    merge(db, "m-new", "merging", OCT7 + H2);
    expect(n3(db)).toMatchObject({ mergeOpen: true, mergeAwaitReview: null });
  });

  test("只有一条 await_review、没有活的 merge 意图 → mergeOpen 假、mergeAwaitReview 是那一条", () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    expect(n3(db)).toMatchObject({ mergeOpen: false, mergeAwaitReview: { intentId: "m-old", updatedAt: OCT7 } });
  });

  test("await_review + 活的 merge 意图 → mergeOpen 真、mergeAwaitReview null", () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    intent(db, "m-live", "merge", "pending", OCT7 + MIN);
    expect(n3(db)).toMatchObject({ mergeOpen: true, mergeAwaitReview: null });
  });

  test("较早的 await_review + 最新一条 merged → 两个都是假 / null；没有合并记录同样", () => {
    const db = ledger();
    expect(n3(db)).toMatchObject({ mergeOpen: false, mergeAwaitReview: null });
    merge(db, "m-old", "await_review", OCT7);
    merge(db, "m-new", "merged", OCT7 + MIN);
    expect(n3(db)).toMatchObject({ mergeOpen: false, mergeAwaitReview: null });
  });

  test("同一时刻按 intentId 排序取最后一条；较早的在途记录不论 phase 都不看", () => {
    const db = ledger();
    merge(db, "m-b", "await_review", OCT7);
    merge(db, "m-a", "merging", OCT7);
    expect(n3(db)).toMatchObject({ mergeOpen: false, mergeAwaitReview: { intentId: "m-b" } });
    merge(db, "m-c", "unknown", OCT7);
    expect(n3(db)).toMatchObject({ mergeOpen: true, mergeAwaitReview: null });
  });
});

describe("[验收线 2] on：N3 形状给出让锁候选（旧红）", () => {
  test.each(["manual", "auto"] as const)("%s 卡：on 出候选；off 照旧 skipped『合并在途』", (mode) => {
    const db = ledger(mode);
    merge(db, "m-old", "await_review", OCT7);
    const on = plan(db, "on");
    expect(on.candidates).toMatchObject([{ taskId: "N3", basis: "idle", since: OCT7, resources: FILES }]);
    expect(on.mergeStale).toEqual([]);
    expect(plan(db, "off")).toMatchObject({ candidates: [], skipped: [{ taskId: "N3", why: "合并在途" }], mergeStale: [] });
  });

  test("tick 全链（lockYield on + mergeStaleYield on）：写侧重核通过，锁真让出；同一段停滞重放不多删", async () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    expect(await tick(db, { lockYield: "on", mergeStaleYield: "on" })).toEqual([]);
    expect(locks(db)).toBe(0);
    expect(getEventByDedup(db, yieldDedupKey("N3", OCT7))?.data).toMatchObject({ op: "lock_yield_released", resources: FILES });
    expect(observed(db, "mergeStaleYield", OCT7)).toBeNull();
  });

  test("lockYield observe + mergeStaleYield on：按 lockYield 的 observe 记一条，锁不动", async () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    await tick(db, { lockYield: "observe", mergeStaleYield: "on" });
    expect(locks(db)).toBe(2);
    expect(observed(db, "lockYield", OCT7)).not.toBeNull();
    expect(observed(db, "mergeStaleYield", OCT7)).toBeNull();
  });

  test("on 下有人在审（活的审查意图 / 出借单）或未满 2 小时，照旧不让", () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    expect(plan(db, "on", OCT7 + H2 - MIN).candidates).toEqual([]);
    intent(db, "i-rv", "dispatch", "submitted", OCT7 + MIN);
    expect(plan(db, "on")).toMatchObject({ candidates: [], skipped: [{ why: expect.stringContaining("i-rv") }] });
  });

  test("写侧不信 tick：mergeStaleYield 已切回 off，伪造的让锁请求重核拒（合并在途）", () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    const wire = { v: 1 as const, phase: "yield" as const, basis: "idle" as const, since: OCT7, resources: FILES, recentMs: 10 * MIN };
    expect(() => lockYieldWrite(db, { actor: "scheduler", now: NOW }, "N3", wire, port({ lockYield: "on", mergeStaleYield: "off" }), new Map()))
      .toThrow("合并在途");
    expect(locks(db)).toBe(2);
  });
});

describe("[验收线 3] observe 记「本可让锁」、off 什么都不记", () => {
  test.each(["on", "observe"] as const)("lockYield %s + mergeStaleYield observe：不让锁，记一条带 mergeStaleYield 那句；重放不多记", async (ly) => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    const p = plan(db, "observe");
    expect(p).toMatchObject({ candidates: [], skipped: [{ taskId: "N3", why: "合并在途" }], mergeStale: [{ candidate: { taskId: "N3" }, merge: { intentId: "m-old" } }] });
    expect(await tick(db, { lockYield: ly, mergeStaleYield: "observe" })).toEqual([]);
    expect(locks(db)).toBe(2);
    expect(getEventByDedup(db, yieldDedupKey("N3", OCT7))).toBeNull();
    const ev = observed(db, "mergeStaleYield", OCT7)!;
    expect(ev.text).toContain("合并记录只剩 await_review（m-old，2026-10-07 23:22），mergeStaleYield 切 on 后会让");
    expect(ev.data).toMatchObject({ op: "recovery_observe", mechanism: "mergeStaleYield", merge: { intentId: "m-old", updatedAt: OCT7 } });
    expect(observed(db, "lockYield", OCT7)).toBeNull();
    const n = notes(db);
    await tick(db, { lockYield: ly, mergeStaleYield: "observe" });
    await tick(db, { lockYield: ly, mergeStaleYield: "observe" }, NOW + H2);
    expect(notes(db)).toBe(n);
  });

  test("observe 下停滞不成立（未满 2 小时 / 有人在审）不记", async () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    await tick(db, { lockYield: "on", mergeStaleYield: "observe" }, OCT7 + MIN);
    intent(db, "i-rv", "dispatch", "pending", OCT7 + MIN);
    await tick(db, { lockYield: "on", mergeStaleYield: "observe" });
    expect(notes(db)).toBe(0);
  });

  test("off：skipped 原因与改前逐字一致（合并在途），什么都不记；lockYield off 时 observe 也不记", async () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    expect(plan(db, "off")).toMatchObject({ skipped: [{ taskId: "N3", why: "合并在途" }], mergeStale: [] });
    await tick(db, { lockYield: "on", mergeStaleYield: "off" });
    await tick(db, { lockYield: "off", mergeStaleYield: "observe" });
    expect(notes(db)).toBe(0);
    expect(locks(db)).toBe(2);
  });

  test("写侧重核：mergeStaleYield 不是 observe、或卡已不是只剩 await_review，伪造的「本可让锁」请求拒", () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    const wire = { v: 1 as const, phase: "yield" as const, basis: "idle" as const, since: OCT7, resources: FILES, recentMs: 10 * MIN, stale: true as const };
    const write = (m: Modes) => () => lockYieldWrite(db, { actor: "scheduler", now: NOW }, "N3", wire, port(m), new Map());
    expect(write({ lockYield: "on", mergeStaleYield: "on" })).toThrow("mergeStaleYield 是 on");
    merge(db, "m-new", "merging", OCT7 + MIN);
    expect(write({ lockYield: "on", mergeStaleYield: "observe" })).toThrow("不是只因 await_review");
    expect(notes(db)).toBe(0);
    expect(() => parseLockYieldWire(JSON.stringify({ ...wire, stale: 1 }))).toThrow("stale");
  });
});

describe("[验收线 4] 其余豁免不受影响（三态）", () => {
  const MODES: RecoveryMode[] = ["on", "observe", "off"];
  test.each(["ready", "updating", "await_ci", "merging", "unknown"])("最新合并记录 %s：三态都『合并在途』", (phase) => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    merge(db, "m-new", phase, OCT7 + MIN);
    for (const ms of MODES) expect(plan(db, ms)).toMatchObject({ candidates: [], skipped: [{ why: "合并在途" }], mergeStale: [] });
  });

  test("活的 merge 意图：三态都『合并在途』", () => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    intent(db, "m-live", "merge", "unknown", OCT7 + MIN);
    for (const ms of MODES) expect(plan(db, ms)).toMatchObject({ candidates: [], skipped: [{ why: "合并在途" }], mergeStale: [] });
  });

  test.each([
    ["冻结卡", (db: Database) => db.run(`UPDATE tasks SET extra = json_set(extra, '$.frozen', json('true')) WHERE id = 'N3'`), "冻结卡"],
    ["security 模板", (db: Database) => db.run("UPDATE task_workflows SET template = 'security' WHERE taskId = 'N3'"), "security 模板"],
    ["已在 verified", (db: Database) => db.run("UPDATE tasks SET stage = 'verified' WHERE id = 'N3'"), "合并在途"],
    ["已在 live", (db: Database) => db.run("UPDATE tasks SET stage = 'live' WHERE id = 'N3'"), "合并在途"],
  ] as const)("%s + 只剩 await_review：三态都按原来的豁免，observe 不记", (_n, arrange, offWhy) => {
    const db = ledger();
    merge(db, "m-old", "await_review", OCT7);
    arrange(db);
    const stage = (db.query("SELECT stage FROM tasks WHERE id = 'N3'").get() as { stage: string }).stage;
    for (const ms of MODES) {
      const p = plan(db, ms);
      expect(p.candidates).toEqual([]);
      expect(p.mergeStale).toEqual([]);
      expect(p.skipped[0]!.why).toBe(ms === "on" && offWhy === "合并在途" ? `已在 ${stage}` : offWhy);
    }
  });

  test("mergeExempt 是唯一判定：mergeOpen 一律豁免，只剩 await_review 只有 on 不豁免", () => {
    const aw = { intentId: "m", updatedAt: OCT7 };
    for (const ms of MODES) expect(mergeExempt({ mergeOpen: true, mergeAwaitReview: null }, ms)).toBe(true);
    expect(mergeExempt({ mergeOpen: false, mergeAwaitReview: aw }, "on")).toBe(false);
    expect(mergeExempt({ mergeOpen: false, mergeAwaitReview: aw }, "observe")).toBe(true);
    expect(mergeExempt({ mergeOpen: false, mergeAwaitReview: aw }, "off")).toBe(true);
    expect(mergeExempt({ mergeOpen: false }, "off")).toBe(false);
  });
});

describe("[验收线 5] 车道", () => {
  test("正式让过锁、最新合并记录 await_review：on 进让出集合；observe / off 不进；在途记录三态都不进", () => {
    const db = ledger();
    db.run("UPDATE tasks SET stage = 'blocked' WHERE id = 'N3'");
    insertEvent(db, { actor: "pm", now: OCT7 }, { project: "p", target: "N3", kind: "stage", data: { from: "review", to: "blocked" } }, false);
    lockYieldWrite(db, { actor: "scheduler", now: NOW }, "N3", { v: 1, phase: "yield", basis: "blocked", since: OCT7, resources: FILES, recentMs: 10 * MIN },
      port({ lockYield: "on", mergeStaleYield: "off" }), new Map());
    expect(laneYielded(db, "p", ["N3"], "off")).toEqual(new Set(["N3"]));
    merge(db, "m-old", "await_review", OCT7);
    expect(laneYielded(db, "p", ["N3"], "on")).toEqual(new Set(["N3"]));
    expect(laneYielded(db, "p", ["N3"], "observe")).toEqual(new Set());
    expect(laneYielded(db, "p", ["N3"], "off")).toEqual(new Set());
    expect(laneYielded(db, "p", ["N3"])).toEqual(new Set()); // 没配 = observe
    merge(db, "m-new", "await_ci", OCT7 + MIN);
    for (const ms of ["on", "observe", "off"] as const) expect(laneYielded(db, "p", ["N3"], ms)).toEqual(new Set());
  });
});

describe("[验收线 6] 开关", () => {
  test("RECOVERY_KEYS 里 mergeStaleYield 恰好一次；没配时 observe，沿用通用继承（keys → 项目 mode）", () => {
    expect(RECOVERY_KEYS.filter((k) => k === "mergeStaleYield")).toHaveLength(1);
    const dir = mkdtempSync(join(tmpdir(), "mrgstale-pol-")), path = join(dir, "recovery-policy.json");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    expect(recoveryPolicy("p", "mergeStaleYield", path)).toMatchObject({ mode: "observe", source: "default" });
    expect(lockYieldPolicyAt(path)("p", "mergeStaleYield")).toMatchObject({ mode: "observe", source: "default" });
    writeFileSync(path, JSON.stringify({ projects: { p: { mode: "off", keys: { mergeStaleYield: "on" } }, q: { mode: "on" } } }));
    expect(lockYieldPolicyAt(path)("p", "mergeStaleYield").mode).toBe("on");
    expect(lockYieldPolicyAt(path)("q", "mergeStaleYield").mode).toBe("on");
    expect(lockYieldPolicyAt(path)("q", "lockYield").mode).toBe("observe"); // lockYield 自己的读法不变
  });
});
