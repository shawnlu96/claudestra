/** SWAPFIX1 2: a half-built family-swap author session is cleared through manager kill and re-planned; anything uncertain stays unknown. */
import { expect, test } from "bun:test";
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

/** A local four-round card: create leaves only a placeholder (no session id), kill removes it, like a create killed at 90 s. */
async function halfBuilt(mode: "on" | "observe" | "off" = "on") {
  const f = await fourRoundFix(), p = convergenceProbe(f);
  let window: Window = "shell", current = "";
  setSelfHealPolicy(f.db, () => ({ mode, manualAfterMs: null, source: "config" }));
  setHalfBuiltIo(f.db, io(() => current, () => window));
  p.deps.manager = async (cmd, name, dir) => {
    p.effects.push(`${cmd}:${name}`);
    p.edit((r) => {
      if (cmd === "create") r.agents[name] = { cwd: dir, status: "active" };
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
        if (broken === "session") h.p.edit((r) => { r.agents[name].sessionId = "late-session"; });
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
