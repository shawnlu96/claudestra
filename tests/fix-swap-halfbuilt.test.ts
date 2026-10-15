/** SWAPFIX1 2: a half-built family-swap author session is cleared through manager kill and re-planned; anything uncertain stays unknown. */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { runKill } from "../src/manager/agent-kill.js";
import { makeWorld } from "./resumable-world.js";
import { createConvergenceWorker } from "../src/lib/fix-strategy-lifecycle.js";
import { getIntent, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { settleIntent } from "../src/lib/ledger-scheduler-settle.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { CLAIM_LEASE_MS } from "../src/lib/scheduler-dispatch.js";
import { HALF_BUILT_MARK, halfBuiltBackoff, healHalfBuilt, setHalfBuiltIo, shellOnlyVerdict } from "../src/lib/fix-swap-halfbuilt.js";
import { setSelfHealPolicy } from "../src/lib/fix-swap-halfbuilt-sample.js";
import type { LivenessIo } from "../src/lib/worker-liveness.js";
import { convergenceProbe, fourRoundFix } from "./fix-strategy-helpers.js";

type Window = "gone" | "shell" | "busy" | "unreadable";
const io = (name: () => string, w: () => Window): LivenessIo => ({
  windows: async () => { if (w() === "unreadable") throw new Error("tmux down"); return w() === "gone" ? ["agent-other"] : [name()]; },
  panePids: async () => [100],
  ps: async () => w() === "busy" ? "  100     1 -zsh\n  200   100 node /x/codex\n" : "  100     1 -zsh\n",
});

/** The create placeholder create-guard.ts writes; its creating process (pid 4242) was killed at 90 s unless a test says otherwise. */
const MARKER = { op: "create", pid: 4242, startedAt: "2026-10-15T00:00:00.000Z", channelName: "x", windowId: "@100" };
const dead = () => false;

/** A local four-round card: create leaves only a placeholder (no session id), kill removes it, like a create killed at 90 s. */
async function halfBuilt(mode: "on" | "observe" | "off" = "on") {
  const f = await fourRoundFix(), p = convergenceProbe(f);
  let window: Window = "shell", current = "";
  setSelfHealPolicy(f.db, () => ({ mode, manualAfterMs: null, source: "config" }));
  setHalfBuiltIo(f.db, io(() => current, () => window), dead);
  p.deps.manager = async (cmd, name, dir) => {
    p.effects.push(`${cmd}:${name}`);
    p.edit((r) => {
      if (cmd === "create") r.agents[name] = { cwd: dir, status: "active", pending: MARKER };
      if (cmd === "kill") delete r.agents[name];
    });
    return { ok: true };
  };
  let now = 5_000_000;
  const at = (ms = 0) => ({ actor: "scheduler", now: (now += 10 + ms) });
  /** plan, claim and start one swap intent's create; returns it with its session name */
  const start = async () => {
    const planned = p.plan();
    settleIntent(f.db, at(), { id: planned.id, from: "pending", to: "submitted", receipt: "claimed" });
    const intent = getIntent(f.db, planned.id)!;
    current = `agent-cv-t1-fix-${intent.eventSeq}`;
    return { intent, name: current };
  };
  const create = (intent: SchedulerIntent, ms = 0) =>
    createConvergenceWorker(f.db, at(ms), getIntent(f.db, intent.id)!, f.task(), "codex", f.dir, "author", p.deps);
  return { f, p, at, start, create, setWindow: (w: Window) => { window = w; }, now: () => now };
}

test("half-built swap author is cleared, cancelled and re-planned after the backoff; the third half-built stays unknown", async () => {
  const h = await halfBuilt();
  try {
    for (const [n, window] of [[1, "shell"], [2, "gone"], [3, "shell"]] as const) {
      h.setWindow(window);
      const { intent, name } = await h.start();
      if (n > 1) { // the re-planned swap waits the retryCleanCreate backoff before it creates again
        expect(await h.create(intent)).toMatchObject({ wait: expect.stringContaining("半建"), tree: true });
        expect(h.p.effects.filter((e) => e === `create:${name}`)).toEqual([]);
      }
      expect(await h.create(intent, n > 1 ? 16 * 60_000 : 0)).toMatchObject({ wait: expect.stringContaining("等待 registry session id") });
      const out = await h.create(intent, CLAIM_LEASE_MS);
      if (n < 3) {
        expect(out).toMatchObject({ wait: expect.stringContaining(HALF_BUILT_MARK), tree: true }); // [验收线 3]
        expect(getIntent(h.f.db, intent.id)).toMatchObject({ status: "cancelled", receipt: expect.stringContaining(HALF_BUILT_MARK) });
        expect(h.p.effects).toContain(`kill:${name}`);
        expect(h.p.raw().agents[name]).toBeUndefined();
        expect(halfBuiltBackoff(h.f.db, "T1", h.now())).toContain(`连续 ${n} 次`);
      } else {
        expect(getIntent(h.f.db, intent.id)?.status).toBe("unknown"); // [验收线 3]
        expect(h.p.effects).not.toContain(`kill:${name}`);
      }
    }
    const samples = listEvents(h.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "fix_swap_selfheal");
    expect(samples.map((e) => e.data)).toMatchObject([{ mechanism: "authorRebuild", action: "halfbuilt-rebuild", nth: 1, window: "shell" },
      { mechanism: "authorRebuild", action: "halfbuilt-rebuild", nth: 2, window: "gone" }]);
  } finally { h.f.close(); }
});

test("an unknown process in the window, unreadable tmux, a registry session id or a manual card keep unknown without cleanup", async () => {
  for (const broken of ["busy", "unreadable", "session", "manual"] as const) {
    const h = await halfBuilt();
    try {
      const { intent, name } = await h.start();
      await h.create(intent);
      if (broken === "busy" || broken === "unreadable") {
        h.setWindow(broken);
        await h.create(intent, CLAIM_LEASE_MS);
        expect(getIntent(h.f.db, intent.id)?.status).toBe("unknown"); // [验收线 3]
      } else {
        if (broken === "session") h.p.edit((r) => { r.agents[name].sessionId = "late-session"; delete r.agents[name].pending; });
        if (broken === "manual") h.f.db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'");
        expect(await healHalfBuilt(h.f.db, h.at(CLAIM_LEASE_MS), getIntent(h.f.db, intent.id)!, h.f.task(), name, "author", h.p.deps)).toBeNull(); // [验收线 3]
        expect(getIntent(h.f.db, intent.id)?.status).toBe("submitted");
      }
      expect(h.p.effects).not.toContain(`kill:${name}`);
      expect(h.p.raw().agents[name]).toBeDefined();
    } finally { h.f.close(); }
  }
});

test("observe records the would-be cleanup once and stays unknown; off is the old unknown with nothing recorded", async () => {
  for (const mode of ["observe", "off"] as const) {
    const h = await halfBuilt(mode);
    try {
      const { intent, name } = await h.start();
      await h.create(intent);
      await h.create(intent, CLAIM_LEASE_MS);
      expect(getIntent(h.f.db, intent.id)).toMatchObject({ status: "unknown", receipt: "新收敛会话创建已认领但未确认 session id，不重复创建" }); // [验收线 4]
      expect(h.p.effects).not.toContain(`kill:${name}`);
      const notes = listEvents(h.f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "authorRebuild");
      expect(notes.length).toBe(mode === "observe" ? 1 : 0);
      expect(listEvents(h.f.db, { project: "p", target: "T1" }).some((e) => e.data.op === "fix_swap_selfheal")).toBe(false);
    } finally { h.f.close(); }
  }
});

test("only bare shells with no child process count as a half-built window", () => {
  expect(shellOnlyVerdict([100], "100 1 -zsh\n")).toBe("shell");
  expect(shellOnlyVerdict([100, 101], "100 1 /bin/bash -l\n101 1 zsh\n")).toBe("shell");
  expect(shellOnlyVerdict([100], "100 1 -zsh\n200 100 claude --resume x\n")).toBe("busy");
  expect(shellOnlyVerdict([100], "100 1 node /src/acp-host.ts\n")).toBe("busy");
  expect(shellOnlyVerdict([100], "300 1 -zsh\n")).toBe("unknown");
  expect(shellOnlyVerdict([], "")).toBe("unknown");
});

// SWAPFIX1 r1 review: the cleanup's permission is read again after the tmux / ps awaits, right before the kill and the settle.
test("authorRebuild turned off or a PM takeover during the window probe leaves the half-built session alone", async () => {
  for (const flip of ["off", "observe", "manual", "rebuilt-off-during-kill"] as const) {
    const h = await halfBuilt();
    try {
      const { intent, name } = await h.start();
      await h.create(intent);
      const base = io(() => name, () => "shell");
      const turn = () => {
        if (flip === "manual") h.f.db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'");
        else setSelfHealPolicy(h.f.db, () => ({ mode: flip === "observe" ? "observe" : "off", manualAfterMs: null, source: "config" }));
      };
      setHalfBuiltIo(h.f.db, { ...base, windows: async () => { if (flip !== "rebuilt-off-during-kill") turn(); return base.windows(); } }, dead);
      if (flip === "rebuilt-off-during-kill") {
        const manager = h.p.deps.manager;
        h.p.deps.manager = async (...args) => { const r = await manager(...args); if (args[0] === "kill") turn(); return r; };
      }
      expect(await healHalfBuilt(h.f.db, h.at(CLAIM_LEASE_MS), getIntent(h.f.db, intent.id)!, h.f.task(), name, "author", h.p.deps)).toBeNull(); // [验收线 4]
      expect(getIntent(h.f.db, intent.id)?.status).toBe("submitted");
      if (flip !== "rebuilt-off-during-kill") expect(h.p.effects).not.toContain(`kill:${name}`);
      const events = listEvents(h.f.db, { project: "p", target: "T1" });
      expect(events.some((e) => e.data.op === "fix_swap_selfheal")).toBe(false);
      expect(events.some((e) => e.data.op === "recovery_observe" && e.data.mechanism === "authorRebuild")).toBe(false);
    } finally { h.f.close(); }
  }
});

test("a half-built session whose window and registry placeholder are both already gone is a finished cleanup", async () => {
  const h = await halfBuilt();
  try {
    const { intent, name } = await h.start();
    await h.create(intent);
    h.p.edit((r) => { delete r.agents[name]; });
    h.setWindow("gone");
    h.p.deps.manager = async (cmd, agent) => { h.p.effects.push(`${cmd}:${agent}`); return { ok: false, error: `${agent} 不存在` }; }; // runKill's strict nothing-there answer
    const out = await h.create(intent, CLAIM_LEASE_MS);
    expect(out).toMatchObject({ wait: expect.stringContaining(HALF_BUILT_MARK), tree: true }); // [验收线 3]
    expect(getIntent(h.f.db, intent.id)?.status).toBe("cancelled");
  } finally { h.f.close(); }
});

test("a failed kill other than strictly nothing-there stays unknown", async () => {
  const h = await halfBuilt();
  try {
    const { intent, name } = await h.start();
    await h.create(intent);
    h.p.deps.manager = async (cmd, agent) => { h.p.effects.push(`${cmd}:${agent}`); return { ok: false, error: `${agent} 正在 restart（窗口在重建），等它结束再 kill` }; };
    await h.create(intent, CLAIM_LEASE_MS);
    expect(getIntent(h.f.db, intent.id)?.status).toBe("unknown"); // [验收线 3]
  } finally { h.f.close(); }
});

// The manager kill child reads the registry after this process did. The kill is only sent for a placeholder whose creating process is
// dead and carries that marker (`--expect-create`); runKill refuses unless the entry is still it, then clears it through create-guard.
async function killWorld() {
  const h = await halfBuilt();
  const { intent, name } = await h.start();
  await h.create(intent);
  const world = makeWorld({ windows: [name] });
  world.deps.alive = (pid) => pid !== MARKER.pid; // the child's own pid check: the 90 s-killed creator is gone
  let entry: (() => void) | null = null;
  h.p.deps.manager = async (cmd, agent, ...rest) => {
    h.p.effects.push(`${cmd}:${agent}`);
    entry?.(); // what happens between this process's last read and the child's first one
    world.st.reg = { socket: "s", agents: h.p.raw().agents };
    const ec = /^(\d+)@(.+)$/.exec(rest[rest.indexOf("--expect-create") + 1] ?? ""); // manager.ts's kill argument parsing
    const out = await runKill(agent, world.deps, ec ? { expectCreate: { pid: Number(ec[1]), startedAt: ec[2] } } : {});
    writeFileSync(h.p.deps.registryPath!, JSON.stringify({ ...h.p.raw(), agents: world.st.reg.agents }));
    return out;
  };
  const heal = () => healHalfBuilt(h.f.db, h.at(CLAIM_LEASE_MS), getIntent(h.f.db, intent.id)!, h.f.task(), name, "author", h.p.deps);
  return { h, intent, name, world, heal, onEntry: (f: () => void) => { entry = f; } };
}

test("halfbuilt-session-race: a create still running past the claim lease is never killed, even if it finishes as the kill starts", async () => {
  const k = await killWorld();
  try {
    setHalfBuiltIo(k.h.f.db, io(() => k.name, () => "shell"), (pid) => pid === MARKER.pid); // the creator is alive, only slow
    k.onEntry(() => { // the late create completes: a real session in a busy window
      k.h.p.edit((r) => { r.agents[k.name] = { cwd: k.h.f.dir, status: "active", sessionId: "late-session" }; });
      k.world.st.busyWindows.push(k.name);
    });
    expect(await k.heal()).toBeNull(); // [验收线 3]
    expect(k.h.p.effects).not.toContain(`kill:${k.name}`);
    expect(k.world.st.windows).toEqual([k.name]);
    expect(k.world.st.archived).toEqual([]);
    expect(getIntent(k.h.f.db, k.intent.id)?.status).toBe("submitted");
  } finally { k.h.f.close(); }
});

test("a dead creator's placeholder goes through runKill's marker-checked residue cleanup; a fresh create taking the name is left alone", async () => {
  for (const race of [false, true]) {
    const k = await killWorld();
    try {
      if (race) k.onEntry(() => { // another create took the name between the checks: its live marker is not ours
        k.h.p.edit((r) => { r.agents[k.name] = { cwd: k.h.f.dir, status: "active", pending: { ...MARKER, pid: process.pid, startedAt: new Date(k.world.deps.now()).toISOString() } }; });
      });
      const out = await k.heal();
      if (!race) {
        expect(out).toContain(HALF_BUILT_MARK); // [验收线 3]
        expect(k.world.st.windows).toEqual([]);
        expect(k.h.p.raw().agents[k.name]).toBeUndefined();
        expect(getIntent(k.h.f.db, k.intent.id)?.status).toBe("cancelled");
      } else {
        expect(out).toBeNull(); // [验收线 3]
        expect(k.world.st.windows).toEqual([k.name]);
        expect(k.h.p.raw().agents[k.name].pending.pid).toBe(process.pid);
        expect(getIntent(k.h.f.db, k.intent.id)?.status).toBe("submitted");
      }
      expect(k.world.st.archived).toEqual([]);
    } finally { k.h.f.close(); }
  }
});

test("a registry entry that is not a create placeholder, or a shell window no entry owns, is not cleared", async () => {
  for (const shape of ["no-marker", "orphan-window"] as const) {
    const k = await killWorld();
    try {
      k.h.p.edit((r) => { if (shape === "no-marker") delete r.agents[k.name].pending; else delete r.agents[k.name]; });
      setHalfBuiltIo(k.h.f.db, io(() => k.name, () => "shell"), dead);
      expect(await k.heal()).toBeNull(); // [验收线 3]
      expect(k.h.p.effects).not.toContain(`kill:${k.name}`);
    } finally { k.h.f.close(); }
  }
});

test("halfbuilt-session-race: a same-name create that completes before the kill child reads the registry is never killed by name", async () => {
  const k = await killWorld();
  try {
    let args: string[] = [];
    const send = k.h.p.deps.manager;
    k.h.p.deps.manager = async (...a) => { args = a; return send(...a); };
    k.onEntry(() => { // the dead placeholder was cleared by another create that finished: a real session, no pending, a new busy window
      k.h.p.edit((r) => { r.agents[k.name] = { cwd: k.h.f.dir, status: "active", sessionId: "fresh-session", windowId: "@101" }; });
      k.world.st.windows = [k.name]; k.world.st.winIds = ["@101"]; k.world.st.busyWindows.push(k.name);
    });
    expect(await k.heal()).toBeNull(); // [验收线 3]
    expect(args).toEqual(["kill", k.name, "--expect-create", `${MARKER.pid}@${MARKER.startedAt}`]);
    expect(k.world.st.windows).toEqual([k.name]);
    expect(k.world.st.archived).toEqual([]);
    expect(k.h.p.raw().agents[k.name]).toMatchObject({ status: "active", sessionId: "fresh-session" });
    expect(getIntent(k.h.f.db, k.intent.id)?.status).toBe("submitted");
  } finally { k.h.f.close(); }
});

test("an expect-create kill refuses, untouched, any entry that is not that dead marker", async () => {
  const expectCreate = { pid: MARKER.pid, startedAt: MARKER.startedAt };
  const entries: Record<string, Record<string, unknown>> = {
    session: { status: "active", sessionId: "s1", pending: MARKER },
    other: { status: "active", pending: { ...MARKER, startedAt: "2026-10-15T00:00:01.000Z" } },
    live: { status: "active", pending: MARKER },
    formal: { status: "active", sessionId: "s0" },
  };
  for (const [shape, entry] of Object.entries(entries)) {
    const world = makeWorld({ windows: ["agent-x"] });
    world.deps.alive = (pid) => shape === "live" && pid === MARKER.pid;
    world.st.reg.agents["agent-x"] = entry as never;
    const before = structuredClone(world.st);
    expect(await runKill("agent-x", world.deps, { expectCreate })).toMatchObject({ ok: false, refused: "identity", untouched: true });
    expect(world.st).toEqual(before);
  }
});
