/**
 * LIFE1 card worker lifecycle: synthetic ledger + fake registry / tmux facts + fake manager. Covers the acceptance lines: finished
 * card → author and reviewer collected; merge author idle 7h retired, 1h kept; frozen card and user agents untouched; swap backstop
 * idle-longest first without touching a live turn; observe has no side effects; disk measured and the worktree removed.
 * Old red, new green: a PM-tool `-once` reviewer of a verified card is not a scheduler retire candidate, but the lifecycle collects it.
 * r3 review fixes: session identity (a reused name is kept), recent turn protects stopped agents too, scheduler-bound sessions are the
 * scheduler's, an unreadable card extra is skipped, no park (every collection retires), a kept checkout keeps its temp folder and
 * leaves a pending cleanup that later passes retry, observe reads the lend journal without writing it.
 * r4 review fixes: a due scheduler-bound session is listed in kept with BOUND_WAIT and counted (应收 / 调度绑定待收 K) until LIFE3;
 * a cleanup retry checks every current holder of its checkouts (a same-name new session included) and keeps the frozen / protected /
 * recent guards; a retry closes only its own pending row (agent + regAt), other sessions' debts stay owed.
 * r5 review fixes: a holder is anyone not `stopped` (scheduler-retire.ts: status, pending and window together), in the planner and in
 * the executor's temp folder step, also when the checkout is already gone; unresolved registration failures show as 登记失败 N.
 * r6 review fix: a registration failing after its INSERT (registry re-read / kind save) closes that row with the failure event, so a
 * full tick never archives / removes the kept agent and it counts as 登记失败 N.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE, parseLifecycle, type LifecyclePolicy } from "../src/lib/agent-lifecycle-config.js";
import { activeWorkers, cardWorkerIndex, pendingCleanups, recordRegisterFailure, recordWorkerRetire, registerFailures, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { BOUND_WAIT, planLifecycle, lifecycleLine, type AgentFacts, type PlanInput } from "../src/lib/agent-lifecycle.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";
import { registerCreated, type RegisterDeps } from "../src/manager/create-lifecycle.js";
import type { Registry } from "../src/manager/core.js";
import { ledgerFacts, lendAgents } from "../src/lib/agent-lifecycle-deps.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { retireCandidates } from "../src/lib/scheduler-retire.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { claudeTmpDirFor } from "../src/lib/scheduler-retire-tmp.js";

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
  ({ name, status: "active", sessionId: "s", running: true, idleMs: idleH === null ? null : idleH * H, turnActive: false, ...more });

function input(db: ReturnType<typeof ledger>["db"], agents: AgentFacts[], over: Partial<PlanInput> = {}): PlanInput {
  return { now: NOW, policy: { ...DEFAULT_LIFECYCLE }, agents, index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: new Set(),
    master: new Set(["master"]), swapPct: 10, ...over };
}

describe("plan", () => {
  test("old red / new green: a PM-tool -once reviewer of a verified card is collected; scheduler retire never saw it", () => {
    const { db, card } = ledger();
    card("T1", "verified");
    registerWorker(db, { agent: "agent-t1-claude-local", sessionId: "s1", taskId: "T1", role: "author", createdBy: "agent-pm", now: 1 });
    registerWorker(db, { agent: "agent-t1-once", sessionId: "s2", taskId: "T1", role: "reviewer", createdBy: "agent-pm", now: 2 });
    expect(retireCandidates(db, ["p"])).toEqual([]); // the old path has nothing bound, so both would live forever
    const plan = planLifecycle(input(db, [agent("agent-t1-claude-local", 2, { sessionId: "s1" }), agent("agent-t1-once", 2, { sessionId: "s2" })]));
    expect(plan.actions.map((a) => [a.agent, a.rule, a.sessionId])).toEqual([
      ["agent-t1-claude-local", "card_finished", "s1"], ["agent-t1-once", "card_finished", "s2"]]);
    expect(lifecycleLine(plan, "observe")).toBe("worker agent：活 2 / 应收 2 / swap 10%（lifecycle observe）");
  });

  test("merge author: idle 7h retired (no park), idle 1h kept; a turn in the last 30 min is never touched", () => {
    const { db, card } = ledger();
    card("T2", "merge"); card("T3", "merge"); card("T4", "verified");
    registerWorker(db, { agent: "a2", sessionId: "s", taskId: "T2", role: "author", createdBy: "pm", now: 1 });
    registerWorker(db, { agent: "a3", sessionId: "s", taskId: "T3", role: "author", createdBy: "pm", now: 2 });
    registerWorker(db, { agent: "a4", sessionId: "s", taskId: "T4", role: "author", createdBy: "pm", now: 3 });
    const plan = planLifecycle(input(db, [agent("a2", 7), agent("a3", 1), agent("a4", 0.2)]));
    expect(plan.actions.map((a) => [a.agent, a.rule])).toEqual([["a2", "author_idle"]]);
  });

  test("recent turn protects a stopped agent too; a stopped agent with no activity record can be collected", () => {
    const { db, card } = ledger();
    card("R1", "verified"); card("R2", "verified");
    registerWorker(db, { agent: "just-stopped", sessionId: "s", taskId: "R1", role: "reviewer", createdBy: "pm", now: 1 });
    registerWorker(db, { agent: "long-gone", sessionId: "s", taskId: "R2", role: "reviewer", createdBy: "pm", now: 2 });
    const plan = planLifecycle(input(db, [agent("just-stopped", 1 / 60, { running: false, status: "stopped" }),
      agent("long-gone", null, { running: false, status: "stopped" })]));
    expect(plan.actions.map((a) => a.agent)).toEqual(["long-gone"]);
    // running with unknown activity: might be mid-use, kept
    expect(planLifecycle(input(db, [agent("just-stopped", null)])).actions).toEqual([]);
  });

  test("session identity: a name reused by a new (unregistered) session, or an unknown session, is kept and reported", () => {
    const { db, card } = ledger();
    card("U1", "verified");
    registerWorker(db, { agent: "agent-personal", sessionId: "personal-session", taskId: "U1", role: "reviewer", createdBy: "pm", now: 1 });
    const reused = planLifecycle(input(db, [agent("agent-personal", 7, { sessionId: "new-unregistered-session" })]));
    expect(reused.actions).toEqual([]);
    expect(reused.kept.map((k) => k.agent)).toEqual(["agent-personal"]);
    expect(reused.kept[0].reason).toContain("new-unregistered-session");
    const unknown = planLifecycle(input(db, [agent("agent-personal", 7, { sessionId: undefined })]));
    expect([unknown.actions, unknown.kept.map((k) => k.agent)]).toEqual([[], ["agent-personal"]]);
    // positive control: the registered session itself is collected
    expect(planLifecycle(input(db, [agent("agent-personal", 7, { sessionId: "personal-session" })])).actions.map((a) => a.agent)).toEqual(["agent-personal"]);
  });

  test("scheduler-bound sessions on unfinished cards: due by idle or memory → kept with BOUND_WAIT and counted as K, until LIFE3", () => {
    const { db, card } = ledger();
    card("B1", "merge"); card("B2", "blocked"); card("B3", "build");
    db.exec("PRAGMA foreign_keys = OFF");
    const bind = (task: string, a: string) => db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, createIntentId, state, createdAt, updatedAt)
      VALUES (?, 'author', ?, ?, 'claude', 'tmux', ?, 'active', 1, 1)`).run(task, a, `s-${a}`, `i-${a}`);
    bind("B1", "bound1"); bind("B2", "bound2"); bind("B3", "bound3");
    // bound1: merge, idle 9h (idle rule due); bound2: blocked, idle 2h (only the memory backstop); bound3: in-progress card, never
    const plan = planLifecycle(input(db, [agent("bound1", 9), agent("bound2", 2), agent("bound3", 9)], { swapPct: 99 }));
    expect([plan.actions, plan.memory]).toEqual([[], []]);
    expect(plan.kept.map((k) => [k.agent, k.bound])).toEqual([["bound1", true], ["bound2", true]]);
    for (const k of plan.kept) expect(k.reason).toContain(BOUND_WAIT);
    expect(plan.kept[1].reason).toContain("swap 99%");
    expect(lifecycleLine(plan, "on")).toBe("worker agent：活 3 / 应收 2（调度绑定待收 2） / swap 99%（lifecycle on）");
    // swap fine and idle short: nothing due, nothing counted
    const calm = planLifecycle(input(db, [agent("bound1", 1), agent("bound2", 2)], { swapPct: 10 }));
    expect([calm.kept, lifecycleLine(calm, "on")]).toEqual([[], "worker agent：活 2 / 应收 0 / swap 10%（lifecycle on）"]);
  });

  test("a card whose extra cannot be parsed is skipped and reported (frozen unknown), not read as unfrozen", () => {
    const { db, card } = ledger();
    card("X1", "verified");
    registerWorker(db, { agent: "x1", sessionId: "s", taskId: "X1", role: "author", createdBy: "pm", now: 1 });
    db.query("UPDATE tasks SET extra = '{broken' WHERE id = 'X1'").run();
    const plan = planLifecycle(input(db, [agent("x1", 50)], { swapPct: 99 }));
    expect([plan.actions, plan.memory, plan.frozen]).toEqual([[], [], []]);
    expect(plan.kept[0]).toMatchObject({ agent: "x1" });
    expect(plan.kept[0].reason).toContain("extra 读不出");
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
    expect(plan.actions.map((a) => [a.agent, a.rule])).toEqual([["r7", "reviewer_done"]]);
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
    expect(plan.memory.map((a) => [a.agent, a.rule])).toEqual([["m2", "memory"], ["m1", "memory"]]);
    expect(planLifecycle(input(db, agents, { swapPct: 60 })).memory).toEqual([]);
  });
});

describe("run", () => {
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };

  function fakeDeps(db: ReturnType<typeof ledger>["db"], root: string, swaps: number[] = [], live: Awaited<ReturnType<LifecycleDeps["agents"]>> = []) {
    const calls: string[][] = [];
    const deps: LifecycleDeps = {
      manager: async (...args) => { calls.push(args); return args[0] === "archive" ? { ok: true, archived: ["a.jsonl"] } : { ok: true, message: "done" }; },
      git, exists: existsSync, worktreeRoot: root, agents: async () => live,
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
    expect(r.done).toEqual([{ agent: "agent-w1", rule: "card_finished", freed: 4096 }]);
    expect(existsSync(join(root, "w1"))).toBe(false);
    const ev = listEvents(db, { project: "p" }).filter((e) => (e.data as { op?: string }).op === "worker_retire");
    expect(ev.map((e) => (e.data as Record<string, unknown>).bytesFreed)).toEqual([4096]);
    expect(activeWorkers(db)).toEqual([]);
    await runLifecycle(plan, on, deps); // PM already removed it / second pass: no throw, still one closed row
    expect(activeWorkers(db)).toEqual([]);
  });

  test("r6: ledger INSERT ok, then the registry re-read or kind save fails: no active row; planner and runner never archive / remove it; 登记失败 +1", async () => {
    for (const step of ["reload", "save"] as const) {
      const { db, dir, card } = ledger();
      card("H1", "verified");
      const reg = { socket: "", agents: { "agent-review": { sessionId: "s", channelId: "9" } } } as unknown as Registry;
      let loads = 0;
      const regDeps: RegisterDeps = { ledgerPath: join(dir, "ledger.sqlite"), createdBy: async () => "agent-pm",
        loadRegistry: async () => { if (step === "reload" && ++loads === 2) throw new Error("synthetic registry re-read failure"); return reg; },
        saveRegistry: async () => { if (step === "save") throw new Error("synthetic registry save failure"); },
        recordFailure: (f) => recordRegisterFailure(db, f) };
      const out = await registerCreated("agent-review", { taskId: "H1", role: "reviewer" }, { ok: true, agent: "agent-review", sessionId: "s" }, null, regDeps);
      expect(out).toMatchObject({ ok: false, registered: false, kept: true });
      expect(activeWorkers(db)).toEqual([]);
      const row = db.query("SELECT state, reason FROM worker_agents WHERE agent = 'agent-review'").get() as { state: string; reason: string };
      expect([row.state, row.reason.startsWith("register_failed:")]).toEqual(["retired", true]);
      // the untagged session runs on, idle past the recent-turn guard, its card verified: a full tick leaves it alone
      const facts = agent("agent-review", 1);
      const plan = planLifecycle(input(db, [facts], { registerFailed: registerFailures(db) }));
      expect([plan.actions, plan.memory, plan.registerFailed]).toEqual([[], [], 1]);
      expect(lifecycleLine(plan, "on")).toContain("登记失败 1");
      const { deps, calls } = fakeDeps(db, join(dir, "worktrees"));
      expect(await runLifecycle(plan, { ...DEFAULT_LIFECYCLE, mode: "on" }, deps)).toEqual({ done: [], failed: [] });
      expect(calls).toEqual([]);
    }
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
    expect(calls).toEqual([["archive", "s1"], ["remove", "s1"]]);
  });

  test("the session is re-checked before anything is touched: a name re-created since the plan is left alone", async () => {
    const { db, card } = ledger();
    card("I1", "verified");
    registerWorker(db, { agent: "i1", sessionId: "s", taskId: "I1", role: "reviewer", createdBy: "pm", now: 1 });
    const plan = planLifecycle(input(db, [agent("i1", 7)]));
    expect(plan.actions.length).toBe(1);
    const { deps, calls } = fakeDeps(db, "/nonexistent", [], [{ name: "i1", status: "active", sessionId: "user-new", cwd: "/x", pending: false, window: true }]);
    const r = await runLifecycle(plan, { ...DEFAULT_LIFECYCLE, mode: "on" }, deps);
    expect(calls).toEqual([]);
    expect(r.failed[0].error).toContain("user-new");
    expect(activeWorkers(db).map((w) => w.agent)).toEqual(["i1"]);
  });

  test("dirty checkout: worktree and its temp evidence both kept, row left as a pending cleanup, reported failed; once clean a later pass finishes it; replay is harmless", async () => {
    const { db, dir, card } = ledger();
    card("D1", "verified");
    const repo = join(dir, "repo"), root = join(dir, "worktrees"), tmpRoot = join(dir, "claude-tmp"), wt = join(root, "d1");
    mkdirSync(repo); mkdirSync(root); mkdirSync(tmpRoot);
    sh(repo, "init", "-q"); sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    sh(repo, "worktree", "add", "-q", "--detach", wt);
    writeFileSync(join(wt, "evidence.txt"), "uncommitted");
    const tmpDir = claudeTmpDirFor(wt, tmpRoot);
    mkdirSync(tmpDir, { recursive: true }); writeFileSync(join(tmpDir, "tool-output"), "evidence");
    registerWorker(db, { agent: "agent-d1", sessionId: "s", taskId: "D1", role: "author", createdBy: "pm", now: 1 });
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const { deps, calls } = fakeDeps(db, root);
    deps.tmp = { root: tmpRoot, rm: (p) => rm(p, { recursive: true }) };
    const first = await runLifecycle(planLifecycle(input(db, [agent("agent-d1", 7, { cwd: wt })])), on, deps);
    expect(calls).toEqual([["archive", "agent-d1"], ["remove", "agent-d1"]]);
    expect([first.done, first.failed.map((f) => f.agent)]).toEqual([[], ["agent-d1"]]);
    expect([existsSync(join(wt, "evidence.txt")), existsSync(join(tmpDir, "tool-output"))]).toEqual([true, true]);
    expect(activeWorkers(db)).toEqual([]); // no longer an agent...
    expect(pendingCleanups(db)).toMatchObject([{ agent: "agent-d1", sessionId: "s", entries: [{ checkout: wt, tmp: tmpDir }] }]); // ...but a disk debt
    // the agent is gone from the registry now: the next plan carries only the retry, and doctor's line shows it
    const again = planLifecycle(input(db, [], { pending: pendingCleanups(db) }));
    expect(again.cleanups.map((a) => [a.agent, a.rule])).toEqual([["agent-d1", "cleanup_retry"]]);
    expect(lifecycleLine(again, "on")).toContain("待补清 1");
    const stillDirty = await runLifecycle(again, on, deps);
    expect(stillDirty.failed.map((f) => f.agent)).toEqual(["agent-d1"]);
    expect(existsSync(join(tmpDir, "tool-output"))).toBe(true);
    rmSync(join(wt, "evidence.txt")); // PM saved the evidence and cleaned up
    const retried = await runLifecycle(planLifecycle(input(db, [], { pending: pendingCleanups(db) })), on, deps);
    expect([retried.done.map((d) => d.agent), retried.failed]).toEqual([["agent-d1"], []]);
    expect([existsSync(wt), existsSync(tmpDir)]).toEqual([false, false]);
    expect(pendingCleanups(db)).toEqual([]);
    expect(calls.filter((c) => c[0] === "remove").length).toBe(1); // retries never stop anything
    const replay = await runLifecycle(planLifecycle(input(db, [], { pending: pendingCleanups(db) })), on, deps);
    expect(replay).toEqual({ done: [], failed: [] });
    const evs = listEvents(db, { project: "p" }).filter((e) => (e.data as { op?: string }).op === "worker_retire");
    expect(evs.map((e) => (e.data as { pending: unknown[] }).pending.length)).toEqual([1, 1, 0]);
  });

  /** One linked worktree in a fresh repo under `root`. */
  function worktree(dir: string, name: string) {
    const repo = join(dir, "repo"), root = join(dir, "worktrees"), wt = join(root, name);
    if (!existsSync(repo)) {
      mkdirSync(repo); mkdirSync(root);
      sh(repo, "init", "-q"); sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    }
    sh(repo, "worktree", "add", "-q", "--detach", wt);
    return { root, wt };
  }
  const debt = (db: ReturnType<typeof ledger>["db"], agent: string, sessionId: string, taskId: string, checkout: string) =>
    recordWorkerRetire(db, "scheduler", { agent, sessionId, taskId, role: "author", rule: "card_finished", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout, tmp: null }], retry: false });

  test("stale-session-ownership: a same-name new session working in the old checkout keeps it (plan and executor both check holders)", async () => {
    const { db, dir, card } = ledger();
    card("R1", "verified");
    const { root, wt } = worktree(dir, "r1");
    registerWorker(db, { agent: "agent-r1", sessionId: "old", taskId: "R1", role: "author", createdBy: "pm", now: 1 });
    debt(db, "agent-r1", "old", "R1", wt);
    const newcomer = agent("agent-r1", 0, { sessionId: "new", cwd: wt, turnActive: true });
    // planner: the name is recent, and something works in the checkout → kept, not retried
    const plan = planLifecycle(input(db, [newcomer], { pending: pendingCleanups(db) }));
    expect([plan.cleanups, plan.kept.map((k) => k.agent)]).toEqual([[], ["agent-r1"]]);
    // executor, fed a stale plan made before the newcomer existed: it re-reads live agents, no name is excluded on a retry
    const stale = planLifecycle(input(db, [], { pending: pendingCleanups(db) }));
    expect(stale.cleanups.map((c) => c.rule)).toEqual(["cleanup_retry"]);
    const { deps } = fakeDeps(db, root, [], [{ name: "agent-r1", status: "active", sessionId: "new", cwd: wt, pending: false, window: true }]);
    const r = await runLifecycle(stale, { ...DEFAULT_LIFECYCLE, mode: "on" }, deps);
    expect([existsSync(wt), r.done, r.failed.map((f) => f.agent)]).toEqual([true, [], ["agent-r1"]]);
    expect(pendingCleanups(db).length).toBe(1); // still owed
  });

  test("stale-session-ownership: checkout gone, temp evidence left; a same-name new session stopped but pending / windowed keeps it", async () => {
    const { db, dir, card } = ledger();
    card("O1", "verified");
    const root = join(dir, "worktrees"), tmpRoot = join(dir, "claude-tmp"), gone = join(root, "o1");
    mkdirSync(root); mkdirSync(tmpRoot);
    const tmpDir = claudeTmpDirFor(gone, tmpRoot);
    mkdirSync(tmpDir); writeFileSync(join(tmpDir, "evidence"), "x");
    registerWorker(db, { agent: "old-holder", sessionId: "old", taskId: "O1", role: "author", createdBy: "pm", now: 1 });
    recordWorkerRetire(db, "scheduler", { agent: "old-holder", sessionId: "old", taskId: "O1", role: "author", rule: "card_finished", reason: "t",
      idleMs: 1, bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: gone, tmp: tmpDir }], retry: false });
    // planner: status stopped but its window still runs (idle 10h, so not "recent") → a holder, kept
    const newcomer = agent("old-holder", 10, { sessionId: "new", status: "stopped", running: true, cwd: gone });
    const plan = planLifecycle(input(db, [newcomer], { pending: pendingCleanups(db) }));
    expect([plan.cleanups, plan.kept.map((k) => k.agent)]).toEqual([[], ["old-holder"]]);
    expect(planLifecycle(input(db, [{ ...newcomer, running: false, pending: true }], { pending: pendingCleanups(db) })).cleanups).toEqual([]);
    // executor, fed a stale plan: stopped + pending, stopped + window each keep the temp folder and the debt
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const stale = planLifecycle(input(db, [], { pending: pendingCleanups(db) }));
    for (const [pending, window] of [[true, true], [true, false], [false, true]]) {
      const { deps } = fakeDeps(db, root, [], [{ name: "old-holder", status: "stopped", sessionId: "new", cwd: gone, pending, window }]);
      deps.tmp = { root: tmpRoot, rm: (p) => rm(p, { recursive: true }) };
      const r = await runLifecycle(stale, on, deps);
      expect([r.done, r.failed.map((f) => f.agent), existsSync(join(tmpDir, "evidence")), pendingCleanups(db).length]).toEqual([[], ["old-holder"], true, 1]);
    }
    // stopped for good (no pending, no window): the retry finishes
    const { deps } = fakeDeps(db, root, [], [{ name: "old-holder", status: "stopped", sessionId: "new", cwd: gone, pending: false, window: false }]);
    deps.tmp = { root: tmpRoot, rm: (p) => rm(p, { recursive: true }) };
    const fin = await runLifecycle(planLifecycle(input(db, [{ ...newcomer, running: false }], { pending: pendingCleanups(db) })), on, deps);
    expect([fin.done.map((d) => d.agent), existsSync(tmpDir), pendingCleanups(db)]).toEqual([["old-holder"], false, []]);
  });

  test("a cleanup retry keeps the frozen / protected / recent guards", () => {
    const { db, dir, card } = ledger();
    card("F1", "verified", { frozen: true }); card("G1", "verified");
    const { wt } = worktree(dir, "f1");
    debt(db, "agent-f1", "s", "F1", wt);
    debt(db, "agent-pm", "s", "G1", join(dir, "worktrees", "gone"));
    debt(db, "agent-g1", "s", "G1", join(dir, "worktrees", "gone2"));
    const plan = planLifecycle(input(db, [agent("agent-pm", 9, { sessionId: "pm-s" }), agent("agent-g1", 0.1, { sessionId: "x", running: false })],
      { pending: pendingCleanups(db) }));
    expect(plan.cleanups).toEqual([]);
    expect(plan.frozen).toEqual([{ agent: "agent-f1", taskId: "F1" }]);
    expect(plan.kept.map((k) => k.agent).sort()).toEqual(["agent-g1", "agent-pm"]);
  });

  test("cleanup-failure-finalized: two sessions' debts under one name; finishing one leaves the other owed and retried", async () => {
    const { db, dir, card } = ledger();
    card("M1", "verified");
    const { root, wt: a } = worktree(dir, "m1a");
    const { wt: b } = worktree(dir, "m1b");
    registerWorker(db, { agent: "agent-m", sessionId: "old", taskId: "M1", role: "author", createdBy: "pm", now: 1 });
    debt(db, "agent-m", "old", "M1", a);
    registerWorker(db, { agent: "agent-m", sessionId: "new", taskId: "M1", role: "author", createdBy: "pm", now: 2 });
    debt(db, "agent-m", "new", "M1", b);
    expect(pendingCleanups(db).map((p) => [p.sessionId, p.createdAt])).toEqual([["old", 1], ["new", 2]]);
    writeFileSync(join(b, "dirty.txt"), "x"); // the new session's debt cannot finish yet
    const { deps } = fakeDeps(db, root);
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const r = await runLifecycle(planLifecycle(input(db, [], { pending: pendingCleanups(db) })), on, deps);
    expect([r.done.map((d) => d.agent), r.failed.map((f) => f.agent)]).toEqual([["agent-m"], ["agent-m"]]);
    expect(pendingCleanups(db).map((p) => [p.sessionId, p.entries.map((e) => e.checkout)])).toEqual([["new", [b]]]);
    // the store itself: a retry names its row; without regAt it is refused rather than closing every debt of the name
    expect(() => recordWorkerRetire(db, "scheduler", { agent: "agent-m", sessionId: "new", taskId: "M1", role: "author", rule: "cleanup_retry",
      reason: "t", idleMs: null, bytesBefore: null, bytesAfter: null, steps: [], now: NOW, pending: [], retry: true })).toThrow("regAt");
    expect(pendingCleanups(db).length).toBe(1);
    rmSync(join(b, "dirty.txt"));
    const fin = await runLifecycle(planLifecycle(input(db, [], { pending: pendingCleanups(db) })), on, deps);
    expect([fin.done.length, existsSync(a), existsSync(b), pendingCleanups(db)]).toEqual([1, false, false, []]);
  });
});

