import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as bridge from "../src/lib/bridge-client.js";
import { getIntent, type IntentStatus } from "../src/lib/ledger-scheduler.js";
import { releaseFinishedCardLeases } from "../src/lib/ledger-scheduler-lease.js";
import { settleFinishedWriteIntents } from "../src/lib/ledger-scheduler-lease-finished.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";

const owner = { actor: "owner", now: 10 };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture(status: IntentStatus = "submitted", stage = "verified") {
  const dir = mkdtempSync(join(tmpdir(), "finished-leases-"));
  const path = join(dir, "ledger.sqlite");
  const db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const seq = () => (db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  const plan = (taskId: string, id: string) => planIntent(db, owner, {
    id, taskId, taskRev: 1, workflowRev: 1, causalSeq: seq(), node: "write", action: "dispatch",
    recipient: "peer:mate", reason: "pool write", resources: ["task:write", "src/shared.ts"],
  });
  for (const id of ["C2", "C6"]) {
    createTask(db, owner, { project: "p", id, title: id, kind: "code" });
    setWorkflow(db, owner, { taskId: id, taskRev: 1, template: "code", templateVersion: 2,
      mode: "auto", authorFamily: "codex", fallback: "交 PM" });
  }
  plan("C2", "pool:C2");
  db.query("UPDATE scheduler_intents SET status = ? WHERE id = 'pool:C2'").run(status);
  db.query("UPDATE tasks SET stage = ? WHERE id = 'C2'").run(stage);
  const task = () => getTask(db, "C2")!;
  const held = () => db.query("SELECT resource FROM scheduler_resources WHERE taskId = 'C2' ORDER BY resource").all();
  const reclaim = () => releaseFinishedCardLeases(db, "C2");
  const notices: Record<string, unknown>[] = [];
  const send = spyOn(bridge, "bridgeSend").mockImplementation(async (message) => { notices.push(message); return { ok: true, result: {} }; });
  cleanup.push(() => send.mockRestore());
  setMeta(db, owner, { project: "p", key: "pms", value: ["agent-pm"] });
  return { db, dir, path, plan, task, held, reclaim, notices, send };
}

function lend(db: Database, status: string, step = "write", taskId = "C2"): void {
  // running is accepted by newer peers; the current on-disk enum only permits claimed, so test that projection separately.
  db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo,
    wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt)
    VALUES (?, ?, 'p', 'mate', 'codex', ?, 1, 0, 'head', 'o/r', '{}', 'spec', 'hash', ?, 100, 'owner', 10, 10)`)
    .run(`newer:${taskId}`, taskId, step, status);
}

function session(db: Database, state = "active", role = "author", transport = "tmux"): void {
  db.prepare(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('C2', ?, 'agent-local', 'session-local', 'codex', ?, ?, 'pool:C2', 10, 10)`).run(role, transport, state);
}

