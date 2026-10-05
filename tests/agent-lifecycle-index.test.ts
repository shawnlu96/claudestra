/**
 * LIFE1 spec4 (监工 02:20): worker_agents comes from LEDGER_MIGRATIONS (no CREATE TABLE at write time); cardWorkerIndex is the one
 * reader of agent → card, merging worker_agents, scheduler_sessions and tasks.agent; retire clears the agent's own disk (checkout with
 * its node_modules / web/node_modules / build output, its Claude temp folder) and writes the measured difference to the ledger.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE } from "../src/lib/agent-lifecycle-config.js";
import { WORKER_AGENTS_SCHEMA } from "../src/lib/agent-lifecycle-schema.js";
import { activeWorkers, buildCardWorkerIndex, cardWorkerIndex, recordWorkerRetire, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle } from "../src/lib/agent-lifecycle.js";
import { runLifecycle } from "../src/lib/agent-lifecycle-run.js";
import { ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { closeLedger, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION, listEvents, openLedger, schemaVersion } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { claudeTmpDirFor } from "../src/lib/scheduler-retire-tmp.js";
import { git } from "../src/lib/scheduler-review-worktree.js";

const H = 3_600_000, NOW = 100 * H;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "life1-ix-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  let now = 1000;
  const card = (id: string, stage: string, agent?: string) => {
    createTask(db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code" });
    db.query("UPDATE tasks SET stage = ?, agent = ? WHERE id = ?").run(stage, agent ?? null, id);
  };
  return { db, dir, path, card };
}

describe("migration", () => {
  test("worker_agents is a ledger migration step at the end, and a fresh ledger has it", () => {
    const { db } = ledger();
    expect(LEDGER_MIGRATIONS.at(-1)).toBe(WORKER_AGENTS_SCHEMA);
    expect(schemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worker_agents'").get()).toBeTruthy();
  });

  test("a ledger one step behind is upgraded on open; readers on a raw db without the table see nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "life1-mig-")), path = join(dir, "ledger.sqlite");
    cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
    const raw = new Database(path);
    for (const step of LEDGER_MIGRATIONS.slice(0, -1)) typeof step === "function" ? step(raw) : step.forEach((sql) => raw.prepare(sql).run());
    raw.exec(`PRAGMA user_version = ${LEDGER_MIGRATIONS.length - 1}`);
    expect(activeWorkers(raw)).toEqual([]);
    expect(cardWorkerIndex(raw).size).toBe(0);
    raw.close();
    const db = openLedger(path);
    expect(schemaVersion(db)).toBe(LEDGER_SCHEMA_VERSION);
    expect(activeWorkers(db)).toEqual([]);
  });
});

describe("cardWorkerIndex", () => {
  test("merges the three tables; registration wins, then binding, then an unfinished executor card; no record = absent", () => {
    const { db, card } = ledger();
    card("A", "verified", "both"); card("B", "build", "exec-only"); card("C", "done", "exec-only"); card("D", "review");
    registerWorker(db, { agent: "both", sessionId: "s1", taskId: "A", role: "reviewer", createdBy: "pm", now: 1 });
    db.exec("PRAGMA foreign_keys = OFF"); // a bare binding row; the intent it came from does not matter to the reader
    db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, createIntentId, state, createdAt, updatedAt)
      VALUES ('D', 'reviewer', 'sched', 's2', 'claude', 'tmux', 'i1', 'active', 1, 1)`).run();
    const ix = cardWorkerIndex(db);
    expect(ix.get("both")).toMatchObject({ taskId: "A", role: "reviewer", source: "worker_agents" });
    expect(ix.get("both")!.links.map((l) => l.source)).toEqual(["worker_agents", "tasks.agent"]);
    expect(ix.get("sched")).toMatchObject({ taskId: "D", role: "reviewer", source: "scheduler_sessions" });
    expect(ix.get("exec-only")).toMatchObject({ taskId: "B", role: "author", source: "tasks.agent" });
    expect(ix.get("exec-only")!.links.map((l) => l.taskId)).toEqual(["B", "C"]);
    expect(ix.has("agent-rv-whatever-once")).toBe(false); // a worker-looking name with no record is the user's
  });

  test("pure builder dedups the same card / source and keeps every link", () => {
    const ix = buildCardWorkerIndex({
      registrations: [{ agent: "x", taskId: "T", role: "author" }],
      bound: [{ agent: "x", taskId: "T", role: "author" }, { agent: "x", taskId: "U", role: "reviewer" }],
      executors: [{ agent: "x", taskId: "T", stage: "build" }, { agent: "x", taskId: "T", stage: "build" }],
    });
    expect(ix.get("x")!.links).toEqual([
      { taskId: "T", role: "author", source: "worker_agents" }, { taskId: "T", role: "author", source: "scheduler_sessions" },
      { taskId: "U", role: "reviewer", source: "scheduler_sessions" }, { taskId: "T", role: "author", source: "tasks.agent" }]);
  });

  test("an agent another unfinished card still links (any source) is not collected with its finished card", () => {
    const { db, card } = ledger();
    card("F", "verified"); card("G", "build", "shared");
    registerWorker(db, { agent: "shared", sessionId: "s", taskId: "F", role: "author", createdBy: "pm", now: 1 });
    const plan = planLifecycle({ now: NOW, policy: { ...DEFAULT_LIFECYCLE }, index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: new Set(),
      master: new Set(), swapPct: 10, agents: [{ name: "shared", running: true, idleMs: 9 * H, turnActive: false }] });
    expect(plan.actions).toEqual([]);
    expect(plan.kept).toEqual([{ agent: "shared", reason: "tasks.agent 还关联卡 G（build），记录不一致，保守保留" }]);
  });

  test("a link to a card the ledger does not know keeps the agent too (unknown ownership is never cleaned)", () => {
    const { db, card } = ledger();
    card("F2", "verified");
    registerWorker(db, { agent: "u", sessionId: "s", taskId: "F2", role: "author", createdBy: "pm", now: 1 });
    const index = cardWorkerIndex(db);
    index.get("u")!.links.push({ taskId: "GHOST", role: "reviewer", source: "scheduler_sessions" });
    const plan = planLifecycle({ now: NOW, policy: { ...DEFAULT_LIFECYCLE }, index, ...ledgerFacts(db), foreign: new Set(),
      master: new Set(), swapPct: 10, agents: [{ name: "u", running: true, idleMs: 9 * H, turnActive: false }] });
    expect([plan.actions, plan.kept.map((k) => k.agent)]).toEqual([[], ["u"]]);
  });
});

describe("disk (验收线 8)", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };

  test("retire removes the own checkout with node_modules, web/node_modules, build output and the Claude temp folder; bytes on the event", async () => {
    const { db, dir, card } = ledger();
    card("K", "verified");
    const repo = join(dir, "repo"), root = join(dir, "worktrees"), tmpRoot = join(dir, "claude-tmp"), wt = join(root, "k");
    mkdirSync(repo); mkdirSync(root); mkdirSync(tmpRoot);
    sh(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n");
    sh(repo, "add", ".gitignore"); sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
    sh(repo, "worktree", "add", "-q", "--detach", wt);
    for (const d of ["node_modules/x", "web/node_modules/y", "dist"]) { mkdirSync(join(wt, d), { recursive: true }); writeFileSync(join(wt, d, "f"), "x".repeat(1000)); }
    const tmpDir = claudeTmpDirFor(wt, tmpRoot);
    mkdirSync(join(tmpDir, "scratch"), { recursive: true }); writeFileSync(join(tmpDir, "scratch", "out"), "y");
    registerWorker(db, { agent: "agent-k", sessionId: "s", taskId: "K", role: "author", createdBy: "pm", now: 1 });
    const plan = planLifecycle({ now: NOW, policy: { ...DEFAULT_LIFECYCLE }, index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: new Set(),
      master: new Set(), swapPct: 10, agents: [{ name: "agent-k", cwd: wt, running: false, idleMs: 7 * H, turnActive: false }] });
    const measured: string[][] = [];
    const r = await runLifecycle(plan, { ...DEFAULT_LIFECYCLE, mode: "on" }, {
      manager: async (...args) => (args[0] === "archive" ? { ok: true, archived: ["a.jsonl"] } : { ok: true, message: "done" }),
      git, exists: existsSync, worktreeRoot: root, agents: async () => [], tmp: { root: tmpRoot, rm: (p) => rm(p, { recursive: true }) },
      du: async (paths) => { measured.push(paths); return paths.filter((p) => existsSync(p)).length * 1000; },
      swapPct: async () => 0, record: async (rec) => recordWorkerRetire(db, "scheduler", rec), now: () => NOW,
    });
    expect(r.failed).toEqual([]);
    expect(measured[0]).toEqual([wt, tmpDir]);
    expect([existsSync(wt), existsSync(tmpDir), existsSync(repo)]).toEqual([false, false, true]);
    const ev = listEvents(db, { project: "p" }).find((e) => (e.data as { op?: string }).op === "worker_retire")!;
    expect(ev.data).toMatchObject({ agent: "agent-k", bytesBefore: 2000, bytesAfter: 0, bytesFreed: 2000 });
  });

  test("archive failed (chat record not kept): nothing is stopped or deleted; a symlinked checkout is never followed", async () => {
    const { db, dir, card } = ledger();
    card("L", "verified"); card("L2", "verified");
    const root = join(dir, "worktrees"), real = join(dir, "elsewhere");
    mkdirSync(root); mkdirSync(real); writeFileSync(join(real, "keep"), "x");
    symlinkSync(real, join(root, "l2"));
    registerWorker(db, { agent: "agent-l", sessionId: "s", taskId: "L", role: "author", createdBy: "pm", now: 1 });
    registerWorker(db, { agent: "agent-l2", sessionId: "s", taskId: "L2", role: "author", createdBy: "pm", now: 2 });
    const plan = planLifecycle({ now: NOW, policy: { ...DEFAULT_LIFECYCLE }, index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: new Set(),
      master: new Set(), swapPct: 10, agents: [{ name: "agent-l", running: false, idleMs: 9 * H, turnActive: false },
        { name: "agent-l2", cwd: join(root, "l2"), running: false, idleMs: 9 * H, turnActive: false }] });
    const calls: string[][] = [];
    const r = await runLifecycle(plan, { ...DEFAULT_LIFECYCLE, mode: "on" }, {
      manager: async (...args) => { calls.push(args); return args[0] === "archive"
        ? (args[1] === "agent-l" ? { ok: false, note: "subagents/x.jsonl: EACCES" } : { ok: true, archived: [] }) : { ok: true, message: "done" }; },
      git, exists: existsSync, worktreeRoot: root, agents: async () => [], du: async () => 0, swapPct: async () => 0,
      record: async (rec) => recordWorkerRetire(db, "scheduler", rec), now: () => NOW,
    });
    expect(calls).toEqual([["archive", "agent-l"], ["archive", "agent-l2"], ["remove", "agent-l2"]]);
    expect(r.failed.map((f) => f.agent)).toEqual(["agent-l"]);
    expect([existsSync(join(real, "keep")), activeWorkers(db).map((w) => w.agent)]).toEqual([true, ["agent-l"]]);
    const ev = listEvents(db, { project: "p" }).find((e) => (e.data as { op?: string; agent?: string }).op === "worker_retire")!;
    expect(String((ev.data as { steps: string[] }).steps)).toContain("符号链接");
  });
});
