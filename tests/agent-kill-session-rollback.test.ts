/**
 * `kill <name> --session <id>` refused after it marked the entry stopped: with no window closed yet and the entry still as this
 * stop wrote it, the mark and its kill pending are taken back; an entry someone else rewrote, or a stop that already closed a
 * window, is left as it is. The real runKill over the in-memory world, a synthetic ledger and temp dirs; no registry, no tmux.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readStopRegistry } from "../src/lib/fix-strategy-guard-stop.js";
import { sessionStop } from "../src/lib/fix-strategy-guard.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { killOutcome } from "../src/lib/scheduler-retire.js";
import { runKill, type RestartLock } from "../src/manager/agent-kill.js";
import type { Registry } from "../src/manager/core.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { makeWorld, normalize, type WorldState } from "./resumable-world.js";

const W = "agent-w", V = "agent-v";
const agent = (over: Record<string, unknown> = {}) => ({ sessionId: "s-1", status: "active", channelId: "ch1", cwd: "/w", model: "m", parent: V, ...over });
const other = () => ({ sessionId: "s-v", status: "active", channelId: "ch2", cwd: "/v" });
const world = (agents: Record<string, unknown> = { [W]: agent(), [V]: other() }, init: Partial<WorldState> = {}) =>
  makeWorld({ reg: { socket: "s", agents } as unknown as Registry, windows: [W], channels: new Set(["ch1", "ch2"]), ...init });
type World = ReturnType<typeof world>;
const lock: RestartLock = { tryLock: () => true, unlock: () => {} };
const guarded = (w: World) => runKill(W, w.deps, { session: "s-1", restartLock: lock, sessionRegistry: () => w.st.reg });
/** Runs `fn` once, after the n-th call of the named port has done its work and before its caller gets the answer. */
function inside(w: World, port: "saveRegistry" | "killWindowId" | "archive" | "deleteChannel", n: number, fn: () => void) {
  const real = w.deps[port] as (...a: unknown[]) => Promise<unknown>;
  let calls = 0;
  (w.deps as unknown as Record<string, unknown>)[port] = async (...a: unknown[]) => { const out = await real(...a); if (++calls === n) fn(); return out; };
}
const did = (w: World, label: string) => w.trace.filter((t) => t.startsWith(`${label}#`)).length;
const entry = (w: World) => w.st.reg.agents[W] as unknown as Record<string, unknown>;
/** Neither "already stopped" (a receipt) nor "busy, kill again". */
const plainFailure = (out: Record<string, unknown>) => {
  expect(Object.keys(killOutcome(out))).toEqual(["failed"]);
  expect(String(out.error)).not.toMatch(/不存在|正在/);
};

// ── the swap's own stop, with the real runKill as its manager child and the real ledger gate behind --fix-stop ──
type Fixture = Awaited<ReturnType<typeof repeatedFix>>;
const OLD = "agent-task-one";

function swap(f: Fixture) {
  const p = convergenceProbe(f), intent = p.plan(), w = makeWorld({ windows: [OLD], channels: new Set(["ch-one"]) });
  const outs: Record<string, unknown>[] = [], manager = p.deps.manager;
  w.deps.loadRegistry = async () => p.raw();
  w.deps.saveRegistry = async (r) => { writeFileSync(f.registryPath, JSON.stringify(r)); w.trace.push("save"); };
  p.deps.agents = async () => (await p.deps.registry()).map((r) => ({ ...r, pending: !!p.raw().agents[r.name].pending, window: w.st.windows.includes(r.name) }));
  p.deps.manager = async (cmd, name, ...rest) => {
    if (cmd !== "kill") return manager(cmd, name, ...rest);
    const out = await runKill(name, w.deps, { session: rest[rest.indexOf("--session") + 1], fixStop: rest[rest.indexOf("--fix-stop") + 1],
      sessionRegistry: () => readStopRegistry<Registry>(f.registryPath), restartLock: lock });
    outs.push(out);
    return out;
  };
  p.deps.stop = sessionStop(p.deps.manager);
  /** Fires once inside the kill child's n-th window query: n = 2 is the first one after the entry was marked stopped. */
  const atWindowQuery = (n: number, fn: () => Promise<unknown> | unknown) => {
    const real = w.deps.windowIds;
    let queries = 0;
    w.deps.windowIds = async (name) => { const ids = await real(name); if (++queries === n) await fn(); return ids; };
  };
  return { p, w, outs, atWindowQuery, run: () => fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps) };
}
const toManual = async (f: Fixture) => expect((await f.cli("owner", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev",
  String(getWorkflow(f.db, "T1")!.rev), "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude",
  "--fallback", "人工修复", "--reason", "PM 接管，人工修复")).ok).toBe(true);
const rebind = (f: Fixture) =>
  f.db.run("UPDATE scheduler_sessions SET agent = 'manual-author', sessionId = 'manual-session' WHERE taskId = 'T1' AND role = 'author'");

