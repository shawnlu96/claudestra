import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, setMeta, setTask } from "../src/lib/ledger-write.js";
import { planIntent, setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { testChildEnv } from "./test-env.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });
function cliFixture(ran = false, delivered = false) {
  const state = mkdtempSync(join(tmpdir(), "rlock-cli-")), path = join(state, "ledger.sqlite");
  const db = openLedger(path), owner = { actor: "owner", now: 500 };
  cleanup.push(() => { closeLedger(path); rmSync(state, { recursive: true, force: true }); });
  const agents = { "agent-pm": { channelId: "111", projectId: "p" }, "agent-other": { channelId: "222", projectId: "q" } };
  writeFileSync(join(state, "registry.json"), JSON.stringify({ agents }));
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: ["p", "q"].map(id => ({ id, name: id, dirs: [state] })) }));
  setMeta(db, owner, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, owner, { project: "p", id: "MQ", title: "paused fixture", kind: "code", extra: { fileGlobs: ["old.ts", "keep.ts"] } });
  const w = { taskId: "MQ", taskRev: 1, template: "code" as const, templateVersion: 2, authorFamily: "claude" as const, fallback: "manual" };
  setWorkflow(db, owner, { ...w, mode: "auto" });
  const causalSeq = (db.query("SELECT MAX(seq) AS seq FROM events").get() as { seq: number }).seq;
  planIntent(db, owner, { ...w, id: "claim", workflowRev: 1, causalSeq, node: "write", action: "dispatch", reason: "reserved",
    recipient: ran ? "agent-w" : undefined, resources: ["old.ts", "keep.ts", "slot:p:0"] });
  if (ran) {
    settleIntent(db, owner, { id: "claim", from: "pending", to: "submitted" });
    settleIntent(db, owner, { id: "claim", from: "submitted", to: "done" });
  } else settleIntent(db, owner, { id: "claim", from: "pending", to: "cancelled" });
  if (delivered) {
    moveStage(db, owner, { taskId: "MQ", from: "spec", to: "restate" });
    moveStage(db, owner, { taskId: "MQ", from: "restate", to: "build" });
    assignStep(db, owner, { taskId: "MQ", step: "write", executor: "writer@fake-peer", executorKind: "peer" });
    deliver(db, owner, { taskId: "MQ", headSHA: "a".repeat(40), moveFrom: "build" });
  }
  setWorkflow(db, owner, { ...w, taskRev: getTask(db, "MQ")!.rev, workflowRev: 1, mode: "manual", reason: "explicit pause" });
  setTask(db, owner, { id: "MQ", rev: getTask(db, "MQ")!.rev, patch: { extra: { fileGlobs: ["keep.ts"] } } });
  const taskRev = String(getTask(db, "MQ")!.rev);
  const home = join(state, "home"); mkdirSync(home);
  const cli = async (flags: string[] = [], extra: Record<string, string | undefined> = {}) => {
    const proc = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", join(import.meta.dir, "../src/manager.ts"), "ledger",
      "scheduler-file-scope", "MQ", "--project", "p", "--rev", taskRev, "--workflow-rev", "2", "--reason", "approved narrowing", ...flags], {
      cwd: state, env: testChildEnv({ HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDESTRA_STATE_DIR: state,
        CLAUDESTRA_RUNTIME_DIR: join(state, "runtime"), DISCORD_CHANNEL_ID: "111", ...extra }), stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const last = out.trim().split("\n").at(-1);
    if (!last) throw new Error(`CLI ${code}: ${err}`);
    return JSON.parse(last);
  };
  const snapshot = () => db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(r => db.query(`SELECT * FROM "${(r as { name: string }).name}" ORDER BY rowid`).all());
  return { db, state, path, cli, snapshot };
}

test("real CLI: default preview, explicit preview, PM apply, idempotent replay", async () => {
  const f = cliFixture(true), before = f.snapshot();
  for (const flags of [[], ["--dry-run"]]) {
    expect(await f.cli(flags)).toMatchObject({ ok: true, dryRun: true, executable: true, remove: ["old.ts"], add: [] });
    expect(f.snapshot()).toEqual(before);
  }
  expect(await f.cli(["--apply"])).toMatchObject({ ok: true, dryRun: false, duplicate: false });
  const applied = f.snapshot();
  expect(await f.cli(["--apply"])).toMatchObject({ ok: true, duplicate: true });
  expect(f.snapshot()).toEqual(applied);
});

