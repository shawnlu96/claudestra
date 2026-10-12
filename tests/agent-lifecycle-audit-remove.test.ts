/**
 * LIFECAS1: the automatic lifecycle remove carries the plan's identity and manager re-checks it on the final objects. Real
 * runLifecycle → real runRemove over the in-memory world (tests/resumable-world.ts) and a temporary ledger; nothing touches tmux,
 * Discord, the bridge or the state dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "../src/lib/agent-lifecycle-config.js";
import { cardWorkerIndex, recordWorkerRetire, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle, type AgentFacts } from "../src/lib/agent-lifecycle.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";
import { ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { runRemove } from "../src/manager/agent-kill.js";
import { lifecycleRemoveOption, parseLifecycleGuard, removeLifecycle, type LifecycleRemoveFacts } from "../src/manager/agent-remove-guard.js";
import type { AgentInfo } from "../src/manager/core.js";
import { makeWorld } from "./resumable-world.js";

const H = 3_600_000, NOW = 100 * H, NAME = "agent-w1";
const ON: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "lifecas1-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]')").run();
  let now = 1000;
  const card = (id: string, stage: string, extra: Record<string, unknown> = {}) => {
    createTask(db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code" });
    db.query("UPDATE tasks SET stage = ?, extra = ? WHERE id = ?").run(stage, JSON.stringify(extra), id);
  };
  return { db, dir, card };
}

const entry = (sessionId: string, more: Partial<AgentInfo> = {}): AgentInfo =>
  ({ project: "p", purpose: "w", created: "c", status: "active", channelId: `ch-${sessionId}`, notes: "", sessionId, cwd: "/nowhere/w1", ...more });

/** One verified card's author, idle 2h, with its window and channel; the activity map is the ACP turn record by agent. */
function scene() {
  const L = ledger();
  L.card("T1", "verified");
  registerWorker(L.db, { agent: NAME, sessionId: "s1", taskId: "T1", role: "author", createdBy: "agent-pm", now: 1 });
  const w = makeWorld({ reg: { socket: "s", agents: { [NAME]: entry("s1") } }, windows: [NAME], channels: new Set(["ch-s1"]) });
  const activity = new Map<string, { sessionId: string; activeAt: number; turnActive: boolean }>([[NAME, { sessionId: "s1", activeAt: NOW - 2 * H, turnActive: false }]]);
  let clock = NOW;
  const facts = (): AgentFacts[] => Object.entries(w.st.reg.agents).map(([name, a]) => {
    const act = activity.get(name);
    const mine = act && act.sessionId === a.sessionId;
    return { name, kind: a.kind, status: a.status, cwd: a.cwd, sessionId: a.sessionId, pending: !!a.pending, running: w.st.windows.includes(name),
      idleMs: mine ? clock - act.activeAt : null, turnActive: !!mine && act.turnActive };
  });
  const plan = (now: number) => planLifecycle({ now, policy: ON, agents: facts(), index: cardWorkerIndex(L.db), ...ledgerFacts(L.db), foreign: new Set(),
    master: new Set(["master"]), swapPct: 10 });
  const locks: string[] = [];
  let replanError: string | null = null;
  const removeFacts: LifecycleRemoveFacts = {
    lock: (name) => {
      if (w.st.restarting.includes(name) || locks.includes(name)) return null;
      locks.push(name);
      return () => { locks.splice(locks.indexOf(name), 1); };
    },
    replan: async () => {
      if (replanError) throw new Error(replanError);
      clock += 1000;
      return { now: clock, plan: plan(clock) };
    },
    commit: async (mutate) => {
      const reg = await w.deps.loadRegistry();
      const why = mutate(reg);
      if (!why) await w.deps.saveRegistry(reg);
      return why;
    },
    dropSettings: () => {},
  };
  const calls: string[][] = [];
  let duringArchive: () => void = () => {};
  const own = mkdtempSync(join(tmpdir(), "lifecas1-gate-"));
  cleanup.push(() => rmSync(own, { recursive: true, force: true }));
  const deps: LifecycleDeps = { cleanupStatePath: join(own, "cleanup.json"), cleanupArchiveRoot: join(own, "archive"), cleanupLedgerPath: L.db.filename,
    planAt: NOW, worktreeRoot: join(own, "worktrees"), exists: () => false,
    git: async () => { throw new Error("no git in this test"); },
    manager: async (...args) => {
      calls.push(args);
      if (args[0] === "archive") {
        duringArchive(); // the archive await: whatever lands here happens between the plan's check and the remove
        const s = args.indexOf("--session");
        const cur = w.st.reg.agents[args[1]];
        if (!cur?.sessionId) return { ok: false, error: `${args[1]} 不在 registry 或无 sessionId` }; // manager.ts archive case order
        if (s > 0 && cur.sessionId !== args[s + 1]) return { ok: false, error: `现在的会话 ${cur.sessionId} 不是 ${args[s + 1]}，不归档` };
        return { ok: true, archived: ["a.jsonl"] };
      }
      // the manager CLI's own parsing (manager.ts remove case) and its remove
      const parsed = lifecycleRemoveOption(args).lifecycle;
      return runRemove(args[1], w.deps, parsed ? { lifecycle: { guard: parsed.guard, facts: removeFacts } } : {});
    },
    agents: async () => Object.entries(w.st.reg.agents).map(([name, a]) => ({ name, status: a.status, sessionId: a.sessionId, cwd: a.cwd, pending: !!a.pending, window: w.st.windows.includes(name) })),
    du: async () => 0, swapPct: async () => 0, now: () => clock, record: async (r) => recordWorkerRetire(L.db, "scheduler", r),
  };
  return { ...L, w, activity, plan, deps, calls, locks, removeFacts, setReplanError: (e: string | null) => { replanError = e; },
    duringArchive: (f: () => void) => { duringArchive = f; } };
}

