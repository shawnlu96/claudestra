import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger, closeLedger } from "../src/lib/ledger-store.js";
import { moveStage } from "../src/lib/ledger-write.js";
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

test("ten idle sessions, two working authors, waiting author and current reviewer conservatively occupy four slots", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) f.agents[`idle-${i}`] = { runtime: "codex", status: "active" };
  f.task("a", "build"); f.task("b", "build"); f.task("waiting", "review", "waiting", 2);
  f.step("waiting", "old-reviewer", 1); f.step("waiting", "reviewer", 2);
  for (const stage of ["merge", "live", "verified", "cancelled"]) f.task(stage, stage);
  f.registry();
  expect([...workingCodexAgents(f.ledgerPath)].sort()).toEqual(["a", "b", "old-reviewer", "reviewer"]);
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

test("explicit author steps override task agent; all bound review sessions reserve slots", () => {
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
  expect([...workingCodexAgents(f.ledgerPath)].sort()).toEqual(["bound", "do-build", "do-fix", "do-restate", "do-spec", "stale"]);
});

test("unreadable registry and missing or broken ledger fail closed without creating a database", async () => {
  const f = fixture(); f.registry();
  expect(await withCodexSlot(async () => "opened", { ...f, ledgerPath: join(f.ledgerPath, "absent") })).toMatchObject({ kind: "wait" });
  f.db.run("DROP TABLE task_steps");
  expect(await withCodexSlot(async () => "opened", f)).toMatchObject({ kind: "wait" });
  writeFileSync(f.registryPath, "bad JSON");
  expect(await withCodexSlot(async () => "opened", f)).toMatchObject({ kind: "wait" });
});

test("R1 delivered write/fix rows still reserve all six authors across repeated fix rounds", async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) { f.task(`fix-${i}`, "fix"); f.step(`fix-${i}`, `fix-${i}`, 0, "write", "agent", "delivered"); }
  f.registry();
  expect(workingCodexAgents(f.ledgerPath).size).toBe(6);
  expect(await withCodexSlot(async () => "opened", f)).toMatchObject({ kind: "wait" });
  for (let i = 0; i < 6; i++) f.step(`fix-${i}`, `fix-${i}`, 1, "fix", "agent", "delivered");
  expect(workingCodexAgents(f.ledgerPath).size).toBe(6);
});

test("R3 custom keys and old reviewers count through same-round recovery, then leave with review stage", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.task(`author-${i}`, "build");
  f.task("review", "review", "waiting", 2); f.step("review", "old", 1);
  f.db.run("PRAGMA foreign_keys = OFF");
  f.agents.current = { runtime: "codex", status: "active" };
  f.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
    VALUES ('review', 'reviewer', 'current', 's', 'codex', 'acp', 'active', 'custom-key', 0, 0)`).run();
  f.registry();
  expect(workingCodexAgents(f.ledgerPath).has("current")).toBe(true);
  expect(workingCodexAgents(f.ledgerPath).has("old")).toBe(true);
  expect(workingCodexAgents(f.ledgerPath).size).toBe(6);
  expect(await withCodexSlot(async () => "opened", f)).toMatchObject({ kind: "wait" });
  moveStage(f.db, { actor: "owner" }, { taskId: "review", from: "review", to: "blocked", text: "temporary review interruption" });
  moveStage(f.db, { actor: "owner" }, { taskId: "review", from: "blocked", to: "review" });
  expect(workingCodexAgents(f.ledgerPath).size).toBe(6);
  expect(await withCodexSlot(async () => "opened", f)).toMatchObject({ kind: "wait" });
  f.db.query("UPDATE tasks SET stage = 'merge' WHERE id = 'review'").run();
  expect(workingCodexAgents(f.ledgerPath).has("current")).toBe(false);
  expect(workingCodexAgents(f.ledgerPath).has("old")).toBe(false);
  expect(workingCodexAgents(f.ledgerPath).size).toBe(4);
  expect(await withCodexSlot(async () => "opened", f)).toBe("opened");
});

test("R1 real manual start and reviewer ensure use the current custom ledger before side effects", async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) f.task(`author-${i}`, "build");
  f.registry();
  const state = join(f.lockPath, "..", "state"); mkdirSync(state);
  writeFileSync(join(state, "registry.json"), JSON.stringify({ agents: f.agents }));
  writeFileSync(join(state, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { repoDir: state, localAuthorRuntime: "codex", maxActiveWorkers: 6, requiredChecks: ["check"] } } }));
  const root = new URL("../", import.meta.url).pathname;
  const script = `import { openLedger } from ${JSON.stringify(root + "src/lib/ledger-store.ts")};
    import { runStart } from ${JSON.stringify(root + "src/lib/dag-tools-steps.ts")};
    import { autoTickDeps } from ${JSON.stringify(root + "src/lib/scheduler-auto-deps.ts")};
    const db = openLedger(${JSON.stringify(f.ledgerPath)});
    const io = { db: () => db, attempt: 'probe', manager: async () => ({ok:true}) };
    const manual = await runStart(io, {project:'p',taskId:'new',feature:{id:'F'},key:'one'});
    const reviewer = await autoTickDeps(db, {registryPath:${JSON.stringify(f.registryPath)}})
      .ensure({id:'new',project:'p',agent:null},'reviewer','codex');
    console.log(JSON.stringify({manual,reviewer}));`;
  const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env,
    CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: state }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, error).toBe(0);
  const result = JSON.parse(output);
  expect(result.manual).toMatchObject({ code: "queued", error: expect.stringContaining("等待空槽") });
  expect(result.reviewer).toMatchObject({ kind: "wait", reason: expect.stringContaining("等待空槽") });
});
