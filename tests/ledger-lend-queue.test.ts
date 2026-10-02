import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { closeLedger, openLedger, LEDGER_SCHEMA_VERSION } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { answerPush, pushCandidates, recordHello } from "../src/lib/ledger-lend-peers.js";
import { claimLend, getLendOrder, offerLendCore, sweepLend, WRITE_POOL_TTL_MS } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { LEND_QUEUE_SCHEMA } from "../src/lib/ledger-lend-queue-schema.js";
import { queueNoticeDue, startQueuedPush } from "../src/lib/ledger-lend-queue.js";
import { PUSH_ACK_TTL_MS, pushTtlDue } from "../src/lib/ledger-lend-peers-ttl.js";

import { createPushLoop } from "../src/lib/lend-dispatch.js";
import { runLedger } from "../src/manager/ledger.js";

let db: Database;
let now: number;
const repo = "owner/project";
const borrow = { peer: "mate", projects: ["p"], roles: ["write" as const], maxOpen: 10 };
const ctx = () => ({ actor: "owner", now });
let seq: number;
function hello(busy = 0, pause: string | null = null, ordersLeftToday = 10): void {
  recordHello(db, "mate", null, { v: 1, proto: 2, boot: "boot-0001", seq: ++seq,
    grant: { until: now + 86400000, roles: ["write"], repos: [repo], ordersPerDay: 10, ordersLeftToday },
    slots: { codex: { total: 1, busy }, claude: { total: 1, busy: 0 } }, paused: pause ? { reason: pause, until: now + 60000 } : null }, now);
}
function offer(step: "fix" | "write", auto = false): string {
  createTask(db, ctx(), { project: "p", id: "T1", title: "queue", kind: "code", spec: "spec" });
  db.prepare("UPDATE tasks SET stage = 'build', round = 1 WHERE id = 'T1'").run();
  const input = { taskId: "T1", peer: "mate", family: "codex" as const, repo, pr: null, spec: "Implement queue",
    borrow, write: { fp: "abcd-ef01-2345-6789", base: "main", baseSha: "a".repeat(40), report: null } };
  let o = offerLendCore(db, ctx(), input);
  if (step === "fix") {
    db.prepare("UPDATE lend_orders SET status = 'done' WHERE orderId = ?").run(o.orderId);
    db.prepare("UPDATE tasks SET stage = 'fix', headSHA = ?, branch = ?, round = 2 WHERE id = 'T1'").run("b".repeat(40), o.branch);
    o = offerLendCore(db, ctx(), input);
  }
  if (auto) db.prepare(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, createdAt, updatedAt)
    VALUES ('T1', 'p', 'code', 1, 'auto', 'codex', '{}', 1, ?, ?)`).run(now, now);
  return o.orderId;
}
const refuse = (id: string, code = "no_slot", peer = "mate") => answerPush(db, ctx(), peer, { accepted: [], refused: [{ orderId: id, code }] });
beforeEach(() => { db = openLedger(":memory:"); now = 1000000; seq = 0; hello(); });
afterEach(() => closeLedger(":memory:"));

for (const auto of [false, true]) test(`fix temporary refusal preserves lease; auto=${auto}`, () => {
  const id = offer("fix", auto);
  expect(refuse(id).notices).toHaveLength(1);
  expect(refuse(id).notices).toHaveLength(0);
  expect(getLendOrder(db, id)?.status).toBe("pooled");
  expect(getWriteLease(db, "T1")?.state).toBe("held");
  hello(1);
  expect(pushCandidates(db, now)).toEqual([]);
  now += WRITE_POOL_TTL_MS + 1;
  expect(pushTtlDue(db, now)).toEqual([]);
  expect(sweepLend(db, ctx())).toEqual([]);
  hello();
  expect(pushCandidates(db, now).map((c) => c.summary.orderId)).toEqual([id]);
  startQueuedPush(db, "mate", [id], now);
  expect(sweepLend(db, ctx())).toEqual([]);
  expect(claimLend(db, ctx(), "mate", { v: 1, orderId: id, worker: "worker" }, () => borrow)).toHaveProperty("lease");
  expect(getLendOrder(db, id)?.status).toBe("claimed");
});

for (const code of ["no_slot", "paused", "daily", "lender_idle"]) test(`manual build queues ${code}`, () => {
  const id = offer("write");
  expect(refuse(id, code).withdrawn).toEqual([]);
  hello(0, "codex_quota");
  expect(pushCandidates(db, now)).toEqual([]);
  hello(0, null, 0);
  expect(pushCandidates(db, now)).toEqual([]);
  now += 2 * 3600000 - 1;
  expect(sweepLend(db, ctx())).toEqual([]);
  now++;
  expect(sweepLend(db, ctx())).toHaveLength(1);
  expect(sweepLend(db, ctx())).toEqual([]);
  expect(getWriteLease(db, "T1")?.state).toBe("held");
});

for (const code of ["no_grant", "family", "role", "write_closed", "repo", "closed", "id_conflict"]) test(`permanent ${code} withdraws`, () => {
  const id = offer("fix");
  expect(refuse(id, code).withdrawn).toEqual([id]);
  expect(getWriteLease(db, "T1")?.state).toBe("ended");
});
test("auto build still withdraws", () => {
  const id = offer("write", true);
  expect(refuse(id).withdrawn).toEqual([id]);
  expect(getWriteLease(db, "T1")?.state).toBe("ended");
});
test("resumed push TTL starts once; repeated candidate listing does not extend it", () => {
  const id = offer("write");
  refuse(id);
  now += 3600000;
  hello();
  pushCandidates(db, now);
  startQueuedPush(db, "mate", [id], now);
  expect(pushTtlDue(db, now)).toEqual([]);
  now += PUSH_ACK_TTL_MS;
  pushCandidates(db, now);
  startQueuedPush(db, "mate", [id], now);
  expect(pushTtlDue(db, now)).toEqual([]);
  now++;
  expect(pushTtlDue(db, now).map((o) => o.orderId)).toEqual([id]);
  expect(sweepLend(db, ctx())).toHaveLength(1);
  expect(getWriteLease(db, "T1")?.state).toBe("ended");
});
test("foreign refusal and claimed refusal do not create queues", () => {
  const id = offer("write");
  expect(refuse(id, "no_slot", "other").notices).toEqual([]);
  claimLend(db, ctx(), "mate", { v: 1, orderId: id, worker: "worker" }, () => borrow);
  expect(refuse(id).notices).toEqual([]);
  expect(getLendOrder(db, id)?.status).toBe("claimed");
});

test("candidate and TTL reads work on a read-only connection", () => {
  const id = offer("fix");
  refuse(id);
  const file = join(mkdtempSync(join(tmpdir(), "lend-queue-reader-")), "ledger.sqlite");
  writeFileSync(file, db.serialize());
  const reader = new Database(file, { readonly: true });
  try {
    expect(pushCandidates(reader, now).map((c) => c.summary.orderId)).toEqual([id]);
    expect(pushTtlDue(reader, now + 3600000)).toEqual([]);
  } finally { reader.close(); }
});

test("real loop retries temporary refusal even when candidates never disappear; writer CLI starts resumed TTL", async () => {
  const id = offer("fix");
  let sends = 0;
  const loop = createPushLoop({
    now: () => now, candidates: (t) => pushCandidates(db, t), problem: async () => null,
    send: async (peer, body) => {
      const started = await runLedger(["lend-pushing", "--", peer, JSON.stringify(body)], {
        db, actor: "owner", now: () => now, projectIds: ["p"],
        loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
      });
      expect(started.ok).toBe(true);
      sends++;
      return { status: 200, e2e: true, body: { ok: true, v: 1, accepted: sends === 1 ? [] : [id],
        refused: sends === 1 ? [{ orderId: id, code: "no_slot" }] : [] } };
    },
    record: async (peer, body) => {
      const r = answerPush(db, ctx(), peer, body as { accepted: string[]; refused: { orderId: string; code: string }[] });
      expect(r.withdrawn).toEqual([]);
      return true;
    },
    ttlDue: (t) => pushTtlDue(db, t).length > 0, sweep: async () => { sweepLend(db, ctx()); }, log: () => {},
  });
  await loop.tick();
  expect(sends).toBe(1);
  now += 5000;
  await loop.tick();
  expect(sends).toBe(2);
  expect(getWriteLease(db, "T1")?.state).toBe("held");
  expect(db.query("SELECT queuedAt, pushedAt FROM lend_push_queue WHERE orderId = ?").get(id)).toEqual({ queuedAt: null, pushedAt: now });
});

test("resumed attempt clears old ack, new ack has its own claim TTL", () => {
  const id = offer("write");
  answerPush(db, ctx(), "mate", { accepted: [id], refused: [] });
  refuse(id);
  now += 3600000;
  hello();
  startQueuedPush(db, "mate", [id], now);
  expect(db.query("SELECT seenAt FROM lend_orders WHERE orderId = ?").get(id)).toEqual({ seenAt: null });
  now += 60000;
  answerPush(db, ctx(), "mate", { accepted: [id], refused: [] });
  now += 180000;
  expect(pushTtlDue(db, now)).toEqual([]);
  now++;
  expect(pushTtlDue(db, now).map((o) => o.orderId)).toEqual([id]);
});

test("manual reclaim/cancel stops queued overdue notices", () => {
  const id = offer("fix");
  refuse(id);
  db.prepare("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = ?").run(id);
  now += 7200000;
  expect(sweepLend(db, ctx())).toEqual([]);
});

test("queue migration repeats without changing existing rows, old reader without table remains safe", () => {
  const id = offer("fix");
  refuse(id);
  const before = db.query("SELECT * FROM lend_push_queue").all();
  LEND_QUEUE_SCHEMA(db);
  LEND_QUEUE_SCHEMA(db);
  expect(db.query("SELECT * FROM lend_push_queue").all()).toEqual(before);
  db.run("DROP TABLE lend_push_queue");
  expect(pushCandidates(db, now).map((c) => c.summary.orderId)).toEqual([id]);
  expect(pushTtlDue(db, now)).toEqual([]);
  LEND_QUEUE_SCHEMA(db);
  expect(db.query("SELECT * FROM lend_push_queue").all()).toEqual([]);
});

test("version 17 ledger upgrades to queue migration 18 without changing existing orders", () => {
  const id = offer("fix");
  const file = join(mkdtempSync(join(tmpdir(), "lend-queue-migrate-")), "ledger.sqlite");
  writeFileSync(file, db.serialize());
  const old = new Database(file);
  old.run("DROP TABLE lend_push_queue");
  old.run("PRAGMA user_version = 17");
  old.close();
  const migrated = openLedger(file);
  try {
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: LEDGER_SCHEMA_VERSION });
    expect(getLendOrder(migrated, id)).toEqual(getLendOrder(db, id));
    expect(getWriteLease(migrated, "T1")?.state).toBe("held");
    expect(migrated.query("SELECT * FROM lend_push_queue").all()).toEqual([]);
  } finally { closeLedger(file); }
});

test("late first poll cannot postpone the automatic two-hour reminder", () => {
  const id = offer("fix");
  refuse(id);
  now += 110 * 60000;
  db.prepare("UPDATE lend_orders SET seenAt = ? WHERE orderId = ?").run(now, id);
  now += 10 * 60000 - 1;
  expect(queueNoticeDue(db, now)).toBe(false);
  now++;
  expect(pushTtlDue(db, now)).toEqual([]);
  expect(queueNoticeDue(db, now)).toBe(true);
  expect(sweepLend(db, ctx())).toHaveLength(1);
  expect(queueNoticeDue(db, now)).toBe(false);
});