/** The plan as the scheduler made it at NOW: one card_finished action for the s1 session. */
function planned(s: ReturnType<typeof scene>) {
  const plan = s.plan(NOW);
  expect(plan.actions.map((a) => [a.agent, a.rule, a.sessionId])).toEqual([[NAME, "card_finished", "s1"]]);
  return plan;
}

const removes = (s: ReturnType<typeof scene>) => s.calls.filter((c) => c[0] === "remove");

describe("[验收线 1] archive 等待内换代：零 kill / remove，新代完整，不报 retired", () => {
  test("same name, new session during the archive await", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => {
      // a person removed it and created the name again: new session, new window, new channel
      s.w.st.reg.agents[NAME] = entry("s2");
      s.w.st.windows = [NAME]; s.w.st.winIds = ["@900"]; s.w.st.channels.add("ch-s2");
      s.activity.set(NAME, { sessionId: "s2", activeAt: NOW, turnActive: true });
    });
    const before = structuredClone(entry("s2"));
    const r = await runLifecycle(plan, ON, s.deps);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.agent)).toEqual([NAME]);
    expect(s.w.trace.filter((t) => t.startsWith("killWindow") || t.startsWith("save") || t.startsWith("deleteChannel"))).toEqual([]);
    expect(s.w.st.reg.agents[NAME]).toEqual(before);
    expect(s.w.st.winIds).toEqual(["@900"]);
    expect(s.w.st.channels.has("ch-s2")).toBe(true);
  });

  test("same session, a new turn starts during the archive await", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => s.activity.set(NAME, { sessionId: "s1", activeAt: NOW + 500, turnActive: true }));
    const r = await runLifecycle(plan, ON, s.deps);
    expect(r.done).toEqual([]);
    expect(r.failed[0].error).toContain("生命周期收回拒绝");
    expect(s.w.trace.filter((t) => /^(killWindow|save|deleteChannel)/.test(t))).toEqual([]);
    expect(s.w.st.reg.agents[NAME]).toEqual(entry("s1"));
    expect(s.w.st.windows).toEqual([NAME]);
  });

  test("same session, a turn that already ended (idle again) still refuses: activity newer than the plan", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => s.activity.set(NAME, { sessionId: "s1", activeAt: NOW - 90 * 60_000, turnActive: false }));
    const r = await runLifecycle(plan, ON, s.deps);
    expect(r.failed[0].error).toContain("计划之后有新活动");
    expect(s.w.st.reg.agents[NAME]).toEqual(entry("s1"));
  });

  test("archive names the planned session: an archive after the swap is refused there too", async () => {
    const s = scene(), plan = planned(s);
    let swapped = false;
    s.deps.agents = async () => { // the swap lands before the archive itself: archive --session refuses, remove is never sent
      if (!swapped) { swapped = true; return [{ name: NAME, status: "active", sessionId: "s1", cwd: "/nowhere/w1", pending: false, window: true }]; }
      return [];
    };
    s.duringArchive(() => { s.w.st.reg.agents[NAME] = entry("s2"); });
    const r = await runLifecycle(plan, ON, s.deps);
    expect(r.failed[0].error).toContain("归档没成");
    expect(s.calls).toEqual([["archive", NAME, "--session", "s1"]]);
    expect(s.w.st.reg.agents[NAME]).toEqual(entry("s2"));
  });
});

