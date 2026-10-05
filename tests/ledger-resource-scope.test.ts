import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileFileScope } from "../src/lib/ledger-resource-scope.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { holdWriteLease } from "../src/lib/ledger-lend-lease.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0)) f(); });
function fixture(ran = false) {
  const dir = mkdtempSync(join(tmpdir(), "rlock-unit-")), path = join(dir, "ledger.sqlite"), registryPath = join(dir, "registry.json");
  const db = openLedger(path), ctx = { actor: "owner", now: 100 };
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(registryPath, JSON.stringify({ agents: {} }));
  createTask(db, ctx, { project: "p", id: "T", title: "paused", kind: "code", extra: { fileGlobs: ["a.ts", "b.ts", "c.ts"] } });
  const configure = (mode: "auto" | "manual", workflowRev: number) => setWorkflow(db, ctx, {
    taskId: "T", taskRev: 1, workflowRev, template: "code", templateVersion: 2, mode, authorFamily: "claude", fallback: "wait", reason: "PM pause",
  });
  configure("auto", 0);
  const seq = (db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  planIntent(db, ctx, { id: "real-plan", taskId: "T", taskRev: 1, workflowRev: 1, causalSeq: seq, action: "dispatch", node: "write", reason: "claim",
    recipient: ran ? "agent-w" : undefined, resources: ["a.ts", "b.ts", "c.ts", "slot:p:0", "merge:p", "deploy:p", "task:t"] });
  if (ran) {
    settleIntent(db, ctx, { id: "real-plan", from: "pending", to: "submitted" });
    settleIntent(db, ctx, { id: "real-plan", from: "submitted", to: "done" });
  } else settleIntent(db, ctx, { id: "real-plan", from: "pending", to: "cancelled" });
  configure("manual", 1);
  const scope = (files: string[]) => setTask(db, ctx, { id: "T", rev: getTask(db, "T")!.rev, patch: { extra: { fileGlobs: files } } });
  const input = () => ({ taskId: "T", project: "p", taskRev: getTask(db, "T")!.rev, workflowRev: 2, reason: "PM approved scope", registryPath });
  const snapshot = () => ["tasks", "task_workflows", "scheduler_intents", "scheduler_resources", "scheduler_sessions", "lend_orders", "lend_write_leases", "events"]
    .map(table => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  return { db, dir, path, registryPath, ctx, scope, input, snapshot };
}

test("pause, narrow, release all, restore registered scope and replay: only file claims change", () => {
  const f = fixture(true);
  f.scope(["a.ts"]);
  const before = f.snapshot(), dry = reconcileFileScope(f.db, f.ctx, f.input());
  expect(dry).toMatchObject({ dryRun: true, executable: true, old: ["a.ts", "b.ts", "c.ts"], target: ["a.ts"], remove: ["b.ts", "c.ts"] });
  expect(f.snapshot()).toEqual(before);
  expect(reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toMatchObject({ duplicate: false });
  const once = f.snapshot();
  expect(reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toMatchObject({ duplicate: true });
  expect(f.snapshot()).toEqual(once);
  f.scope([]);
  reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true });
  f.scope(["a.ts", "b.ts"]);
  expect(reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toMatchObject({ add: ["a.ts", "b.ts"], remove: [] });
  expect(f.db.query("SELECT resource FROM scheduler_resources ORDER BY resource").all()).toEqual(
    ["a.ts", "b.ts", "deploy:p", "merge:p", "slot:p:0"].map(resource => ({ resource })));
  expect(f.db.query("SELECT DISTINCT intentId FROM scheduler_resources").all()).toEqual([{ intentId: "real-plan" }]);
});

test.each(["pending", "submitted", "unknown", "corrupt"])("unsettled or unknown intent %s refuses with no writes", status => {
  const f = fixture(); f.scope([]);
  f.db.exec("PRAGMA ignore_check_constraints = ON");
  f.db.query("UPDATE scheduler_intents SET status = ?").run(status);
  const before = f.snapshot();
  expect(reconcileFileScope(f.db, f.ctx, f.input())).toMatchObject({ executable: false });
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/意图/);
  expect(f.snapshot()).toEqual(before);
});

test.each(["agent-outsider", "scheduler"])("role %s refused before writes", actor => {
  const f = fixture(), before = f.snapshot();
  expect(() => reconcileFileScope(f.db, { actor }, { ...f.input(), apply: true })).toThrow(/本项目/);
  expect(f.snapshot()).toEqual(before);
});

test("project PM and master can apply, dispatcher in the PM list cannot", () => {
  const f = fixture();
  setMeta(f.db, f.ctx, { project: "p", key: "pms", value: ["agent-pm", "agent-dispatch"] });
  setMeta(f.db, f.ctx, { project: "p", key: "team", value: { dispatcher: "agent-dispatch", audit: true } });
  f.scope(["a.ts"]);
  expect(() => reconcileFileScope(f.db, { actor: "agent-dispatch" }, { ...f.input(), apply: true })).toThrow(/本项目/);
  expect(reconcileFileScope(f.db, { actor: "agent-pm" }, { ...f.input(), apply: true })).toMatchObject({ ok: true });
  f.scope([]);
  expect(reconcileFileScope(f.db, { actor: "master" }, { ...f.input(), apply: true })).toMatchObject({ ok: true });
});

test("project mismatch, stale CAS, malformed scope and missing registry fail closed", () => {
  const f = fixture(); f.scope([]);
  const before = f.snapshot();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), project: "other", apply: true })).toThrow(/本项目/);
  for (const patch of [{ taskRev: 0 }, { workflowRev: 0 }]) {
    expect(reconcileFileScope(f.db, f.ctx, { ...f.input(), ...patch })).toMatchObject({ executable: false });
    expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), ...patch, apply: true })).toThrow(/CAS/);
  }
  expect(f.snapshot()).toEqual(before);
  for (const raw of ["{", "[]", '{"agents":{"bad":null}}']) {
    writeFileSync(f.registryPath, raw);
    expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/registry/);
  }
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), registryPath: f.dir, apply: true })).toThrow(/registry/);
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), registryPath: join(f.dir, "absent"), apply: true })).toThrow(/registry/);
  for (const extra of [{}, { fileGlobs: ["slot:p:1"] }, { fileGlobs: [42] }]) {
    f.db.query("UPDATE tasks SET extra = ? WHERE id = 'T'").run(JSON.stringify(extra));
    expect(reconcileFileScope(f.db, f.ctx, f.input())).toMatchObject({ executable: false });
    expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/fileGlobs/);
  }
});