for (const [drift, inject] of [["a manual takeover on the same ledger", toManual], ["a changed author binding", rebind]] as const) {
  test(`[验收线 1] ${drift} after the entry was marked stopped and before the first window is closed takes the mark back`, async () => {
    const f = await repeatedFix();
    try {
      const s = swap(f);
      await s.run(); // archive pass
      const before = JSON.stringify(s.p.raw());
      s.atWindowQuery(2, () => inject(f));
      await s.run().catch(() => {}); // the pass after the drift waits or is refused at admission; either way the child already answered
      expect(s.outs).toHaveLength(1);
      expect(s.outs[0]).toMatchObject({ ok: false, refused: "identity", untouched: false, rolledBack: true });
      plainFailure(s.outs[0]);
      expect(s.w.trace).toEqual(["save", "save"]); // the stopped mark, then its rollback: no window closed, nothing archived or deleted
      expect(s.w.st.windows).toEqual([OLD]);
      const now = s.p.raw().agents[OLD];
      expect(now.status).not.toBe("stopped");
      expect(now.pending).toBeUndefined();
      expect(JSON.stringify(s.p.raw())).toBe(before); // every field of every entry, byte for byte as before the stop
    } finally { f.close(); }
  });
}

test("[验收线 1] the rollback restores the status the entry had, drops only this stop's pending and leaves every other field and entry alone", async () => {
  for (const status of ["active", "creating", undefined]) {
    const mine = agent({ status });
    if (status === undefined) delete (mine as Record<string, unknown>).status;
    const w = world({ [W]: mine, [V]: other() }), before = JSON.stringify(w.st.reg);
    let marked: Record<string, unknown> | undefined;
    inside(w, "saveRegistry", 1, () => { marked = structuredClone(entry(w)); w.openWindow(W); }); // the window set moved: refused before any close
    const out = await guarded(w);
    expect(marked).toMatchObject({ status: "stopped", pending: { op: "kill" } }); // 先红: this is what a refusal used to leave behind
    expect(out).toMatchObject({ ok: false, refused: "identity", untouched: false, rolledBack: true, error: expect.stringContaining("已恢复") });
    plainFailure(out);
    expect(JSON.stringify(w.st.reg)).toBe(before);
    expect([did(w, "save"), did(w, "killWindow"), did(w, "archive"), did(w, "deleteChannel")]).toEqual([2, 0, 0, 0]);
    expect(w.st.windows).toEqual([W, W]);
  }
});

test("[验收线 2] an entry someone else rewrote inside that await is theirs: no rollback, no further registry write, a restart hint", async () => {
  const foreign = { op: "kill", pid: 4242, startedAt: "2026-09-28T11:59:00.000Z" };
  const rewrites: [string, (w: World) => void][] = [
    ["another session", (w) => { w.st.reg.agents[W] = agent({ sessionId: "s-2" }) as never; }],
    ["another kill pending", (w) => { entry(w).pending = foreign; }],
    ["a rename pending", (w) => { entry(w).pending = { op: "rename", pid: 4242, startedAt: foreign.startedAt, from: "agent-u" }; }],
    ["this stop's pending turned into a debt", (w) => { entry(w).pending = { ...(entry(w).pending as object), pid: 0, left: ["channel"] }; }],
    ["a restart that revived the entry", (w) => { Object.assign(entry(w), { status: "active" }); delete entry(w).pending; w.openWindow(W); }],
  ];
  for (const [what, rewrite] of rewrites) {
    const w = world();
    let theirs = "";
    inside(w, "saveRegistry", 1, () => { rewrite(w); theirs = JSON.stringify(w.st.reg); });
    const out = await guarded(w);
    expect(out, what).toMatchObject({ ok: false, refused: "identity", untouched: false, rolledBack: false });
    expect(String(out.error), what).toContain(`registry 可能留着已停止和 kill 待办，接管方 restart ${W} 可清`);
    expect(String(out.error)).not.toContain("个窗口");
    plainFailure(out);
    expect(did(w, "save"), what).toBe(1); // only the mark itself
    expect(JSON.stringify(w.st.reg), what).toBe(theirs);
    expect([did(w, "killWindow"), did(w, "archive"), did(w, "deleteChannel")]).toEqual([0, 0, 0]);
  }
});

