import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerProbe from "../src/lib/ledger-scheduler-lease-worker.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import { beginRetire, recordSessionRetirement } from "../src/lib/scheduler-sessions.js";
import { retireStep } from "../src/lib/scheduler-retire-deps.js";
import * as retirement from "../src/lib/scheduler-retire.js";
import { retireCandidates } from "../src/lib/scheduler-retire.js";
import * as bridge from "../src/lib/bridge-client.js";
import { getIntent, type IntentStatus } from "../src/lib/ledger-scheduler.js";
import { releaseFinishedCardLeases } from "../src/lib/ledger-scheduler-lease.js";
import { reconcileFinishedCardLeases, settleFinishedWriteIntents } from "../src/lib/ledger-scheduler-lease-finished.js";
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
  const previous = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH) : null;
  writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: {} }));
  cleanup.push(() => previous ? writeFileSync(REGISTRY_PATH, previous) : rmSync(REGISTRY_PATH, { force: true }));
  const register = (name = "agent-local", status = "active", sessionId = "session-local") =>
    writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: { [name]: { status, sessionId, runtime: "codex" } } }));
  const idle = spyOn(workerProbe, "finishedWorkerIdle").mockResolvedValue(false);
  cleanup.push(() => idle.mockRestore());
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
  return { db, dir, path, plan, task, held, reclaim, notices, send, register, idle };
}