test.each([false, true])("explicit preview %j never repairs unrelated assignee drift", async explicit => {
  const f = cliFixture();
  f.db.query("UPDATE tasks SET assigneeKind = 'agent', assignee = 'stale' WHERE id = 'MQ'").run();
  const before = f.snapshot();
  await f.cli(explicit ? ["--dry-run"] : []);
  expect(f.snapshot()).toEqual(before);
  expect(await f.cli(["--apply"])).toMatchObject({ ok: true });
  expect(f.db.query("SELECT assigneeKind, assignee FROM tasks WHERE id = 'MQ'").get())
    .toEqual({ assigneeKind: "agent", assignee: "stale" });
});

test("read classification, old schema and missing registry/database never initialize state", async () => {
  const args = ["scheduler-file-scope", "MQ"];
  expect(isWriteInvocation("ledger", args)).toBe(false);
  expect(isWriteInvocation("ledger", [...args, "--dry-run"])).toBe(false);
  expect(isWriteInvocation("ledger", [...args, "--apply"])).toBe(true);
  const f = cliFixture();
  f.db.exec("PRAGMA user_version = 1");
  const before = f.snapshot();
  for (const flags of [[], ["--dry-run"], ["--apply"]]) expect(await f.cli(flags)).toMatchObject({ ok: false, code: "conflict" });
  expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(f.snapshot()).toEqual(before);
  rmSync(join(f.state, "registry.json"));
  expect(await f.cli()).toMatchObject({ ok: false, code: "conflict" });
  expect(existsSync(join(f.state, "registry.json"))).toBe(false);
  writeFileSync(join(f.state, "registry.json"), '{"agents":{"agent-pm":{"channelId":"111","projectId":"p"}}}');
  closeLedger(f.path); rmSync(f.path);
  expect(await f.cli()).toMatchObject({ ok: false, code: "not_found" });
  expect(existsSync(f.path)).toBe(false);
});

test("real CLI refuses foreign PM, unknown channel, scheduler service and external worker", async () => {
  const f = cliFixture(), before = f.snapshot();
  for (const identity of [
    { DISCORD_CHANNEL_ID: "222" }, { DISCORD_CHANNEL_ID: "unknown" },
    { DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "1" },
    { DISCORD_CHANNEL_ID: "", CLAUDESTRA_LEND_WORKER: "1" },
  ]) expect(await f.cli(["--apply"], identity)).toMatchObject({ ok: false });
  expect(f.snapshot()).toEqual(before);
});

test("real CLI stale rev, wrong project and conflicting flags are zero-write refusals", async () => {
  const f = cliFixture(), before = f.snapshot();
  for (const flags of [["--rev", "1", "--apply"], ["--workflow-rev", "1", "--apply"],
    ["--project", "q", "--apply"], ["--apply", "--dry-run"]]) expect(await f.cli(flags)).toMatchObject({ ok: false });
  expect(f.snapshot()).toEqual(before);
});

test("real CLI transaction event failure rolls back file deletion", async () => {
  const f = cliFixture();
  f.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'audit disk fault'); END");
  const before = f.snapshot();
  expect(await f.cli(["--apply"])).toMatchObject({ ok: false });
  expect(f.snapshot()).toEqual(before);
});

test.each(["pending", "submitted", "unknown"])("real CLI %s intent refusal", async status => {
  const f = cliFixture();
  f.db.query("UPDATE scheduler_intents SET status = ?").run(status);
  const before = f.snapshot();
  expect(await f.cli()).toMatchObject({ ok: true, executable: false });
  expect(await f.cli(["--apply"])).toMatchObject({ ok: false });
  expect(f.snapshot()).toEqual(before);
});