const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("finished-card residual write leases", () => {
  for (const stage of ["verified", "cancelled", "live", "done"]) {
    for (const status of ["pending", "submitted", "unknown"] as const) {
      test(`${stage} + orphan ${status} is cancelled, audited, and C6 can acquire C2's file`, () => {
        const f = fixture(status, stage);
        expect(() => f.plan("C6", "next:C6")).toThrow(/C2 占用/);
        f.reclaim();
        expect(getIntent(f.db, "pool:C2")).toMatchObject({ status: "cancelled", receipt: expect.stringContaining(`卡已 ${stage}`) });
        expect(f.held()).toEqual([]);
        const events = () => listEvents(f.db, { target: "C2" }).filter((e) => e.data.finishedCard);
        expect(events()).toHaveLength(1);
        expect(events()[0]?.data).toMatchObject({ op: "settle", from: status, to: "cancelled" });
        f.reclaim();
        expect(events()).toHaveLength(1);
        expect(f.plan("C6", "next:C6").intent.status).toBe("pending");
        expect(f.notices).toHaveLength(0);
      });
    }
  }

  for (const to of ["live", "cancelled"] as const) {
    test(`stage transition to ${to} cleans up in its own transaction`, () => {
      const f = fixture("submitted", "merge");
      moveStage(f.db, owner, { taskId: "C2", from: "merge", to });
      expect(getIntent(f.db, "pool:C2")?.status).toBe("cancelled");
      expect(f.held()).toEqual([]);
    });
  }

  for (const status of ["pooled", "claimed", "running"]) {
    test(`a same-card ${status} write protects an unknown intent; PM gets one notice across connections`, async () => {
      const f = fixture("unknown");
      if (status === "running") {
        f.db.run("DROP TABLE lend_orders");
        f.db.run("CREATE TABLE lend_orders (orderId TEXT, taskId TEXT, step TEXT, status TEXT)");
        f.db.run("INSERT INTO lend_orders VALUES ('newer:C2', 'C2', 'write', 'running')");
      } else lend(f.db, status, status === "claimed" ? "fix" : "write");
      f.reclaim(); f.reclaim();
      await drain();
      const second = new Database(f.path);
      try { releaseFinishedCardLeases(second, "C2"); await drain(); } finally { second.close(); }
      expect(getIntent(f.db, "pool:C2")?.status).toBe("unknown");
      expect(f.held()).toContainEqual({ resource: "src/shared.ts" });
      expect(() => f.plan("C6", "next:C6")).toThrow(/C2 占用/);
      expect(f.notices).toHaveLength(1);
      expect(f.notices[0]).toMatchObject({ targetName: "agent-pm", text: expect.stringContaining("newer:C2"), oneShot: true });
      f.db.query("UPDATE lend_orders SET status = 'done' WHERE taskId = 'C2'").run();
      f.reclaim();
      expect(getIntent(f.db, "pool:C2")?.status).toBe("cancelled");
      expect(f.held()).toEqual([]);
    });
  }

  for (const state of ["active", "retiring"]) {
    test(`a local ${state} author protects unknown until retirement`, async () => {
      const f = fixture("unknown");
      session(f.db, state);
      f.reclaim(); f.reclaim();
      await drain();
      expect(getIntent(f.db, "pool:C2")?.status).toBe("unknown");
      expect(f.held()).toContainEqual({ resource: "src/shared.ts" });
      expect(f.notices).toHaveLength(1);
      f.db.query("UPDATE scheduler_sessions SET state = 'retired'").run();
      f.reclaim();
      expect(f.held()).toEqual([]);
    });
  }

  test("manual takeover worker and old intent recipient protect the whole card; corrupt registry cannot prove absence", async () => {
    const f = fixture("unknown");
    const registryPath = join(f.dir, "registry.json");
    f.db.query("UPDATE tasks SET agent = 'manual' WHERE id = 'C2'").run();
    f.db.query("UPDATE scheduler_intents SET recipient = 'old-worker' WHERE id = 'pool:C2'").run();
    for (const [name, status] of [["agent-manual", "creating"], ["agent-old-worker", "active"]]) {
      writeFileSync(registryPath, JSON.stringify({ agents: { [name!]: { status } } }));
      settleFinishedWriteIntents(f.db, f.task(), { registryPath });
      expect(getIntent(f.db, "pool:C2")?.status).toBe("unknown");
    }
    writeFileSync(registryPath, "{broken");
    settleFinishedWriteIntents(f.db, f.task(), { registryPath });
    expect(getIntent(f.db, "pool:C2")?.status).toBe("unknown");
    await drain();
    expect(f.notices).toHaveLength(1);
    writeFileSync(registryPath, JSON.stringify({ agents: { "agent-manual": { status: "archived" } } }));
    settleFinishedWriteIntents(f.db, f.task(), { registryPath });
    f.reclaim();
    expect(f.held()).toEqual([]);
  });

  for (const condition of ["review-order", "other-card", "finished-order", "peer-session", "reviewer", "retired"]) {
    test(`${condition} does not count as an active writer of C2`, () => {
      const f = fixture();
      if (condition === "review-order") lend(f.db, "claimed", "review");
      if (condition === "other-card") lend(f.db, "claimed", "write", "C6");
      if (condition === "finished-order") lend(f.db, "done");
      if (condition === "peer-session") session(f.db, "active", "author", "peer");
      if (condition === "reviewer") session(f.db, "active", "reviewer");
      if (condition === "retired") session(f.db, "retired");
      f.reclaim();
      expect(f.held()).toEqual([]);
      expect(getIntent(f.db, "pool:C2")?.status).toBe("cancelled");
    });
  }

  test("all orphan write/fix intents settle, while non-write intents keep their locks", () => {
    const f = fixture("unknown");
    f.db.query(`INSERT INTO scheduler_intents SELECT 'fix:C2', taskId, project, 'fix', action, recipient, causalSeq, eventSeq,
      taskRev, specRev, head, templateVersion, status, attempts, receipt, reason, createdAt, updatedAt FROM scheduler_intents WHERE id = 'pool:C2'`).run();
    f.reclaim();
    expect(getIntent(f.db, "fix:C2")?.status).toBe("cancelled");
    expect(f.held()).toEqual([]);
    f.plan("C6", "review:C6");
    f.db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'C6'").run();
    f.db.query("UPDATE scheduler_intents SET action = 'review' WHERE id = 'review:C6'").run();
    releaseFinishedCardLeases(f.db, "C6");
    expect(getIntent(f.db, "review:C6")?.status).toBe("pending");
    expect(f.db.query("SELECT taskId FROM scheduler_resources WHERE resource = 'src/shared.ts'").get()).toEqual({ taskId: "C6" });
  });

  test("non-terminal unknown writes still require PM settlement", () => {
    const f = fixture("unknown", "merge");
    f.reclaim();
    expect(getIntent(f.db, "pool:C2")?.status).toBe("unknown");
    expect(f.held()).toContainEqual({ resource: "src/shared.ts" });
    expect(() => settleIntent(f.db, { actor: "scheduler" }, { id: "pool:C2", from: "unknown", to: "cancelled", receipt: "x" })).toThrow(/只有 PM/);
  });

  test("a terminal snapshot cannot cancel a write after the card has returned to fix", () => {
    const f = fixture();
    const snapshot = f.task();
    f.db.query("UPDATE tasks SET stage = 'fix' WHERE id = 'C2'").run();
    settleFinishedWriteIntents(f.db, snapshot);
    expect(getIntent(f.db, "pool:C2")?.status).toBe("submitted");
    expect(f.held()).toHaveLength(2);
  });

  test("rollback restores intent, event and leases, and never sends a rolled-back hold notice", async () => {
    const f = fixture();
    const before = listEvents(f.db, { target: "C2" }).length;
    expect(() => f.db.transaction(() => { f.reclaim(); throw new Error("rollback"); })()).toThrow("rollback");
    expect(getIntent(f.db, "pool:C2")?.status).toBe("submitted");
    expect(f.held()).toHaveLength(2);
    expect(listEvents(f.db, { target: "C2" })).toHaveLength(before);
    session(f.db);
    expect(() => f.db.transaction(() => { f.reclaim(); throw new Error("rollback"); })()).toThrow("rollback");
    await drain();
    expect(f.notices).toHaveLength(0);
  });

  test("hold notification survives the CLI closing its ledger before the microtask", async () => {
    const f = fixture();
    session(f.db);
    f.reclaim();
    closeLedger(f.path);
    await drain();
    expect(f.notices).toHaveLength(1);
    const reopened = openLedger(f.path);
    releaseFinishedCardLeases(reopened, "C2");
    await drain();
    expect(f.notices).toHaveLength(1);
  });

  for (const sent of [false, true]) {
    test(`notification failure with sent=${sent} only retries a definite non-delivery`, async () => {
      const f = fixture();
      session(f.db);
      const errors = spyOn(console, "error").mockImplementation(() => undefined);
      cleanup.push(() => errors.mockRestore());
      f.send.mockImplementationOnce(async () => ({ ok: false, sent, error: "connection lost" }));
      f.reclaim();
      await drain();
      expect(errors).toHaveBeenCalled();
      f.reclaim();
      await drain();
      expect(f.send).toHaveBeenCalledTimes(sent ? 1 : 2);
      expect(f.notices).toHaveLength(sent ? 0 : 1);
      expect(getIntent(f.db, "pool:C2")?.status).toBe("submitted");
      expect(f.held()).toContainEqual({ resource: "src/shared.ts" });
    });
  }
});