test.each(["active", "creating", "stopped", "unknown"])("registry author %s cannot be dismissed by status alone", status => {
  const f = fixture(); f.scope([]);
  writeFileSync(f.registryPath, JSON.stringify({ agents: { "agent-writer": { task: "T", status, sessionId: "s" } } }));
  const before = f.snapshot();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/registry 作者/);
  expect(f.snapshot()).toEqual(before);
});

test.each(["tmux", "peer"])("active %s author and fake retired binding refuse", transport => {
  const f = fixture(); f.scope([]);
  f.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('T', 'author', 'agent-old', 's', 'claude', ?, 'active', 'real-plan', 1, 2)`).run(transport);
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/退役/);
  f.db.query("UPDATE scheduler_sessions SET state = 'retired', archiveReceipt = 'made up', killReceipt = 'made up'").run();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/退役/);
});

test.each(["agent", "peer"])("unfinished %s step without a scheduler session still prevents release", kind => {
  const f = fixture(); f.scope([]);
  f.db.query(`INSERT INTO task_steps (taskId, step, executor, executorKind, state, createdAt, updatedAt)
    VALUES ('T', 'write', 'writer', ?, 'assigned', 1, 1)`).run(kind);
  const before = f.snapshot();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/作者步骤未结/);
  expect(f.snapshot()).toEqual(before);
});

test.each(["recipient", "agent", "assignee", "done-step", "attempted-cancelled"])(
  "historical %s without session bindings permits reconciliation", source => {
    const f = fixture(true); f.scope([]);
    if (source === "agent" || source === "assignee") f.db.query(`UPDATE tasks SET ${source} = 'agent-w' WHERE id = 'T'`).run();
    if (source === "done-step") f.db.query(`INSERT INTO task_steps (taskId, step, executor, executorKind, state, createdAt, updatedAt)
      VALUES ('T', 'write', 'writer@fake-peer', 'peer', 'done', 1, 1)`).run();
    if (source === "attempted-cancelled") f.db.query("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = 'real-plan'").run();
    const before = f.snapshot();
    expect(f.db.query("SELECT * FROM scheduler_sessions").all()).toEqual([]);
    expect(reconcileFileScope(f.db, f.ctx, f.input())).toMatchObject({ executable: true, reasons: [] });
    expect(f.snapshot()).toEqual(before);
    expect(reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toMatchObject({ ok: true, remove: ["a.ts", "b.ts", "c.ts"] });
  },
);

test.each(["assigned", "delivered", "unknown"])("explicit author step %s is not merely a historical name", state => {
  const f = fixture(true); f.scope([]);
  f.db.exec("PRAGMA ignore_check_constraints = ON");
  f.db.query(`INSERT INTO task_steps (taskId, step, executor, executorKind, state, createdAt, updatedAt)
    VALUES ('T', 'fix', 'agent-w', 'agent', ?, 1, 1)`).run(state);
  const before = f.snapshot();
  expect(reconcileFileScope(f.db, f.ctx, f.input())).toMatchObject({ executable: false });
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/作者步骤/);
  expect(f.snapshot()).toEqual(before);
});

test.each(["active", "creating", "stopped", "unknown"])("historical recipient still checks registry liveness: %s", status => {
  const f = fixture(true); f.scope([]);
  writeFileSync(f.registryPath, JSON.stringify({ agents: { w: { status, sessionId: "old-session" } } }));
  const before = f.snapshot();
  expect(reconcileFileScope(f.db, f.ctx, f.input())).toMatchObject({ executable: false });
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/registry 作者/);
  expect(f.snapshot()).toEqual(before);
});

test("lost claims cannot be silently reconstructed; a foreign overlapping claim blocks even release", () => {
  const f = fixture(); f.scope([]);
  f.db.query("DELETE FROM scheduler_resources WHERE resource = 'b.ts'").run();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/失锁/);
  createTask(f.db, f.ctx, { project: "p", id: "U", title: "other", kind: "code" });
  f.db.query("UPDATE scheduler_resources SET taskId = 'U' WHERE resource = 'c.ts'").run();
  f.scope(["c.ts"]);
  const before = f.snapshot(), dry = reconcileFileScope(f.db, f.ctx, f.input());
  expect(dry.conflicts).toContainEqual({ resource: "c.ts", held: "c.ts", taskId: "U" });
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/失锁/);
  expect(f.snapshot()).toEqual(before);
});

test.each(["delete", "insert", "audit"])("%s fault rolls back deletions, insertions and audit together", fault => {
  const f = fixture(); f.scope(["a.ts"]);
  reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true });
  f.scope(["b.ts"]);
  const table = fault === "audit" ? "events" : "scheduler_resources";
  const trigger = fault === "delete" ? `DELETE ON ${table} WHEN OLD.resource = 'a.ts'` : `INSERT ON ${table}`;
  f.db.exec(`CREATE TRIGGER fail_scope BEFORE ${trigger} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  const before = f.snapshot();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/injected failure/);
  expect(f.snapshot()).toEqual(before);
});

