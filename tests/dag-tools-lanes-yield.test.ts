/**
 * RLOCK3：车道读侧认正式停滞让锁。隔离临时台账 + 真实 RLOCK2 写侧（lockYieldWrite，mode on）让锁，再走真实 featureLanes / nodeGate。
 * 复现 DISK1 / LOCAL1：让过锁、没锁行、没新进展的卡，车道还按 extra.fileGlobs 挡住 S2V2 / S2I；图内绑定节点同理。
 * 恢复推进 / 重新拿锁再挡；证明不完整、字段坏、他项目、缺表 / 读坏、活意图 / 出借单 / 合并在途、冻结 / security 一律保守挡。
 */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureLanes } from "../src/lib/dag-tools-lanes.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, moveStage, setMeta, setTask } from "../src/lib/ledger-write.js";
import type { RecoveryPolicy } from "../src/lib/recovery-policy.js";
import { nodeGate } from "../src/lib/scheduler-autostart.js";
import { LOCK_YIELD_STALL_MS } from "../src/lib/scheduler-lock-yield.js";
import { lockYieldWrite } from "../src/lib/scheduler-lock-yield-write.js";

const MIN = 60_000, H2 = LOCK_YIELD_STALL_MS;
const DISK = ["src/lib/disk/**"];
const owner = { actor: "owner" }, pm = { actor: "agent-pm" }, sched = { actor: "scheduler" };
const on = () => ({ mode: "on" as RecoveryPolicy["mode"], manualAfterMs: null, source: "config" as const });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

