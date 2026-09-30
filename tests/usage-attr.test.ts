/**
 * token 账归属（T95，src/lib/usage-attr.ts）：单卡、多卡重叠、换执行者、跨天、调度绑定优先、PM 协调开销、原始数据不动、可整体重算。
 * 台账用真实迁移建库（openLedger），行直接插：这里测的是「读台账判归属」，不是台账写入层的校验。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { StepName } from "../src/lib/ledger-stages.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import type { ExecutorKind } from "../src/lib/ledger-steps.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { attributeFromPath, attributeTurns, resolveFeatureIds } from "../src/lib/usage-attr.js";
import { turnsFor, usageByFeature, usageByTask } from "../src/lib/usage-query.js";
import { openUsageDb } from "../src/lib/usage-store.js";

const M = 60_000;
const T0 = Date.parse("2026-09-30T10:00:00+09:00");
const P = "proj";
let paths: string[] = [];

function ledger(): { db: Database; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "usage-attr-")), "ledger.sqlite");
  paths.push(path);
  const db = openLedger(path);
  db.exec("PRAGMA foreign_keys = OFF"); // 直接插行：调度意图、事项这些外键对判归属无关
  db.prepare("INSERT INTO meta (project, key, value) VALUES (?, 'pms', ?)").run(P, JSON.stringify(["agent-pm"]));
  db.prepare("INSERT INTO items (project, id, title, status, createdAt, updatedAt) VALUES (?, 'i1', '协作底座改版', 'doing', 0, 0)").run(P);
  return { db, path };
}
afterEach(() => {
  for (const p of paths) closeLedger(p);
  paths = [];
});

function task(db: Database, id: string, created: number, extra: { itemId?: string; featureId?: string; agent?: string } = {}) {
  db.prepare(`INSERT INTO tasks (id, project, itemId, title, kind, stage, agent, assignee, assigneeKind, featureId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'code', 'spec', ?, ?, ?, ?, ?, ?)`)
    .run(id, P, extra.itemId ?? "i1", id, extra.agent ?? null, extra.agent ?? null, extra.agent ? "agent" : null, extra.featureId ?? null, created, created);
}
function stage(db: Database, id: string, at: number, from: string, to: string, round = 0) {
  db.prepare("INSERT INTO events (ts, actor, project, target, kind, data) VALUES (?, 'agent-pm', ?, ?, 'stage', ?)").run(at, P, id, JSON.stringify({ from, to, round }));
}
function step(db: Database, id: string, name: string, round: number, executor: string, at: number) {
  db.prepare(`INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'agent', 'assigned', ?, ?)`)
    .run(id, name, round, executor, at, at);
}

let turnSeq = 0;
/** 一轮 + 它的调用（每次调用 1000 读缓存 + 10 输出）；返回轮 id */
function turn(u: Database, agent: string, start: number, opts: { session?: string; calls?: number[] } = {}): string {
  const id = `turn-${++turnSeq}`;
  u.prepare(`INSERT INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime) VALUES (?, ?, ?, 0, ?, 'channel', '', 'claude-code')`)
    .run(id, agent, opts.session ?? `s-${agent}`, start);
  for (const [i, at] of (opts.calls ?? [start + 1000]).entries()) {
    u.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning) VALUES (?, ?, ?, ?, 'm', 1, 0, 1000, 10, 0)`)
      .run(`${id}:${i}`, id, at, new Date(at).toISOString().slice(0, 10));
  }
  return id;
}
const attrOf = (u: Database, id: string) => u.query("SELECT attr_task AS task, attr_step AS step, attr_round AS round, attr_basis AS basis FROM turns WHERE turn_id = ?").get(id);

/** 标准一张卡：10:00 建卡 → 10:05 复述 → 10:20 开写 → 11:00 交审 → 11:30 返修 → 12:00 再审 → 12:30 合并 */
function standardCard(db: Database, id = "T1", author = "agent-a", reviewer = "agent-r") {
  task(db, id, T0, { agent: author });
  step(db, id, "write", 1, author, T0 + 5 * M);
  stage(db, id, T0 + 5 * M, "spec", "restate");
  stage(db, id, T0 + 20 * M, "restate", "build");
  stage(db, id, T0 + 60 * M, "build", "review", 1);
  step(db, id, "review", 1, reviewer, T0 + 60 * M);
  stage(db, id, T0 + 90 * M, "review", "fix", 1);
  step(db, id, "fix", 1, author, T0 + 120 * M); // 「修」这一行常在修完交付时才补派，和推阶段同一刻
  stage(db, id, T0 + 120 * M, "fix", "review", 2);
  step(db, id, "review", 2, reviewer, T0 + 120 * M);
  stage(db, id, T0 + 150 * M, "review", "merge", 2);
}

describe("单卡", () => {
  test("每一步的窗口归到那一步、那一轮；窗口外和不在台账里的写明原因", () => {
    const { db } = ledger();
    standardCard(db);
    const u = openUsageDb(":memory:");
    const ids = {
      spec: turn(u, "agent-a", T0 + 2 * M),
      restate: turn(u, "agent-a", T0 + 10 * M),
      write: turn(u, "agent-a", T0 + 30 * M),
      review1: turn(u, "agent-r", T0 + 70 * M),
      fix: turn(u, "agent-a", T0 + 100 * M),
      review2: turn(u, "agent-r", T0 + 130 * M),
      idleAuthor: turn(u, "agent-a", T0 + 140 * M),
      stranger: turn(u, "agent-x", T0 + 30 * M),
      unowned: turn(u, "unowned", T0 + 30 * M),
    };
    attributeTurns(u, db);
    expect(attrOf(u, ids.spec)).toEqual({ task: null, step: null, round: null, basis: "outside_window" });
    expect(attrOf(u, ids.restate)).toEqual({ task: "T1", step: "restate", round: 0, basis: "step" });
    expect(attrOf(u, ids.write)).toEqual({ task: "T1", step: "write", round: 1, basis: "step" });
    expect(attrOf(u, ids.review1)).toEqual({ task: "T1", step: "review", round: 1, basis: "step" });
    expect(attrOf(u, ids.fix)).toEqual({ task: "T1", step: "fix", round: 1, basis: "step" });
    expect(attrOf(u, ids.review2)).toEqual({ task: "T1", step: "review", round: 2, basis: "step" });
    expect(attrOf(u, ids.idleAuthor)).toMatchObject({ task: null, basis: "outside_window" });
    expect(attrOf(u, ids.stranger)).toMatchObject({ task: null, basis: "not_in_ledger" });
    expect(attrOf(u, ids.unowned)).toMatchObject({ task: null, basis: "unowned" });
    const rows = usageByTask(u, "T1");
    expect(rows.map((r) => `${r.step}#${r.round} ${r.agent}`)).toEqual(["restate#0 agent-a", "write#1 agent-a", "review#1 agent-r", "fix#1 agent-a", "review#2 agent-r"]);
  });

  test("PM 算协调开销，哪怕它在某张卡上挂着执行者", () => {
    const { db } = ledger();
    standardCard(db, "T1", "agent-pm");
    const u = openUsageDb(":memory:");
    const id = turn(u, "agent-pm", T0 + 30 * M);
    const master = turn(u, "master", T0 + 30 * M);
    attributeTurns(u, db);
    expect(attrOf(u, id)).toMatchObject({ task: null, basis: "coordination" });
    expect(attrOf(u, master)).toMatchObject({ task: null, basis: "coordination" });
  });
});