test.each(["pooled", "claimed", "unknown", "broken"])("lend order %s prevents reconciliation without withdrawal", status => {
  const f = fixture(); f.scope([]);
  f.db.exec("PRAGMA ignore_check_constraints = ON");
  f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256,
    status, leaseMs, createdBy, createdAt, updatedAt) VALUES ('order', 'T', 'p', 'fake', 'codex', 'write', 1, 0, 'h', 'a/b', '{}', '', '', ?, 1, 'owner', 1, 1)`)
    .run(status);
  const before = f.snapshot();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/出借单/);
  expect(f.snapshot()).toEqual(before);
});

test("held write lease is never ended; intent file and special card resources are preserved", () => {
  const f = fixture(); f.scope([]);
  f.db.query(`INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope)
    VALUES ('p', 'intent.ts', 'T', 'real-plan', 5, 'intent'), ('p', 'task:t', 'T', 'real-plan', 6, 'card')`).run();
  const preserved = f.db.query("SELECT * FROM scheduler_resources WHERE resource LIKE '%:%' OR scope = 'intent' ORDER BY resource").all();
  holdWriteLease(f.db, getTask(f.db, "T")!, { peer: "fake", fp: "0000-0000-0000-0000", branch: "work", repo: "a/b" }, 20);
  const before = f.snapshot();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/写租约/);
  expect(f.snapshot()).toEqual(before);
  f.db.query("UPDATE lend_write_leases SET state = 'ended', reason = 'formal prior takeover'").run();
  reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true });
  expect(f.db.query("SELECT * FROM scheduler_resources ORDER BY resource").all()).toEqual(preserved);
});

test("missing provenance, existing overlaps, new overlaps and same-card intent locks all refuse", () => {
  const f = fixture(); f.scope(["new/*.ts"]);
  createTask(f.db, f.ctx, { project: "p", id: "U", title: "other", kind: "code" });
  f.db.query(`INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope)
    VALUES ('p', 'new/a.ts', 'U', 'real-plan', 1, 'card')`).run();
  expect(reconcileFileScope(f.db, f.ctx, f.input()).conflicts.length).toBe(1);
  f.db.query("UPDATE scheduler_resources SET taskId = 'T', scope = 'intent' WHERE resource = 'new/a.ts'").run();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/冲突/);
  f.db.query("UPDATE scheduler_resources SET taskId = 'U', resource = '*.ts' WHERE resource = 'new/a.ts'").run();
  f.scope([]);
  expect(reconcileFileScope(f.db, f.ctx, f.input()).conflicts.length).toBe(3);
  f.db.query("DELETE FROM scheduler_resources WHERE taskId = 'U'").run();
  f.db.query("UPDATE scheduler_intents SET eventSeq = 0").run();
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/锚点/);
});

test("a newly approved file must not borrow an unrelated dispatch anchor", () => {
  const f = fixture(); f.scope(["new.ts"]);
  const before = f.snapshot();
  expect(reconcileFileScope(f.db, f.ctx, f.input())).toMatchObject({ executable: false, add: ["new.ts"] });
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/来源/);
  expect(f.snapshot()).toEqual(before);
});

test.each([false, true])("later dispatch preserves held anchors or records actual reacquisition: released=%j", released => {
  const f = fixture();
  // Model a prior release; planIntent itself must acquire the replacement, never hand-insert a claim.
  if (released) f.db.query("DELETE FROM scheduler_resources WHERE scope = 'card'").run();
  setWorkflow(f.db, f.ctx, { taskId: "T", taskRev: 1, workflowRev: 2, template: "code", templateVersion: 2,
    mode: "auto", authorFamily: "claude", fallback: "wait", reason: "resume" });
  const causalSeq = (f.db.query("SELECT MAX(seq) AS n FROM events").get() as { n: number }).n;
  planIntent(f.db, { ...f.ctx, now: 200 }, { id: "reacquire", taskId: "T", taskRev: 1, workflowRev: 3, causalSeq,
    action: "dispatch", node: "write", reason: "new acquisition", resources: ["a.ts", "b.ts", "c.ts"] });
  settleIntent(f.db, f.ctx, { id: "reacquire", from: "pending", to: "cancelled" });
  setWorkflow(f.db, f.ctx, { taskId: "T", taskRev: 1, workflowRev: 3, template: "code", templateVersion: 2,
    mode: "manual", authorFamily: "claude", fallback: "wait", reason: "pause again" });
  f.scope(["a.ts"]);
  const input = { ...f.input(), workflowRev: 4 };
  if (released) {
    f.db.query("UPDATE scheduler_resources SET acquiredAt = 201 WHERE resource = 'a.ts'").run();
    const before = f.snapshot();
    expect(() => reconcileFileScope(f.db, f.ctx, { ...input, apply: true })).toThrow(/来源/);
    expect(f.snapshot()).toEqual(before);
    f.db.query("UPDATE scheduler_resources SET acquiredAt = 200 WHERE resource = 'a.ts'").run();
  }
  expect(reconcileFileScope(f.db, f.ctx, input)).toMatchObject({ executable: true,
    anchors: { "a.ts": released ? "reacquire" : "real-plan" } });
  expect(reconcileFileScope(f.db, f.ctx, { ...input, apply: true })).toMatchObject({ ok: true });
});

test.each(["active", "retiring", "retired"])("reviewer binding %s needs formal retirement proof, not stored receipt strings", state => {
  const f = fixture(); f.scope([]);
  f.db.query(`INSERT INTO scheduler_sessions
    (taskId, role, agent, sessionId, family, transport, state, createIntentId, archiveReceipt, killReceipt, createdAt, updatedAt)
    VALUES ('T', 'reviewer', 'agent-review', 'review-session', 'codex', 'peer', ?, 'real-plan', 'archive', 'kill', 1, 1)`).run(state);
  const before = f.snapshot(), preview = reconcileFileScope(f.db, f.ctx, f.input());
  expect(preview).toMatchObject({ executable: false });
  for (const fact of ["review-session", "done retire 意图", "archive 审计", "kill 审计"]) expect(preview.reasons.join("；")).toContain(fact);
  expect(() => reconcileFileScope(f.db, f.ctx, { ...f.input(), apply: true })).toThrow(/退役/);
  expect(f.snapshot()).toEqual(before);
});
