/**
 * 归属补齐（UXUSAGE1 验收线 1，src/lib/usage-attr.ts boundSessions）：scheduler_sessions 之外，worker_agents 登记给卡的会话（cv 修复、本机审查员）
 * 和卡上仲裁事件引用的会话（ref.sessionId）整条算给这张卡；同一会话多处登记只计一次、以 scheduler_sessions 为准；没登记的不算进来。
 */
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { attributeTurns } from "../src/lib/usage-attr.js";
import { usageByTask } from "../src/lib/usage-query.js";
import { openUsageDb } from "../src/lib/usage-store.js";

const T0 = Date.parse("2026-10-01T10:00:00+09:00");
const H = 3600_000;
let opened: string[] = [];
afterEach(() => {
  for (const p of opened) closeLedger(p);
  opened = [];
});

function ledgerWithCards(...ids: string[]): Database {
  const path = join(mkdtempSync(join(tmpdir(), "usage-attr-sess-")), "ledger.sqlite");
  opened.push(path);
  const db = openLedger(path);
  db.exec("PRAGMA foreign_keys = OFF"); // 只测读台账判归属：事项外键无关
  for (const id of ids) {
    db.prepare(`INSERT INTO tasks (id, project, itemId, title, kind, stage, createdAt, updatedAt) VALUES (?, 'p', 'i1', ?, 'code', 'build', ?, ?)`)
      .run(id, id, T0, T0);
  }
  return db;
}

const schedulerSession = (db: Database, taskId: string, role: string, sessionId: string) =>
  db.prepare(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, 'claude', 'acp', 'active', 'i', 0, 0)`).run(taskId, role, `agent-${sessionId}`, sessionId);
const worker = (db: Database, taskId: string | null, role: string, sessionId: string, at = T0) =>
  db.prepare(`INSERT INTO worker_agents (agent, sessionId, taskId, role, createdBy, createdAt, state) VALUES (?, ?, ?, ?, 'agent-pm', ?, 'retired')`)
    .run(`agent-${sessionId}-${at}`, sessionId, taskId, role, at);
const arbiterRef = (db: Database, taskId: string, sessionId: string) =>
  db.prepare("INSERT INTO events (ts, actor, project, target, kind, data) VALUES (?, 'scheduler', 'p', ?, 'scheduler', ?)")
    .run(T0, taskId, JSON.stringify({ op: "convergence_effect", intentId: "x", ref: { agent: "agent-arb", sessionId, family: "codex" }, disputeSeq: 1 }));

let seq = 0;
function turn(u: Database, sessionId: string, at = T0 + H): string {
  const id = `t${++seq}`;
  u.prepare(`INSERT INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime) VALUES (?, ?, ?, 0, ?, 'channel', '', 'claude-code')`)
    .run(id, `agent-${sessionId}`, sessionId, at);
  u.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning) VALUES (?, ?, ?, '2026-10-01', 'm', 1, 0, 100, 9, 0)`)
    .run(`${id}:0`, id, at + 1);
  return id;
}
const attr = (u: Database, id: string) => u.query("SELECT attr_task AS task, attr_basis AS basis FROM turns WHERE turn_id = ?").get(id);

test("[验收线 1] 作者、cv 修复、本机审查员、仲裁引用四类会话的轮都归到这张卡", () => {
  const db = ledgerWithCards("T1");
  schedulerSession(db, "T1", "author", "s-author");
  worker(db, "T1", "author", "s-cvfix");
  worker(db, "T1", "reviewer", "s-local-reviewer");
  arbiterRef(db, "T1", "s-arbiter");
  const u = openUsageDb(":memory:");
  const ids = { author: turn(u, "s-author"), cv: turn(u, "s-cvfix"), rev: turn(u, "s-local-reviewer"), arb: turn(u, "s-arbiter") };
  attributeTurns(u, db);
  expect(attr(u, ids.author)).toEqual({ task: "T1", basis: "session" });
  expect(attr(u, ids.cv)).toEqual({ task: "T1", basis: "worker" });
  expect(attr(u, ids.rev)).toEqual({ task: "T1", basis: "worker" });
  expect(attr(u, ids.arb)).toEqual({ task: "T1", basis: "arbiter" });
  expect(usageByTask(u, "T1").reduce((s, r) => s + r.turns, 0)).toBe(4);
});

test("[验收线 1] 同一会话两处登记只计一次、以 scheduler_sessions 为准；没登记的会话不算进来", () => {
  const db = ledgerWithCards("T1", "T2");
  schedulerSession(db, "T1", "author", "s-dup");
  worker(db, "T2", "author", "s-dup"); // 同一会话又登记给别的卡：以 scheduler_sessions 为准
  arbiterRef(db, "T2", "s-dup");
  worker(db, "T1", "reviewer", "s-two");
  arbiterRef(db, "T1", "s-two"); // worker 与仲裁同指 T1：只算一次
  const u = openUsageDb(":memory:");
  const dup = turn(u, "s-dup"), two = turn(u, "s-two"), stray = turn(u, "s-stray");
  attributeTurns(u, db);
  expect(attr(u, dup)).toEqual({ task: "T1", basis: "session" });
  expect(attr(u, two)).toEqual({ task: "T1", basis: "worker" });
  expect(attr(u, stray)).toMatchObject({ task: null });
  expect(usageByTask(u, "T1").reduce((s, r) => s + r.totalTokens, 0)).toBe(2 * 110);
  expect(usageByTask(u, "T2")).toEqual([]);
});

test("worker 登记没卡、没会话，或同一会话指向两张卡：不认，照窗口判", () => {
  const db = ledgerWithCards("T1", "T2");
  worker(db, null, "other", "s-nocard");
  worker(db, "T1", "author", "");
  worker(db, "T1", "author", "s-split", T0);
  worker(db, "T2", "author", "s-split", T0 + 1);
  const u = openUsageDb(":memory:");
  const nocard = turn(u, "s-nocard"), empty = turn(u, ""), split = turn(u, "s-split");
  attributeTurns(u, db);
  for (const id of [nocard, empty, split]) expect(attr(u, id)).toMatchObject({ task: null });
});
