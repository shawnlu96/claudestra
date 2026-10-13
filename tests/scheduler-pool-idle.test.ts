import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drivePool, type PoolTickDeps } from "../src/lib/scheduler-pool-tick.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";

function fixture(mode: RecoveryMode = "on") {
  const db = new Database(":memory:");
  db.run("CREATE TABLE tasks (id TEXT, project TEXT, stage TEXT, extra TEXT)");
  db.run("INSERT INTO tasks VALUES ('T1', 'p', 'build', '{}')");
  db.run("CREATE TABLE scheduler_intents (id TEXT, taskId TEXT, project TEXT, status TEXT, updatedAt INTEGER, eventSeq INTEGER)");
  db.run("INSERT INTO scheduler_intents VALUES ('i1', 'T1', 'p', 'submitted', 10, 2)");
  db.run("CREATE TABLE events (seq INTEGER, project TEXT, target TEXT, kind TEXT, dedupKey TEXT, data TEXT)");
  db.run(`INSERT INTO events VALUES (1, 'p', 'T1', 'scheduler', 'scheduler:i1:pool', '{"orderId":"o1"}')`);
  db.run("CREATE TABLE lend_orders (orderId TEXT, taskId TEXT, project TEXT, status TEXT, step TEXT, worker TEXT, peer TEXT, wire TEXT)");
  db.run("INSERT INTO lend_orders VALUES ('o1', 'T1', 'p', 'claimed', 'write', 'w1', 'mate', '{}')");
  const task = { id: "T1", project: "p", stage: "build", extra: {} } as LedgerTask;
  const intent = { id: "i1", taskId: "T1", project: "p", status: "submitted" } as SchedulerIntent;
  let calls = 0;
  const observation = { candidates: 0, idle: 0, mismatches: 0 };
  const deps = { db, manager: async () => { calls++; return { ok: true, outcome: "claimed", text: "w1@mate 在写", orderId: "o1", intent: { status: "submitted", updatedAt: 10, eventSeq: 2 } }; },
    notifyPm: async () => {}, lost: () => (e: unknown) => { throw e; },
    recoveryPolicy: () => ({ mode, source: "config", manualAfterMs: null }), poolIdleObservation: observation };
  const drive = () => drivePool(deps as PoolTickDeps, task, intent, 2, undefined);
  return { db, task, intent, deps, observation, drive, calls: () => calls };
}

test("on: claimed + submitted outside review skips manager and preserves CLI result", async () => {
  const f = fixture();
  try { f.db.run("PRAGMA query_only = ON"); expect(await f.drive()).toEqual({ step: "pool_claimed", detail: "w1@mate 在写" }); expect(f.calls()).toBe(0); }
  finally { f.db.close(); }
});

for (const status of ["pooled", "done", "released", "unknown", "cancelled", "future"]) {
  test(`on: ${status} order still calls manager`, async () => {
    const f = fixture();
    try { f.db.run("UPDATE lend_orders SET status = ?", [status]); await f.drive(); expect(f.calls()).toBe(1); }
    finally { f.db.close(); }
  });
}
for (const scenario of ["review", "pending", "missing-order", "missing-intent", "missing-task", "missing-link", "wrong-task", "unknown-stage", "read-failure"]) {
  test(`on: ${scenario} falls back to manager`, async () => {
    const f = fixture();
    try {
      if (scenario === "review") f.db.run("UPDATE tasks SET stage = 'review'");
      if (scenario === "pending") f.db.run("UPDATE scheduler_intents SET status = 'pending'");
      if (scenario === "missing-order") f.db.run("DELETE FROM lend_orders");
      if (scenario === "missing-intent") f.db.run("DELETE FROM scheduler_intents");
      if (scenario === "missing-task") f.db.run("DELETE FROM tasks");
      if (scenario === "missing-link") f.db.run("DELETE FROM events");
      if (scenario === "wrong-task") f.db.run("UPDATE lend_orders SET taskId = 'other'");
      if (scenario === "unknown-stage") f.db.run("UPDATE tasks SET stage = 'future'");
      if (scenario === "read-failure") f.db.run("DROP TABLE tasks"); // only the idle check reads tasks; a refusal-read failure still throws as on main
      await f.drive(); expect(f.calls()).toBe(1);
    } finally { f.db.close(); }
  });
}

test("observe calls manager and records an idle receipt without writing query_only ledger", async () => {
  const f = fixture("observe");
  try {
    f.db.run("PRAGMA query_only = ON"); await f.drive(); expect(f.calls()).toBe(1);
    expect(f.observation).toEqual({ candidates: 1, idle: 1, mismatches: 0 });
  } finally { f.db.close(); }
});
test("observe records mismatch when the CLI has an action or failure", async () => {
  for (const res of [{ ok: true, outcome: "done" }, { ok: false, code: "conflict" },
    { ok: true, outcome: "claimed", orderId: "o1", text: "w1@mate 在写", intent: { status: "submitted", updatedAt: 11, eventSeq: 2 } }]) {
    const f = fixture("observe");
    try {
      let calls = 0;
      f.deps.manager = async () => { calls++; return res as never; };
      await f.drive(); expect(calls).toBe(1); expect(f.observation).toEqual({ candidates: 1, idle: 0, mismatches: 1 });
    } finally { f.db.close(); }
  }
});
test("off follows the old path and records no candidates", async () => {
  const f = fixture("off");
  try { await f.drive(); expect(f.calls()).toBe(1); expect(f.observation.candidates).toBe(0); }
  finally { f.db.close(); }
});
test("on reads fresh facts each call instead of caching a claimed order", async () => {
  const f = fixture();
  try {
    await f.drive(); expect(f.calls()).toBe(0);
    f.db.run("UPDATE lend_orders SET status = 'done'"); await f.drive(); expect(f.calls()).toBe(1);
  } finally { f.db.close(); }
});