function lend(db: Database, status: string, step = "write", taskId = "C2"): void {
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

function finishRetirement(f: ReturnType<typeof fixture>): void {
  const intent = beginRetire(f.db, owner, "C2").intent;
  for (const effect of ["archive", "kill"] as const) {
    recordSessionRetirement(f.db, owner, { taskId: "C2", role: "author", intentId: intent.id, effect, receipt: effect });
  }
  settleIntent(f.db, owner, { id: intent.id, from: "submitted", to: "done", receipt: "retired" });
  expect(f.db.query("SELECT state FROM scheduler_sessions WHERE taskId = 'C2'").get()).toEqual({ state: "retired" });
}

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

  for (const status of ["pooled", "claimed", "unknown"]) {
    test(`a same-card ${status} write protects an unknown intent; PM gets one notice across connections`, async () => {
      const f = fixture("unknown");
      lend(f.db, status, status === "claimed" ? "fix" : "write");
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
    test(`a busy local ${state} author protects unknown until idle`, async () => {
      const f = fixture("unknown");
      session(f.db, state);
      f.register();
      f.reclaim(); f.reclaim();
      await drain();
      expect(getIntent(f.db, "pool:C2")?.status).toBe("unknown");
      expect(f.held()).toContainEqual({ resource: "src/shared.ts" });
      expect(f.notices).toHaveLength(1);
      f.idle.mockResolvedValue(true);
      f.reclaim();
      await drain();
      expect(f.held()).toEqual([]);
    });
  }

  for (const stage of ["verified", "done", "live", "cancelled"]) {
    for (const status of ["pending", "submitted", "unknown"] as const) {
      test(`idle active author: ${stage}/${status} settles before retirement and unblocks C6`, async () => {
        const f = fixture(status, stage);
        session(f.db);
        f.register();
        f.idle.mockResolvedValue(true);
        f.reclaim();
        expect(f.held()).toHaveLength(2);
        await drain();
        expect(getIntent(f.db, "pool:C2")?.status).toBe("cancelled");
        expect(f.held()).toEqual([]);
        if (stage !== "live") {
          expect(retireCandidates(f.db, ["p"])).toContain("C2");
          finishRetirement(f);
        }
        expect(f.plan("C6", "next:C6").intent.status).toBe("pending");
        expect(f.notices).toHaveLength(0);
      });
    }
  }

  test("production retire ticks retry a busy worker, settle when idle, and never duplicate events or PM notices", async () => {
    const f = fixture();
    session(f.db);
    f.register();
    const retire = spyOn(retirement, "schedulerRetireTick").mockImplementation(async (db) => {
      if (f.idle.mock.calls.length >= 3) expect(getIntent(db, "pool:C2")?.status).toBe("cancelled");
      return { cards: [], failed: [] };
    });
    cleanup.push(() => retire.mockRestore());
    const config = { enabled: true, pollMs: 5000, autoDispatch: false,
      projects: { p: { maxActiveWorkers: 1, requiredChecks: [], repoDir: f.dir } } };
    const tick = () => retireStep(f.db, config, async () => ({ ok: true }), () => {}, undefined);
    const eventsBefore = listEvents(f.db, { target: "C2" }).length;
    await tick(); await tick();
    await drain();
    expect(f.held()).toHaveLength(2);
    expect(listEvents(f.db, { target: "C2" })).toHaveLength(eventsBefore);
    expect(f.notices).toHaveLength(1);
    f.idle.mockResolvedValue(true);
    await tick(); await tick();
    expect(f.held()).toEqual([]);
    expect(listEvents(f.db, { target: "C2" })).toHaveLength(eventsBefore + 1);
    expect(retire).toHaveBeenCalledTimes(4);
  });

  for (const source of ["worker", "unknown-order"]) {
    test(`cancelled card with ${source} stays out of retirement until the next idle tick`, async () => {
      const f = fixture("submitted", "cancelled");
      session(f.db);
      f.register();
      if (source === "unknown-order") { lend(f.db, "unknown"); f.idle.mockResolvedValue(true); }
      await reconcileFinishedCardLeases(f.db, ["p"], () => {});
      expect(retireCandidates(f.db, ["p"])).toEqual([]);
      expect(f.held()).toHaveLength(2);
      expect(getIntent(f.db, "pool:C2")?.status).toBe("submitted");
      f.idle.mockResolvedValue(true);
      if (source === "unknown-order") f.db.query("UPDATE lend_orders SET status = 'done'").run();
      await reconcileFinishedCardLeases(f.db, ["p"], () => {});
      expect(retireCandidates(f.db, ["p"])).toEqual(["C2"]);
      finishRetirement(f);
      expect(f.held()).toEqual([]);
    });
  }

  test("a scheduler losing ownership during a probe cannot settle or release", async () => {
    const f = fixture();
    session(f.db);
    f.register();
    let finish!: (idle: boolean) => void;
    f.idle.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let active = true;
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    cleanup.push(() => errors.mockRestore());
    const tick = reconcileFinishedCardLeases(f.db, ["p"], () => { if (!active) throw new Error("lease lost"); });
    const rejected = tick.then(() => null, (error: Error) => error);
    await drain();
    active = false;
    finish(true);
    expect((await rejected)?.message).toBe("lease lost");
    expect(getIntent(f.db, "pool:C2")?.status).toBe("submitted");
    expect(f.held()).toHaveLength(2);
    expect(f.notices).toHaveLength(0);
  });

  test("runtime timeout holds locks and notifies once; the next attempt can settle an idle worker", async () => {
    const f = fixture();
    session(f.db);
    f.idle.mockRestore();
    writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: {
      "agent-local": { status: "active", sessionId: "session-local", transport: "acp" },
    } }));
    const query = spyOn(bridge, "bridgeRequest").mockRejectedValue(new Error("Bridge 请求超时"));
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    cleanup.push(() => query.mockRestore(), () => errors.mockRestore());
    for (let i = 0; i < 2; i++) { f.reclaim(); await drain(); }
    expect(getIntent(f.db, "pool:C2")?.status).toBe("submitted");
    expect(f.held()).toHaveLength(2);
    expect(f.notices).toHaveLength(1);
    query.mockResolvedValue({ turns: { "agent-local": "idle" } });
    f.reclaim();
    await drain();
    expect(getIntent(f.db, "pool:C2")?.status).toBe("cancelled");
    expect(f.held()).toEqual([]);
  });

  for (const field of ["agent", "recipient"]) {
    test(`an idle manual ${field} registered active no longer holds the card`, async () => {
      const f = fixture();
      if (field === "agent") f.db.query("UPDATE tasks SET agent = 'manual' WHERE id = 'C2'").run();
      else f.db.query("UPDATE scheduler_intents SET recipient = 'manual' WHERE id = 'pool:C2'").run();
      f.register("agent-manual");
      f.idle.mockResolvedValue(true);
      f.reclaim();
      await drain();
      expect(f.held()).toEqual([]);
    });
  }

  for (const change of ["stage", "intent", "lease-owner", "lease-removed", "session", "registry", "new-order"]) {
    test(`async idle proof is rejected after a concurrent ${change} change; probe holds no write lock`, async () => {
      const f = fixture();
      session(f.db);
      f.register();
      let finish!: (idle: boolean) => void;
      f.idle.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      f.reclaim();
      await drain();
      expect(f.idle).toHaveBeenCalledTimes(1);
      const other = new Database(f.path);
      try {
        other.transaction(() => {
          if (change === "stage") other.query("UPDATE tasks SET stage = 'fix' WHERE id = 'C2'").run();
          if (change === "intent") other.query("UPDATE scheduler_intents SET status = 'done' WHERE id = 'pool:C2'").run();
          if (change === "lease-owner") other.query("UPDATE scheduler_resources SET taskId = 'C6' WHERE resource = 'src/shared.ts'").run();
          if (change === "lease-removed") other.query("DELETE FROM scheduler_resources WHERE taskId = 'C2'").run();
          if (change === "session") other.query("UPDATE scheduler_sessions SET sessionId = 'new-session'").run();
          if (change === "registry") f.register("agent-local", "active", "new-session");
          if (change === "new-order") lend(other, "claimed");
        }).immediate();
      } finally { other.close(); }
      const resources = f.db.query("SELECT * FROM scheduler_resources ORDER BY resource").all();
      finish(true);
      await drain();
      expect(getIntent(f.db, "pool:C2")?.status).toBe(change === "intent" ? "done" : "submitted");
      expect(f.db.query("SELECT * FROM scheduler_resources ORDER BY resource").all()).toEqual(resources);
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

  test("a cleared hold notifies again after reopening, and an old acknowledgement cannot mark the new notice", async () => {
    const f = fixture();
    lend(f.db, "claimed");
    let acknowledge!: (value: { ok: true; result: {} }) => void;
    f.send.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    f.reclaim();
    await drain();
    f.db.query("UPDATE lend_orders SET status = 'done'").run();
    f.reclaim();
    expect(f.held()).toEqual([]);
    f.db.query("UPDATE tasks SET stage = 'fix' WHERE id = 'C2'").run();
    f.plan("C2", "second:C2");
    f.db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'C2'").run();
    f.db.query("UPDATE lend_orders SET status = 'claimed'").run();
    let acknowledgeNew!: (value: { ok: false; sent: boolean; error: string }) => void;
    f.send.mockImplementationOnce(() => new Promise((resolve) => { acknowledgeNew = resolve; }));
    f.reclaim();
    await drain();
    acknowledge({ ok: true, result: {} });
    await drain();
    const row = f.db.query("SELECT value FROM scheduler_meta WHERE key = 'finished-card-lease-notice:C2'").get() as { value: string };
    expect(JSON.parse(row.value).state).toBe("sending");
    const errors = spyOn(console, "error").mockImplementation(() => undefined);
    cleanup.push(() => errors.mockRestore());
    acknowledgeNew({ ok: false, sent: false, error: "offline" });
    await drain();
    f.reclaim(); f.reclaim();
    await drain();
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.notices).toHaveLength(1);
    expect(getIntent(f.db, "second:C2")?.status).toBe("pending");
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
    f.register();
    expect(() => f.db.transaction(() => { f.reclaim(); throw new Error("rollback"); })()).toThrow("rollback");
    await drain();
    expect(f.notices).toHaveLength(0);
    expect(f.idle).not.toHaveBeenCalled();
  });

  test("hold notification survives the CLI closing its ledger before the microtask", async () => {
    const f = fixture();
    session(f.db);
    f.register();
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
    f.register();
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