describe("registration failures (create kept the agent for PM)", () => {
  test("counted while the agent still runs that session unregistered or untagged; shown as 登记失败 N", () => {
    const { db, card } = ledger();
    card("E1", "build");
    const fail = (agent: string, sessionId: string) => recordRegisterFailure(db, { agent, sessionId, taskId: "E1", role: "author", createdBy: "agent-pm", reason: "synthetic" });
    fail("agent-e1", "s"); fail("agent-e1", "s"); // the same failure twice counts once
    fail("agent-moved-on", "old"); // the name runs another session now
    fail("agent-fixed", "s"); // PM registered and tagged it since
    registerWorker(db, { agent: "agent-fixed", sessionId: "s", taskId: "E1", role: "author", createdBy: "agent-pm", now: 5 });
    const plan = planLifecycle(input(db, [agent("agent-e1", 1), agent("agent-moved-on", 1, { sessionId: "new" }), agent("agent-fixed", 1, { kind: "worker" })],
      { registerFailed: registerFailures(db) }));
    expect(plan.registerFailed).toBe(1);
    expect(lifecycleLine(plan, "observe")).toContain("/ 登记失败 1（lifecycle observe）");
    expect(plan.actions).toEqual([]); // never collected by the lifecycle: PM's to handle
  });

  test("ledger registered but the registry tag failed: the row closes with the failure; verified card, idle 1h, never collected; PM re-registering and tagging releases it", () => {
    const { db, card } = ledger();
    card("E2", "verified");
    registerWorker(db, { agent: "agent-half", sessionId: "s", taskId: "E2", role: "reviewer", createdBy: "agent-pm", now: 5 });
    recordRegisterFailure(db, { agent: "agent-half", sessionId: "s", taskId: "E2", role: "reviewer", createdBy: "agent-pm", reason: "saveRegistry failed" });
    expect(activeWorkers(db)).toEqual([]);
    const plan = planLifecycle(input(db, [agent("agent-half", 1)], { registerFailed: registerFailures(db) }));
    expect([plan.actions, plan.memory, plan.registerFailed]).toEqual([[], [], 1]);
    // PM registered and tagged it: the failure is resolved and the verified card's agent is collected as usual
    registerWorker(db, { agent: "agent-half", sessionId: "s", taskId: "E2", role: "reviewer", createdBy: "agent-pm", now: 6 });
    const fixed = planLifecycle(input(db, [agent("agent-half", 1, { kind: "worker" })], { registerFailed: registerFailures(db) }));
    expect([fixed.registerFailed, fixed.actions.map((a) => a.agent)]).toEqual([0, ["agent-half"]]);
  });
});

describe("observe reads without writing", () => {
  test("lend journal is read through a read-only connection: no migration, no WAL, no new tables; missing table = none", () => {
    const dir = mkdtempSync(join(tmpdir(), "life1-lend-")), path = join(dir, "lend.sqlite");
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    new Database(path).close(); // an existing, empty journal (user_version 0)
    expect(lendAgents(path)).toEqual(new Set());
    const raw = new Database(path);
    expect([raw.query("PRAGMA user_version").get(), raw.query("SELECT name FROM sqlite_master").all(), raw.query("PRAGMA journal_mode").get()])
      .toEqual([{ user_version: 0 }, [], { journal_mode: "delete" }]);
    raw.exec("CREATE TABLE lend_orders (agent TEXT)"); raw.exec("INSERT INTO lend_orders VALUES ('agent-lend-x'), (NULL)"); raw.close();
    expect(lendAgents(path)).toEqual(new Set(["agent-lend-x"]));
    expect(lendAgents(join(dir, "absent.sqlite"))).toEqual(new Set());
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