test("[验收线 3] refused after the first of two windows was closed: stopped and this stop's pending stay, and a later kill resumes from there", async () => {
  const w = world(undefined, { windows: [W, W] });
  let marked: unknown;
  inside(w, "saveRegistry", 1, () => { marked = structuredClone(entry(w).pending); });
  inside(w, "killWindowId", 1, () => { w.openWindow(W); }); // one closed; the set then moves under the stop
  const out = await guarded(w);
  expect(out).toMatchObject({ ok: false, refused: "identity", untouched: false, rolledBack: false });
  expect(String(out.error)).toContain("已关 1 个窗口");
  expect(String(out.error)).toContain(`restart ${W} 可清`);
  plainFailure(out);
  expect([did(w, "save"), did(w, "killWindow"), did(w, "archive"), did(w, "deleteChannel")]).toEqual([1, 1, 0, 0]);
  expect(entry(w)).toEqual(agent({ status: "stopped", pending: marked }));
  expect(w.st.windows).toEqual([W, W]);
  // the stale mark is never undone by a second guarded attempt: the entry check refuses it untouched (CVGATE1, unchanged)
  w.restart();
  const again = await guarded(w);
  expect(again).toMatchObject({ ok: false, refused: "identity", untouched: true, rolledBack: false });
  expect(w.trace).toEqual([]);
  // the resumable path is the same kill by name (or repair --apply): it walks the remaining steps
  expect(await runKill(W, w.deps)).toEqual({ ok: true, agent: W, message: `${W} 已销毁。` });
  expect(normalize(w.st)).toEqual({ agents: { [W]: agent({ status: "stopped" }), [V]: other() }, windows: [], channels: ["ch2"] });
});

test("[验收线 3] a windowless entry refused after its channel was deleted is not rolled back to a running entry without a channel", async () => {
  const w = world(undefined, { windows: [] });
  inside(w, "deleteChannel", 1, () => { w.st.reg.agents["Agent-W"] = other() as never; });
  const out = await guarded(w);
  expect(out).toMatchObject({ ok: false, refused: "identity", untouched: false, rolledBack: false, error: expect.stringContaining(`restart ${W} 可清`) });
  expect(entry(w)).toMatchObject({ status: "stopped", pending: { op: "kill" } });
  expect(did(w, "save")).toBe(1);
  // refused ahead of the channel instead: nothing irreversible was done, so the mark is taken back
  const early = world(undefined, { windows: [] });
  inside(early, "archive", 1, () => { early.st.reg.agents["Agent-W"] = other() as never; });
  expect(await guarded(early)).toMatchObject({ ok: false, refused: "identity", rolledBack: true });
  expect(early.st.reg.agents).toEqual({ [W]: agent(), [V]: other(), "Agent-W": other() } as never);
  expect([did(early, "save"), did(early, "deleteChannel")]).toEqual([2, 0]);
});

test("[验收线 4] refusals with and without a rollback never read as stopped or busy, and every refusal carries rolledBack", async () => {
  const back = world();
  inside(back, "saveRegistry", 1, () => { back.openWindow(W); });
  const rolled = await guarded(back);
  expect(rolled.rolledBack).toBe(true);
  expect(Object.keys(killOutcome(rolled))).toEqual(["failed"]);
  const kept = world();
  inside(kept, "saveRegistry", 1, () => { kept.st.reg.agents[W] = agent({ sessionId: "s-2" }) as never; });
  const stayed = await guarded(kept);
  expect(stayed.rolledBack).toBe(false);
  expect(Object.keys(killOutcome(stayed))).toEqual(["failed"]);
  // refused before anything was written: nothing to roll back
  expect(await guarded(world({ [W]: agent({ sessionId: "s-2" }) }))).toMatchObject({ ok: false, untouched: true, rolledBack: false });
  expect(await runKill(W, world().deps, { session: "s-1", restartLock: { tryLock: () => false, unlock: () => {} } }))
    .toMatchObject({ ok: false, refused: "restart-lock", untouched: true, rolledBack: false });
});

test("[验收线 4] a kill without --session answers, writes and orders its steps exactly as before", async () => {
  const w = world();
  w.deps.windowIds = async () => { throw new Error("legacy kill read window ids"); };
  expect(await runKill(W, w.deps)).toEqual({ ok: true, agent: W, message: `${W} 已销毁。` });
  expect(w.trace).toEqual(["save#1", "killWindow#1", "archive#1", "deleteChannel#1", "agentCleanup#1", "save#2", "rescan#1"]);
  expect(normalize(w.st)).toEqual({ agents: { [W]: agent({ status: "stopped" }), [V]: other() }, windows: [], channels: ["ch2"] });
  const down = world(undefined, { bridgeUp: false });
  const out = await runKill(W, down.deps);
  expect(out).toMatchObject({ ok: true, agent: W, incomplete: ["channel"] });
  expect("rolledBack" in out).toBe(false);
  expect(entry(down)).toMatchObject({ status: "stopped", pending: { op: "kill", pid: 0, left: ["channel"] } });
  expect(await runKill(W, world({}, { windows: [] }).deps)).toEqual({ ok: false, error: `${W} 不存在` });
});

test("[验收线 4] an unmoved guarded stop still stops the session once and reports no rollback", async () => {
  const w = world();
  expect(await guarded(w)).toEqual({ ok: true, agent: W, message: `${W} 已销毁。` });
  expect(w.trace).toEqual(["save#1", "killWindow#1", "archive#1", "deleteChannel#1", "agentCleanup#1", "save#2", "rescan#1"]);
  expect(normalize(w.st)).toEqual({ agents: { [W]: agent({ status: "stopped" }), [V]: other() }, windows: [], channels: ["ch2"] });
});
