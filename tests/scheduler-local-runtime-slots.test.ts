import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { workingCodexAgents } from "../src/lib/scheduler-local-runtime-slots-ledger.js";
import { withCodexSlot } from "../src/lib/scheduler-local-runtime-slots.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "slots-")); dirs.push(dir);
  const ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  const registryPath = join(dir, "registry.json"), lockPath = join(dir, "lock");
  const agents: Record<string, object> = {};
  const registry = () => writeFileSync(registryPath, JSON.stringify({ agents }));
  const task = (id: string, stage: string, agent = id, round = 0) => {
    agents[agent] = { runtime: "codex", status: "active" };
    db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, round, createdAt, updatedAt)
      VALUES (?, 'p', ?, 'code', ?, ?, ?, 0, 0)`).run(id, id, stage, agent, round);
  };
  const step = (id: string, executor: string, round = 0, name = "review", kind = "agent", state = "assigned") => {
    agents[executor] = { runtime: "codex", status: "active" };
    db.query(`INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0)`).run(id, name, round, executor, kind, state);
  };
  return { db, ledgerPath, registryPath, lockPath, agents, registry, task, step };
}

test("ten idle sessions, two working authors, waiting author and current reviewer occupy three slots", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) f.agents[`idle-${i}`] = { runtime: "codex", status: "active" };
  f.task("a", "build"); f.task("b", "build"); f.task("waiting", "review", "waiting", 2);
  f.step("waiting", "old-reviewer", 1); f.step("waiting", "reviewer", 2);
  for (const stage of ["merge", "live", "verified", "cancelled"]) f.task(stage, stage);
  f.registry();
  expect([...workingCodexAgents(f.ledgerPath)].sort()).toEqual(["a", "b", "reviewer"]);
  expect(await withCodexSlot(async () => "opened", f)).toBe("opened");
});

test("six working sessions block; unknown creating reservations count and Claude/Pi do not", async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) f.task(`a${i}`, "build");
  f.registry();
  expect(await withCodexSlot(async () => "opened", f)).toMatchObject({ kind: "wait" });
  f.db.query("UPDATE tasks SET stage = 'review' WHERE id = 'a0'").run();
  for (const runtime of [undefined, "codex", "unknown", "claude-code", "pi"]) {
    f.agents.reservation = { status: "creating", runtime }; f.registry();
    const result = await withCodexSlot(async () => "opened", f);
    if (runtime === "pi" || runtime === "claude-code") expect(result).toBe("opened");
    else expect(result).toMatchObject({ kind: "wait" });
  }
});

test("current explicit steps override task agent and stale reviewers; bindings fill absent review steps", () => {
  const f = fixture();
  for (const stage of ["spec", "restate", "build", "fix"]) {
    f.task(stage, stage, `old-${stage}`);
    f.step(stage, `do-${stage}`, 0, stage === "fix" ? "fix" : stage === "build" ? "write" : "restate");
  }
  f.task("r", "review", "author", 2); f.step("r", "stale", 1);
  f.task("binding", "review", "waiting");
  f.db.run("PRAGMA foreign_keys = OFF");
  f.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('binding', 'reviewer', 'bound', 's', 'codex', 'acp', 'active', 'intent', 0, 0)`).run();
  expect([...workingCodexAgents(f.ledgerPath)].sort()).toEqual(["bound", "do-build", "do-fix", "do-restate", "do-spec"]);
});

test("unreadable registry and missing or broken ledger fail closed without creating a database", async () => {
  const f = fixture(); f.registry();
  expect(await withCodexSlot(async () => "opened", { ...f, ledgerPath: join(f.ledgerPath, "absent") })).toMatchObject({ kind: "wait" });
  f.db.run("DROP TABLE task_steps");
  expect(await withCodexSlot(async () => "opened", f)).toMatchObject({ kind: "wait" });
  writeFileSync(f.registryPath, "bad JSON");
  expect(await withCodexSlot(async () => "opened", f)).toMatchObject({ kind: "wait" });
});