describe("[验收线 2] 最终锁内重核：读失败 / 活 restart 锁 / 卡保护变化都拒；稳定旧身份正常一次移除", () => {
  test("stable idle old identity: removed exactly once, by window id, archive of that generation", async () => {
    const s = scene(), plan = planned(s);
    const r = await runLifecycle(plan, ON, s.deps);
    expect(r.failed).toEqual([]);
    expect(r.done).toEqual([{ agent: NAME, rule: "card_finished", freed: 0 }]);
    expect(removes(s)).toHaveLength(1);
    expect(removes(s)[0].slice(0, 3)).toEqual(["remove", NAME, "--lifecycle-guard"]);
    expect(parseLifecycleGuard(removes(s)[0][3])).toMatchObject({ sessionId: "s1", taskId: "T1", role: "author", activeAt: NOW - 2 * H });
    expect(s.w.st.reg.agents[NAME]).toBeUndefined();
    expect(s.w.st.windows).toEqual([]);
    expect(s.w.st.archived).toEqual([NAME]);
    expect(s.w.st.channels.has("ch-s1")).toBe(false);
    expect(s.locks).toEqual([]); // the restart lock is released
    const again = await runLifecycle(plan, ON, s.deps); // second pass: gone counts as done, nothing else is touched
    expect(again.failed).toEqual([]);
  });

  const refused = async (s: ReturnType<typeof scene>, plan: ReturnType<typeof planned>, text: string) => {
    const r = await runLifecycle(plan, ON, s.deps);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.agent)).toEqual([NAME]);
    expect(r.failed[0].error).toContain(text);
    if (process.env.LIFECAS1_DEBUG) console.log(r.failed[0].error);
    expect(s.w.st.reg.agents[NAME]).toEqual(entry("s1"));
    expect(s.w.st.windows).toEqual([NAME]);
    expect(s.w.trace.filter((t) => /^(killWindow|save|deleteChannel)/.test(t))).toEqual([]);
    expect(s.locks).toEqual([]);
  };

  test("a live restart lock refuses", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => { s.w.st.restarting.push(NAME); });
    await refused(s, plan, "restart 锁");
  });

  test("the final window read fails (tmux unreadable) → refuses, never read as no window", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => s.w.breakTmux());
    await refused(s, plan, "列不出 tmux 窗口");
  });

  test("the fresh plan cannot be read (ledger / registry / activity) → refuses", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => s.setReplanError("台账读不到"));
    await refused(s, plan, "台账读不到");
  });

  test("the card was frozen after the plan → refuses", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => { s.db.query("UPDATE tasks SET extra = ? WHERE id = 'T1'").run(JSON.stringify({ frozen: true })); });
    await refused(s, plan, "卡已冻结");
  });

  test("the agent became a PM after the plan → refuses", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => { s.db.query("UPDATE meta SET value = ? WHERE project = 'p' AND key = 'pms'").run(JSON.stringify(["agent-pm", NAME])); });
    await refused(s, plan, "按现在的事实已不该收");
  });

  test("the same session was registered to a new, unfinished card → refuses (new card ownership)", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => {
      s.card("T2", "build");
      registerWorker(s.db, { agent: NAME, sessionId: "s1", taskId: "T2", role: "reviewer", createdBy: "agent-pm", now: 2 });
    });
    await refused(s, plan, "生命周期收回拒绝");
  });

  test("an unfinished operation lands on the entry (pending) → refuses", async () => {
    const s = scene(), plan = planned(s);
    s.duringArchive(() => { s.w.st.reg.agents[NAME].pending = { op: "kill", pid: 1, at: NOW } as never; });
    const r = await runLifecycle(plan, ON, s.deps);
    expect(r.done).toEqual([]);
    expect(r.failed[0].error).toContain("未完成的 kill");
    expect(s.w.st.windows).toEqual([NAME]);
  });

  test("the entry changes between the checks and the close → refuses, nothing closed", async () => {
    const s = scene(), plan = planned(s);
    const replan = s.removeFacts.replan;
    s.removeFacts.replan = async (p) => {
      const out = await replan(p);
      s.w.st.reg.agents[NAME] = { ...s.w.st.reg.agents[NAME], notes: "resumed" }; // a write right after the re-plan
      return out;
    };
    const r = await runLifecycle(plan, ON, s.deps);
    expect(r.failed[0].error).toContain("重核期间条目或窗口变了");
    expect(s.w.st.windows).toEqual([NAME]);
    expect(s.w.st.reg.agents[NAME].notes).toBe("resumed");
  });

  test("the registry write-back never deletes a successor: a new generation after the close keeps its entry", async () => {
    const s = scene();
    s.w.deps.archive = async () => { s.w.st.reg.agents[NAME] = entry("s3"); }; // lands while manager archives the closed generation
    const r = await removeLifecycle(NAME, s.w.deps, { guard: { sessionId: "s1", taskId: "T1", role: "author", rule: "card_finished", activeAt: NOW - 2 * H, policy: ON },
      facts: s.removeFacts });
    expect(r.ok).toBe(false);
    expect(r.refused).toBe(true);
    expect(s.w.st.reg.agents[NAME]).toEqual(entry("s3"));
  });

  test("a malformed or empty guard refuses instead of removing by name", async () => {
    const s = scene();
    for (const guard of ["", "{}", "not json", JSON.stringify({ sessionId: "s1", taskId: "T1", role: "boss", rule: "x", activeAt: 1, policy: {} })]) {
      const r = await removeLifecycle(NAME, s.w.deps, { guard, facts: s.removeFacts });
      expect(r).toMatchObject({ ok: false, refused: true });
    }
    expect(lifecycleRemoveOption(["agent-w1"])).toEqual({});
    expect(lifecycleRemoveOption(["agent-w1", "--lifecycle-guard"]).lifecycle?.guard).toBe("");
    expect(lifecycleRemoveOption(["agent-w1", "--lifecycle-guard={}"]).lifecycle?.guard).toBe("{}");
    expect(s.w.st.reg.agents[NAME]).toEqual(entry("s1"));
    expect(s.w.st.windows).toEqual([NAME]);
  });

  test("a plain manual remove keeps its explicit by-name semantics", async () => {
    const s = scene();
    const r = await runRemove(NAME, s.w.deps);
    expect(r.ok).toBe(true);
    expect(s.w.st.reg.agents[NAME]).toBeUndefined();
  });
});