describe("多卡重叠", () => {
  test("同一时刻挂着两张卡的窗口：不猜，记 overlap；只挂一张的时段照常归", () => {
    const { db } = ledger();
    standardCard(db, "T1");
    task(db, "T2", T0 + 40 * M, { agent: "agent-a" });
    step(db, "T2", "write", 1, "agent-a", T0 + 40 * M);
    stage(db, "T2", T0 + 40 * M, "spec", "build");
    stage(db, "T2", T0 + 80 * M, "build", "review", 1);
    const u = openUsageDb(":memory:");
    const onlyT1 = turn(u, "agent-a", T0 + 30 * M);
    const both = turn(u, "agent-a", T0 + 50 * M);
    const onlyT2 = turn(u, "agent-a", T0 + 70 * M);
    attributeTurns(u, db);
    expect(attrOf(u, onlyT1)).toMatchObject({ task: "T1", basis: "step" });
    expect(attrOf(u, both)).toEqual({ task: null, step: null, round: null, basis: "overlap" });
    expect(attrOf(u, onlyT2)).toMatchObject({ task: "T2", step: "write", basis: "step" });
  });
});

describe("换执行者", () => {
  test("同一步中途改派：改派时刻之前归旧人，之后归新人（轮次跟着行走）", () => {
    const { db } = ledger();
    task(db, "T1", T0, { agent: "agent-a" });
    step(db, "T1", "write", 1, "agent-a", T0);
    stage(db, "T1", T0, "spec", "build");
    step(db, "T1", "write", 2, "agent-b", T0 + 30 * M);
    stage(db, "T1", T0 + 60 * M, "build", "review", 1);
    const u = openUsageDb(":memory:");
    const aBefore = turn(u, "agent-a", T0 + 10 * M), aAfter = turn(u, "agent-a", T0 + 40 * M);
    const bBefore = turn(u, "agent-b", T0 + 10 * M), bAfter = turn(u, "agent-b", T0 + 40 * M);
    attributeTurns(u, db);
    expect(attrOf(u, aBefore)).toMatchObject({ task: "T1", step: "write", round: 1 });
    expect(attrOf(u, aAfter)).toMatchObject({ task: null, basis: "outside_window" });
    expect(attrOf(u, bBefore)).toMatchObject({ task: null, basis: "outside_window" });
    expect(attrOf(u, bAfter)).toMatchObject({ task: "T1", step: "write", round: 2 });
  });

  test("换人修、「修」那一行交付时才补派：整段修都归修的人，写的人这段不算", () => {
    const { db } = ledger();
    task(db, "T1", T0, { agent: "agent-a" });
    step(db, "T1", "write", 1, "agent-a", T0);
    stage(db, "T1", T0, "spec", "build");
    stage(db, "T1", T0 + 30 * M, "build", "review", 1);
    stage(db, "T1", T0 + 40 * M, "review", "fix", 1);
    step(db, "T1", "fix", 1, "agent-c", T0 + 80 * M + 500); // 和推阶段同一个事务，晚几百毫秒落行
    stage(db, "T1", T0 + 80 * M, "fix", "review", 2);
    const u = openUsageDb(":memory:");
    const fixer = turn(u, "agent-c", T0 + 45 * M), writer = turn(u, "agent-a", T0 + 45 * M);
    attributeTurns(u, db);
    expect(attrOf(u, fixer)).toEqual({ task: "T1", step: "fix", round: 1, basis: "step" });
    expect(attrOf(u, writer)).toMatchObject({ task: null, basis: "outside_window" });
  });
});