test.each(["pooled", "claimed", "unknown"])("real CLI %s loan refusal", async status => {
  const f = cliFixture();
  f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo,
    wire, text, sha256, status, leaseMs, createdBy, createdAt, updatedAt)
    VALUES ('loan', 'MQ', 'p', 'fake-peer', 'claude', 'write', 1, 0, 'head', 'org/repo', '{}', '', '', ?, 1000, 'owner', 5, 5)`).run(status);
  const before = f.snapshot();
  expect(await f.cli(["--apply"])).toMatchObject({ ok: false });
  expect(f.snapshot()).toEqual(before);
});

test.each(["local", "peer", "peer-step", "registry-io", "conflict"])("real CLI %s evidence is never bypassed", async scenario => {
  const f = cliFixture();
  if (scenario === "local") writeFileSync(join(f.state, "registry.json"), JSON.stringify({ agents: {
    "agent-pm": { channelId: "111", projectId: "p" }, "agent-author": { task: "MQ", status: "active", sessionId: "live" },
  } }));
  if (scenario === "peer") f.db.query(`INSERT INTO scheduler_sessions
    (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('MQ', 'author', 'peer:fake:writer', 'live-peer', 'claude', 'peer', 'active', 'claim', 1, 1)`).run();
  if (scenario === "peer-step") f.db.query(`INSERT INTO task_steps (taskId, step, executor, executorKind, state, createdAt, updatedAt)
    VALUES ('MQ', 'write', 'writer@fake-peer', 'peer', 'assigned', 1, 1)`).run();
  if (scenario === "registry-io") { rmSync(join(f.state, "registry.json")); mkdirSync(join(f.state, "registry.json")); }
  if (scenario === "conflict") {
    createTask(f.db, { actor: "owner" }, { project: "p", id: "other", title: "other", kind: "code" });
    f.db.query("UPDATE scheduler_resources SET taskId = 'other' WHERE resource = 'old.ts'").run();
  }
  const before = f.snapshot();
  expect(await f.cli(["--apply"])).toMatchObject({ ok: false });
  expect(f.snapshot()).toEqual(before);
});

test("real CLI releases and reacquires scope after dispatch with historical names but no session binding", async () => {
  const f = cliFixture(true, true);
  f.db.query("UPDATE tasks SET agent = 'agent-old', assignee = 'agent-w', assigneeKind = 'agent' WHERE id = 'MQ'").run();
  expect(f.db.query("SELECT step, state, executor FROM task_steps").all())
    .toEqual([{ step: "write", state: "delivered", executor: "writer@fake-peer" }]);
  writeFileSync(join(f.state, "registry.json"), JSON.stringify({ agents: {
    "agent-pm": { channelId: "111", projectId: "p" },
    "agent-old": { status: "active", task: "other", sessionId: "unrelated" }, w: { status: "active" },
    "writer@fake-peer": { status: "active", task: "other" },
  } }));
  const before = f.snapshot();
  expect(f.db.query("SELECT * FROM scheduler_sessions").all()).toEqual([]);
  expect(await f.cli()).toMatchObject({ ok: true, executable: true, reasons: [], remove: ["old.ts"] });
  expect(f.snapshot()).toEqual(before);
  expect(await f.cli(["--apply"])).toMatchObject({ ok: true, duplicate: false });
  const stable = () => ["tasks", "task_steps", "scheduler_intents", "scheduler_sessions", "lend_write_leases"]
    .map(table => f.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
  setTask(f.db, { actor: "owner" }, { id: "MQ", rev: getTask(f.db, "MQ")!.rev, patch: { extra: { fileGlobs: ["old.ts", "keep.ts"] } } });
  const restoredRev = String(getTask(f.db, "MQ")!.rev), preserved = stable();
  expect(await f.cli(["--rev", restoredRev, "--apply"])).toMatchObject({ ok: true, add: ["old.ts"], remove: [] });
  expect(stable()).toEqual(preserved);
  expect(f.db.query("SELECT resource FROM scheduler_resources ORDER BY resource").all())
    .toEqual(["keep.ts", "old.ts"].map(resource => ({ resource })));
  const applied = f.snapshot();
  expect(await f.cli(["--rev", restoredRev, "--apply"])).toMatchObject({ ok: true, duplicate: true });
  expect(f.snapshot()).toEqual(applied);
});

test.each(["{", "[]"])("real CLI corrupt registry %s reports structured conflict", async raw => {
  const f = cliFixture(), before = f.snapshot();
  writeFileSync(join(f.state, "registry.json"), raw);
  expect(await f.cli()).toMatchObject({ ok: false, code: "conflict" });
  expect(f.snapshot()).toEqual(before);
});

test("real CLI refuses a registered file never planned by a dispatch", async () => {
  const f = cliFixture();
  setTask(f.db, { actor: "owner" }, { id: "MQ", rev: 2, patch: { extra: { fileGlobs: ["new.ts"] } } });
  const before = f.snapshot();
  expect(await f.cli(["--rev", "3"])).toMatchObject({ ok: true, executable: false, reasons: ["文件缺真实 dispatch 来源：new.ts"] });
  expect(await f.cli(["--rev", "3", "--apply"])).toMatchObject({ ok: false, code: "conflict" });
  expect(f.snapshot()).toEqual(before);
});

test.each(["author", "reviewer"])("real CLI residual %s binding lacks retirement facts: preview and apply are zero-write", async role => {
  const f = cliFixture(true, true);
  f.db.query(`INSERT INTO scheduler_sessions
    (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('MQ', ?, 'agent-bound', 'residual-session', 'claude', 'tmux', 'active', 'claim', 1, 1)`).run(role);
  const before = f.snapshot();
  const preview = await f.cli();
  expect(preview).toMatchObject({ ok: true, executable: false });
  const reasons = preview.reasons.join("；");
  for (const fact of ["residual-session", "done retire 意图", "archive 回执", "kill 回执", "retired 状态"]) expect(reasons).toContain(fact);
  expect(f.snapshot()).toEqual(before);
  expect(await f.cli(["--apply"])).toMatchObject({ ok: false, code: "conflict" });
  expect(f.snapshot()).toEqual(before);
});