/** 项目 p：特性 s2（S2V2 / S2I 要 disk 下的文件，DOC 不相干）；图外卡 DISK1 持 src/lib/disk/** 卡级锁、blocked 满 2 小时 */
function ledger(opts: { bound?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rlock3-")), path = join(dir, "l.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const t0 = Date.now() - 3 * H2, at = { now: t0 };
  db.exec("INSERT INTO ledger_instance VALUES ('origin','ab12')");
  setMeta(db, { ...owner, ...at }, { project: "p", key: "pms", value: [pm.actor] });
  feature(db, "s2", [...(opts.bound ? [{ key: "D", fileGlobs: DISK }] : []), { key: "S2V2", fileGlobs: ["src/lib/disk/v2.ts"] },
    { key: "S2I", fileGlobs: ["src/lib/disk/i.ts"] }, { key: "DOC", fileGlobs: ["docs/x.md"] }], t0);
  card(db, "DISK1", DISK, t0);
  if (opts.bound) bindNode(db, { ...owner, ...at }, { id: "ab12-s2", rev: getFeature(db, "ab12-s2")!.rev, key: "D", taskId: "DISK1" });
  db.run(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES ('i-DISK1', 'DISK1', 'p', 'write', 'dispatch', 0, 1, 1, 2, 'done', 'w', ?, ?)`, [t0, t0]);
  db.run("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', ?, 'DISK1', 'i-DISK1', ?, 'card')", [DISK[0], t0]);
  db.run("UPDATE tasks SET stage = 'blocked', stageBefore = 'build' WHERE id = 'DISK1'");
  const blockedAt = Date.now() - H2 - MIN;
  insertEvent(db, { actor: "pm", now: blockedAt }, { project: "p", target: "DISK1", kind: "stage", data: { from: "build", to: "blocked" } }, false);
  const yieldIt = () => lockYieldWrite(db, sched, "DISK1", { v: 1, phase: "yield", basis: "blocked", since: blockedAt, resources: DISK, recentMs: 10 * MIN },
    on, new Map());
  return { db, yieldIt, blockedAt };
}

function feature(db: Database, slug: string, nodes: { key: string; fileGlobs: string[] }[], now: number) {
  createFeature(db, { ...owner, now }, { project: "p", slug, title: slug });
  initDag(db, { ...owner, now }, { id: `ab12-${slug}`, rev: 1, nodes: nodes.map((n) => ({ ...n, oneLine: n.key, deps: [] })) });
}

function card(db: Database, id: string, fileGlobs: string[], now: number) {
  createTask(db, { ...owner, now }, { project: "p", id, title: id, kind: "code", agent: `agent-${id}`, extra: { fileGlobs } });
  setWorkflow(db, { ...owner, now }, { taskId: id, taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "x" });
}

const lanes = (db: Database, slug = "s2") => featureLanes(db, getFeature(db, `ab12-${slug}`)!)!;
const blockedBy = (db: Database, key = "S2V2") => lanes(db).waiting.find((w) => w.key === key)?.on ?? [];
const seq = (db: Database) => (db.query("SELECT MAX(seq) AS n FROM events WHERE project = 'p'").get() as { n: number }).n;
const dispatch = (db: Database, id: string, resources: string[]) => planIntent(db, pm, { id: `${id}-w${seq(db)}`, taskId: id, taskRev: getTask(db, id)!.rev,
  workflowRev: getWorkflow(db, id)!.rev, causalSeq: seq(db), node: "write", action: "dispatch", reason: "write", resources });

test("复现 DISK1：图外卡正式让锁、无新进展 → 不再挡；普通 note 不算进展；start 入口预检同一口径", () => {
  const { db, yieldIt } = ledger();
  const f = getFeature(db, "ab12-s2")!;
  expect(blockedBy(db)).toEqual(["DISK1"]);
  expect(nodeGate(db, f, "S2V2", featureLanes(db, f))).toMatchObject({ gate: "lanes" });
  expect(yieldIt()).toMatchObject({ mode: "on", released: DISK });
  expect(db.query("SELECT COUNT(*) AS n FROM scheduler_resources").get()).toEqual({ n: 0 });
  expect(lanes(db).startNow).toEqual(["S2V2", "S2I", "DOC"]);
  expect(nodeGate(db, f, "S2V2", featureLanes(db, f))).toBeNull();
  insertEvent(db, { ...pm, now: Date.now() }, { project: "p", target: "DISK1", kind: "note", text: "PM：还在等上游", data: {} }, false);
  insertEvent(db, { ...pm, now: Date.now() }, { project: "p", target: "DISK1", kind: "note", text: "manual", data: { op: "workflow_manual_note" } }, false);
  expect(lanes(db).startNow).toEqual(["S2V2", "S2I", "DOC"]);
});

test("图内绑定的节点同一判据：让锁后不挡别的节点；分组照旧（还没做完）", () => {
  const { db, yieldIt } = ledger({ bound: true });
  expect(blockedBy(db)).toEqual(["D"]);
  yieldIt();
  const r = lanes(db);
  expect(r.startNow).toEqual(["S2V2", "S2I", "DOC"]);
  expect(r.lanes).toEqual([["D", "S2V2", "S2I"], ["DOC"]]);
});

test.each([
  ["阶段事件（恢复推进）", (db: Database) => moveStage(db, owner, { taskId: "DISK1", from: "blocked", to: "build" })],
  ["步骤事件", (db: Database) => insertEvent(db, { ...sched, now: Date.now() }, { project: "p", target: "DISK1", kind: "step", data: {} }, false)],
  ["交付事件", (db: Database) => insertEvent(db, { ...sched, now: Date.now() }, { project: "p", target: "DISK1", kind: "deliver", data: {} }, false)],
] as const)("恢复推进后再挡：%s", (_name, resume) => {
  const { db, yieldIt } = ledger({ bound: true });
  yieldIt();
  expect(lanes(db).startNow).toContain("S2V2");
  resume(db);
  expect(blockedBy(db)).toEqual(["D"]);
});

test("重新正常拿锁：只按实际持有的部分挡；结清后仍按锁挡，终态没收锁照样挡", () => {
  const { db, yieldIt } = ledger();
  yieldIt();
  moveStage(db, owner, { taskId: "DISK1", from: "blocked", to: "build" });
  dispatch(db, "DISK1", ["src/lib/disk/v2.ts"]);
  db.run("UPDATE scheduler_intents SET status = 'done' WHERE taskId = 'DISK1'");
  db.run("UPDATE scheduler_resources SET scope = 'card' WHERE taskId = 'DISK1'");
  expect(blockedBy(db, "S2V2")).toEqual(["DISK1"]);
  expect(blockedBy(db, "S2I")).toEqual([]);
  expect(lanes(db).startNow).toEqual(["S2I", "DOC"]);
  db.run("UPDATE tasks SET stage = 'live' WHERE id = 'DISK1'");
  expect(blockedBy(db, "S2V2")).toEqual(["DISK1"]);
});

test("新派单（哪怕没拿文件锁、意图已结）也算恢复：再按声明范围挡", () => {
  const { db, yieldIt } = ledger();
  yieldIt();
  db.run("UPDATE tasks SET stage = 'build' WHERE id = 'DISK1'"); // 只看派单本身：不经阶段事件
  dispatch(db, "DISK1", []);
  db.run("UPDATE scheduler_intents SET status = 'done' WHERE taskId = 'DISK1'");
  expect(blockedBy(db)).toEqual(["DISK1"]);
});

test("两个特性同时成了候选：正式派单 CAS 只让一个拿到同一文件", () => {
  const { db, yieldIt } = ledger();
  feature(db, "s3", [{ key: "X", fileGlobs: ["src/lib/disk/v2.ts"] }], Date.now());
  yieldIt();
  expect(lanes(db).startNow).toContain("S2V2");
  expect(lanes(db, "s3").startNow).toEqual(["X"]);
  for (const id of ["C2", "C3"]) {
    card(db, id, ["src/lib/disk/v2.ts"], Date.now());
    moveStage(db, owner, { taskId: id, from: "spec", to: "restate" });
    moveStage(db, owner, { taskId: id, from: "restate", to: "build" });
  }
  dispatch(db, "C2", ["src/lib/disk/v2.ts"]);
  expect(() => dispatch(db, "C3", ["src/lib/disk/v2.ts"])).toThrow(/重叠.*C2/);
  expect(db.query("SELECT taskId FROM scheduler_resources WHERE resource = 'src/lib/disk/v2.ts'").all()).toEqual([{ taskId: "C2" }]);
});

const LOCKS_GONE = (db: Database) => db.run("DELETE FROM scheduler_resources WHERE taskId = 'DISK1'");
const fakeRelease = (db: Database, project: string, data: Record<string, unknown>, actor = "scheduler", dedupKey?: string) =>
  insertEvent(db, { actor, now: Date.now(), ...(dedupKey ? { dedupKey } : {}) }, { project, target: "DISK1", kind: "note", text: "让锁", data }, false);

test.each([
  ["没有让锁记录、空锁表、manual + blocked", (db: Database) => {
    LOCKS_GONE(db);
    db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'DISK1'");
  }, false],
  ["只有普通 note 文字", (db: Database) => {
    LOCKS_GONE(db);
    insertEvent(db, { ...pm, now: Date.now() }, { project: "p", target: "DISK1", kind: "note", text: "lock_yield_released 已让锁", data: {} }, false);
  }, false],
  ["他项目的让锁记录", (db: Database, b: number) => {
    LOCKS_GONE(db);
    fakeRelease(db, "q", { op: "lock_yield_released", basis: "blocked", since: b, resources: DISK, rows: [{ resource: DISK[0] }] }, "scheduler", `lock-yield:DISK1:${b}`);
  }, false],
  ["非调度服务写的", (db: Database, b: number) => {
    LOCKS_GONE(db);
    fakeRelease(db, "p", { op: "lock_yield_released", basis: "blocked", since: b, resources: DISK, rows: [{ resource: DISK[0] }] }, "agent-pm", `lock-yield:DISK1:${b}`);
  }, false],
  ["只有 op 字符串、缺字段", (db: Database) => { LOCKS_GONE(db); fakeRelease(db, "p", { op: "lock_yield_released" }); }, false],
  ["较新一条让锁记录字段坏（不回退认旧的）", (db: Database, b: number) => {
    fakeRelease(db, "p", { op: "lock_yield_released", basis: "blocked", since: b, resources: DISK, rows: [] }, "scheduler", `lock-yield:DISK1:${b + 1}`);
  }, true],
  ["活的调度意图", (db: Database) => db.run("UPDATE scheduler_intents SET status = 'unknown' WHERE id = 'i-DISK1'"), true],
  ["活的出借单", (db: Database) => db.run(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
    status, leaseMs, createdBy, createdAt, updatedAt) VALUES ('o1', 'DISK1', 'p', 'mate', 'codex', 'write', 1, 0, 'h', 'o/r', '{}', 't', 's', 'claimed', 1, 'scheduler', 1, 1)`), true],
  ["合并在途", (db: Database) => db.run(`INSERT INTO scheduler_merges (intentId, taskId, project, prRef, expectedBranch, reviewedHead, requiredChecks, phase, createdAt, updatedAt)
    VALUES ('i-DISK1', 'DISK1', 'p', '1', 'b', 'h', '[]', 'await_ci', 1, 1)`), true],
  ["冻结标记", (db: Database) => setTask(db, owner, { id: "DISK1", rev: getTask(db, "DISK1")!.rev, patch: { extra: { fileGlobs: DISK, frozen: true } } }), true],
  ["security 模板", (db: Database) => db.run("UPDATE task_workflows SET template = 'security' WHERE taskId = 'DISK1'"), true],
  ["缺表", (db: Database) => db.run("DROP TABLE scheduler_merges"), true],
  ["读坏", (db: Database) => db.run("ALTER TABLE lend_orders RENAME COLUMN status TO state"), true],
] as const)("保守挡：%s", (_name, arrange, realYield) => {
  const { db, yieldIt, blockedAt } = ledger({ bound: true });
  if (realYield) yieldIt();
  arrange(db, blockedAt);
  expect(db.query("SELECT COUNT(*) AS n FROM scheduler_resources WHERE taskId = 'DISK1'").get()).toEqual({ n: 0 });
  expect(blockedBy(db)).toEqual(["D"]);
  expect(lanes(db).startNow).toEqual(["DOC"]);
});