/** 走台账真实的派人写入（assignStep）：同轮改派覆盖行上的执行者、只在派发事件里留历史，这正是要测的 */
function assign(db: Database, id: string, name: StepName, round: number, executor: string, at: number, kind: ExecutorKind = "agent") {
  assignStep(db, { actor: "agent-pm", now: at }, { taskId: id, step: name, round, executor, executorKind: kind });
}

describe("r1 回归：改派历史与审查轮次（T95 r1）", () => {
  test("同一步同一轮改派后重算：改派前两张卡的重叠仍是 overlap，新人接手前的轮不算这张卡", () => {
    const { db } = ledger();
    for (const id of ["T1", "T2"]) {
      task(db, id, T0);
      stage(db, id, T0, "spec", "build", 1);
      assign(db, id, "write", 1, "agent-a", T0);
    }
    const u = openUsageDb(":memory:");
    const a20 = turn(u, "agent-a", T0 + 20 * M), b20 = turn(u, "agent-b", T0 + 20 * M);
    const a40 = turn(u, "agent-a", T0 + 40 * M), b40 = turn(u, "agent-b", T0 + 40 * M);
    attributeTurns(u, db);
    expect(attrOf(u, a20)).toMatchObject({ task: null, basis: "overlap" });
    assign(db, "T1", "write", 1, "agent-b", T0 + 30 * M);
    attributeTurns(u, db);
    expect(attrOf(u, a20)).toMatchObject({ task: null, basis: "overlap" });
    expect(attrOf(u, b20)).toMatchObject({ task: null, basis: "outside_window" });
    expect(attrOf(u, a40)).toEqual({ task: "T2", step: "write", round: 1, basis: "step" });
    expect(attrOf(u, b40)).toEqual({ task: "T1", step: "write", round: 1, basis: "step" });
  });

  test("旧终审 → 返修 → 新一轮初审：新一轮盖过旧终审；新审查员同时接着另一张卡就是 overlap", () => {
    const { db } = ledger();
    task(db, "T1", T0);
    stage(db, "T1", T0, "spec", "build", 1);
    stage(db, "T1", T0 + 10 * M, "build", "review", 1);
    assign(db, "T1", "final_review", 1, "agent-old", T0 + 10 * M);
    stage(db, "T1", T0 + 20 * M, "review", "fix", 1);
    stage(db, "T1", T0 + 30 * M, "fix", "review", 2);
    assign(db, "T1", "review", 2, "agent-new", T0 + 30 * M);
    task(db, "T2", T0 + 30 * M);
    stage(db, "T2", T0 + 30 * M, "spec", "build", 1);
    assign(db, "T2", "write", 1, "agent-new", T0 + 30 * M);
    const u = openUsageDb(":memory:");
    const old15 = turn(u, "agent-old", T0 + 15 * M), old40 = turn(u, "agent-old", T0 + 40 * M), new40 = turn(u, "agent-new", T0 + 40 * M);
    attributeTurns(u, db);
    expect(attrOf(u, old15)).toEqual({ task: "T1", step: "final_review", round: 1, basis: "step" });
    expect(attrOf(u, old40)).toMatchObject({ task: null, basis: "outside_window" });
    expect(attrOf(u, new40)).toMatchObject({ task: null, basis: "overlap" });
  });

  test("审查阶段中途加派：同轮终审盖过初审、更大一轮的初审再盖过终审，都在派人那一刻切", () => {
    const { db } = ledger();
    task(db, "T1", T0);
    stage(db, "T1", T0, "spec", "build", 1);
    stage(db, "T1", T0 + 10 * M, "build", "review", 1);
    assign(db, "T1", "review", 1, "agent-r1", T0 + 10 * M);
    assign(db, "T1", "final_review", 1, "agent-f", T0 + 25 * M);
    assign(db, "T1", "review", 2, "agent-r2", T0 + 40 * M);
    const u = openUsageDb(":memory:");
    const ids = {
      r1At20: turn(u, "agent-r1", T0 + 20 * M), r1At30: turn(u, "agent-r1", T0 + 30 * M),
      fAt30: turn(u, "agent-f", T0 + 30 * M), fAt45: turn(u, "agent-f", T0 + 45 * M), r2At45: turn(u, "agent-r2", T0 + 45 * M),
    };
    attributeTurns(u, db);
    expect(attrOf(u, ids.r1At20)).toEqual({ task: "T1", step: "review", round: 1, basis: "step" });
    expect(attrOf(u, ids.r1At30)).toMatchObject({ task: null, basis: "outside_window" });
    expect(attrOf(u, ids.fAt30)).toEqual({ task: "T1", step: "final_review", round: 1, basis: "step" });
    expect(attrOf(u, ids.fAt45)).toMatchObject({ task: null, basis: "outside_window" });
    expect(attrOf(u, ids.r2At45)).toEqual({ task: "T1", step: "review", round: 2, basis: "step" });
  });

  test("改派给别的实例：之前归本机的人，之后本机的人这张卡的窗口停掉", () => {
    const { db } = ledger();
    task(db, "T1", T0);
    stage(db, "T1", T0, "spec", "build", 1);
    assign(db, "T1", "write", 1, "agent-a", T0);
    assign(db, "T1", "write", 1, "agent-x@peer-a", T0 + 30 * M, "peer");
    const u = openUsageDb(":memory:");
    const before = turn(u, "agent-a", T0 + 20 * M), after = turn(u, "agent-a", T0 + 40 * M);
    attributeTurns(u, db);
    expect(attrOf(u, before)).toEqual({ task: "T1", step: "write", round: 1, basis: "step" });
    expect(attrOf(u, after)).toMatchObject({ task: null, basis: "outside_window" });
  });

  test("行比第一条派发事件早（交付时补的行、后来同轮改派）：那一段原来是谁找不回来，别的卡上的单卡轮不归，写明原因", () => {
    const { db } = ledger();
    task(db, "T1", T0);
    stage(db, "T1", T0, "spec", "build", 1);
    step(db, "T1", "write", 1, "agent-a", T0); // 没有派发事件的行
    assign(db, "T1", "write", 1, "agent-b", T0 + 30 * M);
    task(db, "T2", T0);
    stage(db, "T2", T0, "spec", "build", 1);
    assign(db, "T2", "write", 1, "agent-a", T0);
    const u = openUsageDb(":memory:");
    const a20 = turn(u, "agent-a", T0 + 20 * M), a40 = turn(u, "agent-a", T0 + 40 * M), b40 = turn(u, "agent-b", T0 + 40 * M);
    attributeTurns(u, db);
    expect(attrOf(u, a20)).toMatchObject({ task: null, basis: "executor_lost" });
    expect(attrOf(u, a40)).toEqual({ task: "T2", step: "write", round: 1, basis: "step" });
    expect(attrOf(u, b40)).toEqual({ task: "T1", step: "write", round: 1, basis: "step" });
  });
});

