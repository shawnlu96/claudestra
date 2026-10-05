/**
 * LIFE1 card worker lifecycle: synthetic ledger + fake registry / tmux facts + fake manager. Covers the acceptance lines: finished
 * card → author and reviewer collected; merge author idle 7h parked, 1h kept; frozen card and user agents untouched; swap backstop
 * idle-longest first without touching a live turn; observe has no side effects; disk measured and the worktree removed.
 * Old red, new green: a PM-tool `-once` reviewer of a verified card is not a scheduler retire candidate, but the lifecycle collects it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE, parseLifecycle, type LifecyclePolicy } from "../src/lib/agent-lifecycle-config.js";
import { activeWorkers, recordWorkerRetire, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle, lifecycleLine, type AgentFacts, type PlanInput } from "../src/lib/agent-lifecycle.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";
import { ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { retireCandidates } from "../src/lib/scheduler-retire.js";
import { git } from "../src/lib/scheduler-review-worktree.js";

const H = 3_600_000, NOW = 100 * H;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "life1-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]')").run();
  let now = 1000;
  const card = (id: string, stage: string, extra: Record<string, unknown> = {}) => {
    createTask(db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code" });
    db.query("UPDATE tasks SET stage = ?, extra = ? WHERE id = ?").run(stage, JSON.stringify(extra), id);
  };
  return { db, dir, card };
}

const agent = (name: string, idleH: number | null, more: Partial<AgentFacts> = {}): AgentFacts =>
  ({ name, status: "active", running: true, idleMs: idleH === null ? null : idleH * H, turnActive: false, ...more });

function input(db: ReturnType<typeof ledger>["db"], agents: AgentFacts[], over: Partial<PlanInput> = {}): PlanInput {
  return { now: NOW, policy: { ...DEFAULT_LIFECYCLE }, agents, registrations: activeWorkers(db), ...ledgerFacts(db), foreign: new Set(),
    master: new Set(["master"]), swapPct: 10, ...over };
}

describe("plan", () => {
  test("old red / new green: a PM-tool -once reviewer of a verified card is collected; scheduler retire never saw it", () => {
    const { db, card } = ledger();
    card("T1", "verified");
    registerWorker(db, { agent: "agent-t1-claude-local", sessionId: "s1", taskId: "T1", role: "author", createdBy: "agent-pm", now: 1 });
    registerWorker(db, { agent: "agent-t1-once", sessionId: "s2", taskId: "T1", role: "reviewer", createdBy: "agent-pm", now: 2 });
    expect(retireCandidates(db, ["p"])).toEqual([]); // the old path has nothing bound, so both would live forever
    const plan = planLifecycle(input(db, [agent("agent-t1-claude-local", 2), agent("agent-t1-once", 2)]));
    expect(plan.actions.map((a) => [a.agent, a.rule, a.mode])).toEqual([
      ["agent-t1-claude-local", "card_finished", "retire"], ["agent-t1-once", "card_finished", "retire"]]);
    expect(lifecycleLine(plan, "observe")).toBe("worker agent：活 2 / 应收 2 / swap 10%（lifecycle observe）");
  });

  test("merge author: idle 7h parked, idle 1h kept; a turn in the last 30 min is never touched", () => {
    const { db, card } = ledger();
    card("T2", "merge"); card("T3", "merge"); card("T4", "verified");
    registerWorker(db, { agent: "a2", sessionId: "s", taskId: "T2", role: "author", createdBy: "pm", now: 1 });
    registerWorker(db, { agent: "a3", sessionId: "s", taskId: "T3", role: "author", createdBy: "pm", now: 2 });
    registerWorker(db, { agent: "a4", sessionId: "s", taskId: "T4", role: "author", createdBy: "pm", now: 3 });
    const plan = planLifecycle(input(db, [agent("a2", 7), agent("a3", 1), agent("a4", 0.2)]));
    expect(plan.actions.map((a) => [a.agent, a.rule, a.mode])).toEqual([["a2", "author_parked", "park"]]);
  });

  test("frozen card only reported; user agents, master, PM, lend workers and live turns untouched", () => {
    const { db, card } = ledger();
    card("T5", "verified", { frozen: true }); card("T6", "done");
    registerWorker(db, { agent: "f5", sessionId: "s", taskId: "T5", role: "reviewer", createdBy: "pm", now: 1 });
    registerWorker(db, { agent: "busy6", sessionId: "s", taskId: "T6", role: "reviewer", createdBy: "pm", now: 2 });
    db.query("UPDATE tasks SET agent = 'lend6' WHERE id = 'T6'").run();
    const agents = [agent("f5", 50), agent("agent-task-old-once", 50, { kind: "worker" }), agent("master", 50), agent("agent-pm", 50),
      agent("lend6", 50), agent("busy6", 50, { turnActive: true })];
    const plan = planLifecycle(input(db, agents, { foreign: new Set(["lend6"]), swapPct: 99 }));
    expect(plan.actions).toEqual([]);
    expect(plan.memory).toEqual([]);
    expect(plan.frozen).toEqual([{ agent: "f5", taskId: "T5" }]);
  });

  test("reviewer: verdict recorded and card out of review 3h → collected; still in review and fresh → kept", () => {
    const { db, card } = ledger();
    card("T7", "fix"); card("T8", "review");
    db.query("INSERT INTO events (ts, actor, project, target, kind, text, data) VALUES (?, 'x', 'p', 'T7', 'review', '', '{}'), (?, 'x', 'p', 'T7', 'stage', '', '{}')")
      .run(NOW - 4 * H, NOW - 3 * H);
    registerWorker(db, { agent: "r7", sessionId: "s", taskId: "T7", role: "reviewer", createdBy: "pm", now: 1 });
    registerWorker(db, { agent: "r8", sessionId: "s", taskId: "T8", role: "reviewer", createdBy: "pm", now: 2 });
    const plan = planLifecycle(input(db, [agent("r7", 1), agent("r8", 1)]));
    expect(plan.actions.map((a) => [a.agent, a.rule, a.mode])).toEqual([["r7", "reviewer_done", "retire"]]);
  });

  test("stock: only a ledger record links an agent to a card; the name never does", () => {
    const { db, card } = ledger();
    card("T9", "cancelled"); card("T10", "build");
    db.query("UPDATE tasks SET agent = 'agent-whatever' WHERE id = 'T9'").run();
    const plan = planLifecycle(input(db, [agent("agent-whatever", 8), agent("agent-task-t10", 80), agent("agent-rv-t9", 80)]));
    expect(plan.actions.map((a) => [a.agent, a.rule])).toEqual([["agent-whatever", "stock"]]);
    expect(planLifecycle(input(db, [agent("agent-whatever", 2)])).actions).toEqual([]); // idle under 6h
  });

  test("swap above threshold: idle-longest first, never a live turn or an in-progress card", () => {
    const { db, card } = ledger();
    card("M1", "merge"); card("M2", "live"); card("M3", "build"); card("M4", "blocked");
    for (const [i, id] of ["M1", "M2", "M3", "M4"].entries()) registerWorker(db, { agent: `m${i + 1}`, sessionId: "s", taskId: id, role: "author", createdBy: "pm", now: i + 1 });
    const agents = [agent("m1", 2), agent("m2", 5), agent("m3", 9), agent("m4", 4, { turnActive: true })];
    const plan = planLifecycle(input(db, agents, { swapPct: 85 }));
    expect(plan.actions).toEqual([]);
    expect(plan.memory.map((a) => [a.agent, a.mode])).toEqual([["m2", "park"], ["m1", "park"]]);
    expect(planLifecycle(input(db, agents, { swapPct: 60 })).memory).toEqual([]);
  });
});

describe("run", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };

  function fakeDeps(db: ReturnType<typeof ledger>["db"], root: string, swaps: number[] = []) {
    const calls: string[][] = [];
    const deps: LifecycleDeps = {
      manager: async (...args) => { calls.push(args); return args[0] === "archive" ? { ok: true, archived: ["a.jsonl"] } : { ok: true, message: "done" }; },
      git, exists: existsSync, worktreeRoot: root, agents: async () => [],
      du: async (paths) => paths.filter((p) => existsSync(p)).length * 4096,
      swapPct: async () => swaps.shift() ?? 0, record: async (r) => recordWorkerRetire(db, "scheduler", r), now: () => NOW,
    };
    return { deps, calls };
  }

  test("on: archive → remove → own worktree removed, bytes before/after on the ledger event; repeat is harmless", async () => {
    const { db, dir, card } = ledger();
    card("W1", "verified");
    const repo = join(dir, "repo"), root = join(dir, "worktrees");
    mkdirSync(repo); mkdirSync(root);
    sh(repo, "init", "-q"); sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    sh(repo, "worktree", "add", "-q", "--detach", join(root, "w1"));
    mkdirSync(join(root, "w1", "node_modules")); writeFileSync(join(root, "w1", ".gitignore"), "node_modules\n.gitignore\n");
    registerWorker(db, { agent: "agent-w1", sessionId: "s", taskId: "W1", role: "author", createdBy: "pm", now: 1 });
    const plan = planLifecycle(input(db, [agent("agent-w1", 1, { cwd: join(root, "w1") })]));
    const { deps, calls } = fakeDeps(db, root);
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const r = await runLifecycle(plan, on, deps);
    expect(calls).toEqual([["archive", "agent-w1"], ["remove", "agent-w1"]]);
    expect(r.done).toEqual([{ agent: "agent-w1", rule: "card_finished", mode: "retire", freed: 4096 }]);
    expect(existsSync(join(root, "w1"))).toBe(false);
    const ev = listEvents(db, { project: "p" }).filter((e) => (e.data as { op?: string }).op === "worker_retire");
    expect(ev.map((e) => (e.data as Record<string, unknown>).bytesFreed)).toEqual([4096]);
    expect(activeWorkers(db)).toEqual([]);
    await runLifecycle(plan, on, deps); // PM already removed it / second pass: no throw, still one closed row
    expect(activeWorkers(db)).toEqual([]);
  });

  test("observe and off: no manager call, no ledger write", async () => {
    const { db, card } = ledger();
    card("O1", "verified");
    registerWorker(db, { agent: "o1", sessionId: "s", taskId: "O1", role: "reviewer", createdBy: "pm", now: 1 });
    const plan = planLifecycle(input(db, [agent("o1", 1)], { swapPct: 99 }));
    expect(plan.actions.length).toBe(1);
    const before = listEvents(db, { project: "p" }).length;
    for (const mode of ["observe", "off"] as const) {
      const { deps, calls } = fakeDeps(db, "/nonexistent");
      expect(await runLifecycle(plan, { ...DEFAULT_LIFECYCLE, mode }, deps)).toEqual({ done: [], failed: [] });
      expect(calls).toEqual([]);
    }
    expect(listEvents(db, { project: "p" }).length).toBe(before);
    expect(activeWorkers(db).map((w) => w.agent)).toEqual(["o1"]);
  });

  test("memory backstop stops as soon as swap is back under the threshold", async () => {
    const { db, card } = ledger();
    card("S1", "merge"); card("S2", "merge");
    registerWorker(db, { agent: "s1", sessionId: "s", taskId: "S1", role: "author", createdBy: "pm", now: 1 });
    registerWorker(db, { agent: "s2", sessionId: "s", taskId: "S2", role: "author", createdBy: "pm", now: 2 });
    const plan = planLifecycle(input(db, [agent("s1", 3), agent("s2", 2)], { swapPct: 90 }));
    const { deps, calls } = fakeDeps(db, "/nonexistent", [90, 50]);
    await runLifecycle(plan, { ...DEFAULT_LIFECYCLE, mode: "on" }, deps);
    expect(calls).toEqual([["archive", "s1"], ["kill", "s1"]]);
  });
});

describe("config", () => {
  test("default observe, string and object forms, bad values refused", () => {
    expect(parseLifecycle(undefined).mode).toBe("observe");
    expect(parseLifecycle("on").mode).toBe("on");
    expect(parseLifecycle({ mode: "off", authorIdleMin: 120, swapPct: 80 })).toMatchObject({ mode: "off", authorIdleMin: 120, swapPct: 80, reviewerIdleMin: 360 });
    expect(() => parseLifecycle("yes")).toThrow();
    expect(() => parseLifecycle({ swapPct: 150 })).toThrow();
    expect(() => parseLifecycle({ bogus: 1 })).toThrow();
  });
});