describe("跨天", () => {
  test("按轮的开始时间判；一轮跨过午夜的调用整轮跟着这张卡走，不拆到两天各判一次", () => {
    const { db } = ledger();
    const mid = Date.parse("2026-10-01T00:00:00+09:00");
    task(db, "T1", mid - 60 * M, { agent: "agent-a" });
    step(db, "T1", "write", 1, "agent-a", mid - 60 * M);
    stage(db, "T1", mid - 60 * M, "spec", "build");
    stage(db, "T1", mid - 5 * M, "build", "review", 1); // 午夜前交审：窗口已关，但这一轮开始时还在窗口里
    const u = openUsageDb(":memory:");
    const id = turn(u, "agent-a", mid - 10 * M, { calls: [mid - 9 * M, mid + 5 * M, mid + 20 * M] });
    attributeTurns(u, db);
    expect(attrOf(u, id)).toMatchObject({ task: "T1", step: "write", round: 1 });
    const [row] = usageByTask(u, "T1");
    expect(row.calls).toBe(3);
    expect(row.turns).toBe(1);
  });
});

describe("调度引擎绑定优先", () => {
  test("绑定的会话整条属于那张卡：盖过协调开销和多卡重叠；步骤跟角色对得上才记", () => {
    const { db } = ledger();
    standardCard(db, "T1");
    standardCard(db, "T2");
    const bind = db.prepare(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 'claude', 'acp', 'active', 'i', 0, 0)`);
    bind.run("T2", "author", "agent-a", "sess-a");
    bind.run("T1", "reviewer", "agent-pm", "sess-pm");
    const u = openUsageDb(":memory:");
    const author = turn(u, "agent-a", T0 + 30 * M, { session: "sess-a" }); // 按窗口是 T1 + T2 重叠
    const authorInReview = turn(u, "agent-a", T0 + 70 * M, { session: "sess-a" });
    const reviewer = turn(u, "agent-pm", T0 + 70 * M, { session: "sess-pm" }); // 按人是 PM
    const plain = turn(u, "agent-a", T0 + 30 * M); // 同一 agent 没绑定的会话：照窗口判
    attributeTurns(u, db);
    expect(attrOf(u, author)).toEqual({ task: "T2", step: "write", round: 1, basis: "session" });
    expect(attrOf(u, authorInReview)).toEqual({ task: "T2", step: null, round: null, basis: "session" });
    expect(attrOf(u, reviewer)).toEqual({ task: "T1", step: "review", round: 1, basis: "session" });
    expect(attrOf(u, plain)).toMatchObject({ task: null, basis: "overlap" });
  });
});

describe("存储", () => {
  test("只写归属列：calls 与轮的原始列逐字节不变；再跑一遍 0 行变化", () => {
    const { db } = ledger();
    standardCard(db);
    const u = openUsageDb(":memory:");
    for (let i = 0; i < 20; i++) turn(u, i % 2 ? "agent-a" : "agent-r", T0 + i * 8 * M, { calls: [T0 + i * 8 * M + 1, T0 + i * 8 * M + 2] });
    const raw = () => JSON.stringify([
      u.query("SELECT * FROM calls ORDER BY key").all(),
      u.query("SELECT turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime FROM turns ORDER BY turn_id").all(),
    ]);
    const before = raw();
    const first = attributeTurns(u, db);
    expect(first.changed).toBeGreaterThan(0);
    expect(raw()).toBe(before);
    expect(attributeTurns(u, db).changed).toBe(0);
  });

  test("一轮只落一张卡：按 feature 汇总 = 各卡之和 = 已归属轮的调用总数", () => {
    const { db } = ledger();
    standardCard(db, "T1", "agent-a", "agent-r");
    standardCard(db, "T2", "agent-b", "agent-s");
    const u = openUsageDb(":memory:");
    for (let i = 0; i < 40; i++) turn(u, ["agent-a", "agent-b", "agent-r", "agent-s"][i % 4], T0 + i * 4 * M);
    attributeTurns(u, db);
    const byFeature = usageByFeature(u, ["i1"]);
    const perTask = ["T1", "T2"].map((t) => usageByTask(u, t).reduce((s, r) => s + r.calls, 0));
    const attributed = (u.query("SELECT COUNT(*) AS n FROM calls c JOIN turns t ON t.turn_id = c.turn_id WHERE t.attr_task IS NOT NULL").get() as { n: number }).n;
    expect(byFeature.map((r) => r.calls)).toEqual(perTask);
    expect(perTask[0] + perTask[1]).toBe(attributed);
  });

  test("规则的输入变了整体重算：台账补推阶段后，旧的「窗口外」改归到卡上", () => {
    const { db, path } = ledger();
    task(db, "T1", T0, { agent: "agent-a" });
    step(db, "T1", "write", 1, "agent-a", T0);
    const u = openUsageDb(":memory:");
    const id = turn(u, "agent-a", T0 + 30 * M);
    attributeFromPath(u, path);
    expect(attrOf(u, id)).toMatchObject({ basis: "outside_window" });
    stage(db, "T1", T0 + 10 * M, "spec", "build");
    expect(attributeFromPath(u, path)?.changed).toBe(1);
    expect(attrOf(u, id)).toMatchObject({ task: "T1", step: "write", basis: "step" });
    expect(turnsFor(u, "agent-a")[0].attr).toEqual({ task: "T1", step: "write", round: 1, feature: null, item: "i1", basis: "step" });
  });

  test("没有台账库：跳过，不报错", () => {
    const u = openUsageDb(":memory:");
    expect(attributeFromPath(u, join(tmpdir(), "no-such-dir-usage-attr", "ledger.sqlite"))).toBeNull();
  });
});

describe("feature", () => {
  test("迁进 feature 的卡按 feature id 汇总；没迁的挂事项；按名字找撞多个不替人选", () => {
    const { db } = ledger();
    db.prepare("INSERT INTO features (id, project, title, status, createdBy, createdAt, updatedAt) VALUES ('box-sched', ?, '调度引擎', 'active', 'x', 0, 0)").run(P);
    db.prepare("INSERT INTO items (project, id, title, status, createdAt, updatedAt) VALUES (?, 'i2', '调度引擎旧事项', 'doing', 0, 0)").run(P);
    standardCard(db, "T1");
    db.prepare("UPDATE tasks SET featureId = 'box-sched' WHERE id = 'T1'").run();
    standardCard(db, "T2", "agent-b", "agent-s");
    const u = openUsageDb(":memory:");
    turn(u, "agent-a", T0 + 30 * M);
    turn(u, "agent-b", T0 + 30 * M);
    attributeTurns(u, db);
    expect(usageByFeature(u, ["box-sched"]).map((r) => r.task)).toEqual(["T1"]);
    expect(usageByFeature(u, ["i1"]).map((r) => r.task)).toEqual(["T1", "T2"]);
    expect(resolveFeatureIds(db, "sched")).toMatchObject({ ids: ["box-sched"] });
    expect(resolveFeatureIds(db, "协作底座")).toMatchObject({ ids: ["i1"] });
    expect(resolveFeatureIds(db, "调度引擎")).toMatchObject({ ambiguous: ["box-sched 调度引擎", "i2 调度引擎旧事项"] });
    expect(resolveFeatureIds(db, "没有这个")).toBeNull();
  });
});
