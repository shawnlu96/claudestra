/**
 * The fix swap's final stop is `kill <name> --session <id>`: the real runKill, over fake tmux / bridge ports, refuses inside its
 * own run once the name no longer runs the pinned session, and stops exactly that session when nothing moved. A kill without
 * the session argument behaves as before. Synthetic ledger, temp dirs and fake ports only; no manager child is spawned.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readStopRegistry } from "../src/lib/fix-strategy-guard-stop.js";
import { sessionStop } from "../src/lib/fix-strategy-guard.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup } from "../src/lib/ledger-store.js";
import { killOutcome } from "../src/lib/scheduler-retire.js";
import { runKill, type RestartLock } from "../src/manager/agent-kill.js";
import type { Registry } from "../src/manager/core.js";
import { tryLockRestart, unlockRestart } from "../src/manager/restart-lock.js";
import { convergenceProbe, repeatedFix } from "./fix-strategy-helpers.js";
import { makeWorld, normalize, type WorldState } from "./resumable-world.js";

const W = "agent-w";
const agent = (over: Record<string, unknown> = {}) => ({ sessionId: "s-1", status: "active", channelId: "ch1", cwd: "/w", ...over });
const world = (agents: Record<string, unknown> = { [W]: agent() }, init: Partial<WorldState> = {}) =>
  makeWorld({ reg: { socket: "s", agents } as unknown as Registry, windows: [W], channels: new Set(["ch1"]), ...init });
type World = ReturnType<typeof world>;
/** A lock nobody else holds; `held` records every take and release. */
const freeLock = (held: string[] = []): RestartLock => ({ tryLock: (n) => { held.push(`lock:${n}`); return true; }, unlock: (n) => { held.push(`unlock:${n}`); } });
const guarded = (w: World, sessionId = "s-1", restartLock = freeLock()) => runKill(W, w.deps, { session: sessionId, restartLock, sessionRegistry: () => w.st.reg });
/** Runs `fn` once, after the n-th call of the named port has done its work and before its caller gets the answer. */
function inside(w: World, port: "windowIds" | "saveRegistry" | "killWindowId" | "archive", n: number, fn: () => void) {
  const real = w.deps[port] as (...a: unknown[]) => Promise<unknown>;
  let calls = 0;
  (w.deps as unknown as Record<string, unknown>)[port] = async (...a: unknown[]) => { const out = await real(...a); if (++calls === n) fn(); return out; };
}
const fresh = (w: World) => { w.st.reg.agents[W] = agent({ sessionId: "s-2" }) as never; };
const did = (w: World, label: string) => w.trace.filter((t) => t.startsWith(`${label}#`)).length;
const untouched = (w: World) => expect([did(w, "save"), did(w, "killWindow"), did(w, "archive"), did(w, "deleteChannel")]).toEqual([0, 0, 0, 0]);

test("[验收线 2] runKill --session: the session it names, unmoved, is stopped once and the restart lock is released", async () => {
  const w = world(), held: string[] = [];
  expect(await guarded(w, "s-1", freeLock(held))).toEqual({ ok: true, agent: W, message: `${W} 已销毁。` });
  expect(normalize(w.st)).toEqual({ agents: { [W]: agent({ status: "stopped" }) }, windows: [], channels: [] });
  expect([did(w, "killWindow"), did(w, "archive"), did(w, "deleteChannel")]).toEqual([1, 1, 1]);
  expect(held).toEqual([`lock:${W}`, `unlock:${W}`]);
  expect(await guarded(w)).toMatchObject({ ok: true, alreadyStopped: true });
});

test("[验收线 2] runKill --session: another session under the name inside the kill's own await is not marked stopped and keeps its window", async () => {
  const w = world(), held: string[] = [];
  inside(w, "windowIds", 1, () => fresh(w)); // after the entry check passed, before the entry would be marked stopped
  const out = await guarded(w, "s-1", freeLock(held));
  expect(out).toMatchObject({ ok: false, refused: "identity", untouched: true });
  untouched(w);
  expect(normalize(w.st)).toEqual({ agents: { [W]: agent({ sessionId: "s-2" }) }, windows: [W], channels: ["ch1"] });
  expect(held).toEqual([`lock:${W}`, `unlock:${W}`]);
  // neither "already stopped" (a receipt) nor "busy, kill again": the scheduler must not read the refusal as either
  expect(Object.keys(killOutcome(out))).toEqual(["failed"]);
});

test("[验收线 2] runKill --session: a session that takes the name after the entry was marked stopped keeps its window, archive, channel and entry", async () => {
  for (const [port, n] of [["saveRegistry", 1], ["killWindowId", 1], ["archive", 1]] as const) {
    const w = world();
    inside(w, port, n, () => { fresh(w); if (!w.st.windows.includes(W)) w.openWindow(W); });
    const out = await guarded(w);
    expect(out).toMatchObject({ ok: false, refused: "identity", untouched: false });
    expect(Object.keys(killOutcome(out))).toEqual(["failed"]);
    expect(normalize(w.st)).toEqual({ agents: { [W]: agent({ sessionId: "s-2" }) }, windows: [W], channels: ["ch1"] }); // the new session, as it was written
    expect([did(w, "save"), did(w, "deleteChannel")]).toEqual([1, 0]);
    if (port === "saveRegistry") expect([did(w, "killWindow"), did(w, "archive")]).toEqual([0, 0]);
  }
});

test("[验收线 2] runKill --session: a window set that changed since entry is not closed", async () => {
  const w = world();
  inside(w, "saveRegistry", 1, () => { w.openWindow(W); });
  expect(await guarded(w)).toMatchObject({ ok: false, refused: "identity", untouched: false, error: expect.stringContaining("窗口集合已变化") });
  expect([did(w, "killWindow"), did(w, "archive"), did(w, "deleteChannel")]).toEqual([0, 0, 0]);
  expect(w.st.windows).toEqual([W, W]);
});

test("[验收线 2] runKill --session: a missing entry, another session, an unfinished pending or a case variant is refused untouched", async () => {
  const pending = { op: "rename", pid: 1, startedAt: "2026-09-28T11:00:00.000Z", from: "agent-v" };
  const cases: [string, Record<string, unknown>][] = [
    ["没有这个条目", {}], ["另一个会话", { [W]: agent({ sessionId: "s-2" }) }], ["未完成的 rename", { [W]: agent({ pending }) }],
    ["未完成的 kill", { [W]: agent({ status: "stopped", pending: { op: "kill", pid: 0, startedAt: pending.startedAt, left: ["channel"] } }) }],
    ["大小写变体", { [W]: agent(), "Agent-W": agent({ sessionId: "s-9" }) }],
  ];
  for (const [why, agents] of cases) {
    const w = world(agents), before = normalize(w.st);
    const out = await guarded(w);
    expect(out).toMatchObject({ ok: false, refused: "identity", untouched: true, error: expect.stringContaining(why) });
    expect(String(out.error)).not.toMatch(/不存在|正在/);
    untouched(w);
    expect(normalize(w.st)).toEqual(before);
  }
});

test("[验收线 2] runKill --session: a held restart lock refuses before anything is read or written; without --session it is never taken", async () => {
  const w = world();
  expect(tryLockRestart(W)).toBe(true); // the real file lock, in the test state dir: a restart of this agent is in flight
  try {
    const out = await runKill(W, w.deps, { session: "s-1", sessionRegistry: () => w.st.reg });
    expect(out).toMatchObject({ ok: false, refused: "restart-lock", untouched: true });
    expect(Object.keys(killOutcome(out))).toEqual(["failed"]);
    expect(w.trace).toEqual([]);
    expect(normalize(w.st)).toEqual({ agents: { [W]: agent() }, windows: [W], channels: ["ch1"] });
  } finally { unlockRestart(W); }
  expect(await runKill(W, w.deps, { session: "s-1", sessionRegistry: () => w.st.reg })).toMatchObject({ ok: true });
  expect(tryLockRestart(W)).toBe(true); // released by the kill itself
  unlockRestart(W);
});

test("[验收线 2] runKill without --session answers and leaves the world exactly as before this card", async () => {
  const never: RestartLock = { tryLock: () => { throw new Error("legacy kill took the restart lock"); }, unlock: () => { throw new Error("legacy unlock"); } };
  const legacy = async (w: World, name = W) => {
    w.deps.windowIds = async () => { throw new Error("legacy kill read window ids"); };
    return { out: await runKill(name, w.deps, { restartLock: never }), end: normalize(w.st), trace: w.trace };
  };
  expect(await legacy(world())).toEqual({ out: { ok: true, agent: W, message: `${W} 已销毁。` },
    end: { agents: { [W]: agent({ status: "stopped" }) }, windows: [], channels: [] },
    trace: ["save#1", "killWindow#1", "archive#1", "deleteChannel#1", "agentCleanup#1", "save#2", "rescan#1"] });
  // by name only: whatever session now runs there is stopped, and case variants are dropped — the behaviour the swap no longer uses
  expect(await legacy(world({ [W]: agent({ sessionId: "s-2" }), "Agent-W": agent() }))).toMatchObject({ out: { ok: true },
    end: { agents: { [W]: agent({ sessionId: "s-2", status: "stopped" }) }, windows: [] } });
  expect(await legacy(world({ [W]: agent({ status: "stopped" }) }, { windows: [] }))).toMatchObject({
    out: { ok: true, agent: W, alreadyStopped: true, message: `${W} 早已销毁，无事可做。` }, trace: [] });
  expect(await legacy(world({}, { windows: [] }))).toMatchObject({ out: { ok: false, error: `${W} 不存在` }, trace: [] });
  expect(await legacy(world(undefined, { restarting: [W] }))).toMatchObject({ out: { ok: false, error: `${W} 正在 restart（窗口在重建），等它结束再 kill` }, trace: [] });
  const down = await legacy(world(undefined, { bridgeUp: false }));
  expect(down.out).toMatchObject({ ok: true, agent: W, incomplete: ["channel"] });
  expect(down.end.agents[W]).toMatchObject({ status: "stopped", pending: { op: "kill", pid: 0, left: ["channel"] } });
});

// ── the swap itself, with the real runKill as its manager child ──
type Fixture = Awaited<ReturnType<typeof repeatedFix>>;
const OLD = "agent-task-one";

/** The fixture's registry file is the manager child's registry; tmux and the bridge are the fake world's. */
function swap(f: Fixture) {
  const p = convergenceProbe(f), intent = p.plan(), w = makeWorld({ windows: [OLD], channels: new Set(["ch-one"]) });
  const kills: string[][] = [], manager = p.deps.manager;
  let locked = false;
  w.deps.loadRegistry = async () => p.raw();
  w.deps.saveRegistry = async (r) => { writeFileSync(f.registryPath, JSON.stringify(r)); w.trace.push("save"); };
  p.deps.agents = async () => (await p.deps.registry()).map((r) => ({ ...r, pending: !!p.raw().agents[r.name].pending, window: w.st.windows.includes(r.name) }));
  p.deps.manager = async (cmd, name, ...rest) => {
    if (cmd !== "kill") return manager(cmd, name, ...rest);
    kills.push([name, ...rest]);
    const out = await runKill(name, w.deps, { session: rest[rest.indexOf("--session") + 1],
      fixStop: rest.includes("--fix-stop") ? rest[rest.indexOf("--fix-stop") + 1] : undefined,
      sessionRegistry: () => readStopRegistry<Registry>(f.registryPath), restartLock: { tryLock: () => !locked, unlock: () => {} } });
    if (out.ok === true) p.effects.push(`kill:${name}`);
    return out;
  };
  p.deps.stop = sessionStop(p.deps.manager);
  const effects = () => p.effects.filter((e) => /^(archive|kill|create):/.test(e));
  const receipts = () => ["author", "archive", "kill", "creating", "replacement"].filter((e) => getEventByDedup(f.db, `scheduler:${intent.id}:${e}`));
  const authors = () => f.db.query("SELECT agent, sessionId, state FROM scheduler_sessions WHERE taskId = 'T1' AND role = 'author' ORDER BY rowid").all();
  return { p, w, intent, kills, effects, receipts, authors, lock: (on: boolean) => { locked = on; }, run: () => fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps) };
}

test("[验收线 2] with no drift the swap archives, stops through the session-guarded runKill and creates exactly once each", async () => {
  const f = await repeatedFix();
  try {
    const s = swap(f), created = `agent-cv-t1-fix-${s.intent.eventSeq}`;
    expect(await s.run()).toMatchObject({ step: "waiting", detail: "旧作者已归档，下轮确认停止" });
    expect(await s.run()).toMatchObject({ ok: true, step: "session" });
    expect(await s.run()).toMatchObject({ ok: true, step: "session" });
    expect(s.effects()).toEqual([`archive:${OLD}`, `kill:${OLD}`, `create:${created}`]);
    expect(s.kills).toEqual([[OLD, "--session", "s-one", "--fix-stop", expect.any(String)]]);
    expect(did(s.w, "killWindow")).toBe(1);
    expect(s.w.st.windows).toEqual([]);
    expect(s.p.raw().agents[OLD]).toMatchObject({ sessionId: "s-one", status: "stopped" });
    expect(s.receipts()).toEqual(["author", "archive", "kill", "creating", "replacement"]);
    expect(s.authors()).toEqual([{ agent: OLD, sessionId: "s-one", state: "retired" }, { agent: created, sessionId: `session:${created}`, state: "active" }]);
    expect(getIntent(f.db, s.intent.id)?.status).toBe("done");
  } finally { f.close(); }
});

test("[验收线 2] a session started under the old name inside the kill child is refused by runKill: never stopped, window kept, kill not retried", async () => {
  const f = await repeatedFix();
  try {
    const s = swap(f);
    await s.run();
    // the scheduler's own checks all passed; the registry moves while the child lists windows
    inside(s.w, "windowIds", 1, () => s.p.edit((r) => { r.agents[OLD].sessionId = "s-fresh"; }));
    expect(await s.run()).toMatchObject({ ok: true, step: "waiting" });
    for (let pass = 0; pass < 3; pass++) expect(await s.run()).toMatchObject({ ok: true, step: "waiting", halted: "session" });
    expect(s.kills).toEqual([[OLD, "--session", "s-one", "--fix-stop", expect.any(String)]]); // one refused attempt; later passes stop at the gate
    expect(s.w.trace).toEqual([]); // nothing saved, no window closed, nothing archived or deleted by the child
    expect(s.w.st.windows).toEqual([OLD]);
    expect(s.p.raw().agents[OLD]).toEqual({ runtime: "claude-code", sessionId: "s-fresh", cwd: f.dir, channelId: "ch-one" });
    expect(s.effects()).toEqual([`archive:${OLD}`]);
    expect(s.receipts()).toEqual(["author", "archive"]);
    expect(s.authors()).toEqual([{ agent: OLD, sessionId: "s-one", state: "active" }]);
    expect(getIntent(f.db, s.intent.id)?.status).toBe("submitted");
  } finally { f.close(); }
});

test("[验收线 2] a restart of the old author in flight holds the stop back untouched; the swap resumes once it is over", async () => {
  const f = await repeatedFix();
  try {
    const s = swap(f);
    await s.run();
    s.lock(true);
    for (let pass = 0; pass < 2; pass++) expect(await s.run()).toMatchObject({ ok: true, step: "waiting", detail: expect.stringContaining("restart 锁被占") });
    expect([s.w.trace, s.w.st.windows, s.effects(), s.receipts()]).toEqual([[], [OLD], [`archive:${OLD}`], ["author", "archive"]]);
    s.lock(false);
    expect(await s.run()).toMatchObject({ ok: true, step: "session" });
    expect(s.effects().map((e) => e.split(":")[0])).toEqual(["archive", "kill", "create"]);
  } finally { f.close(); }
});


test("[验收线 2] late inventory session replacement keeps the same window intact", async () => {
  const w = world();
  inside(w, "windowIds", 2, () => fresh(w));
  expect(await guarded(w)).toMatchObject({ ok: false, refused: "identity" });
  expect(w.st.windows).toEqual([W]);
  expect([did(w, "killWindow"), did(w, "archive"), did(w, "deleteChannel")]).toEqual([0, 0, 0]);
});

for (const boundary of [1, 2]) test(`[验收线 1] formal manual takeover inside final manager inventory ${boundary} prevents stopping the author`, async () => {
  const f = await repeatedFix();
  try {
    const s = swap(f);
    await s.run();
    const real = s.w.deps.windowIds;
    let queries = 0;
    s.w.deps.windowIds = async (name) => {
      const ids = await real(name);
      if (++queries !== boundary) return ids;
      const result = await f.cli("owner", "workflow-set", "T1", "--rev", String(f.task().rev), "--workflow-rev",
        String(getWorkflow(f.db, "T1")!.rev), "--template", "code", "--version", "2", "--mode", "manual", "--author-family", "claude",
        "--fallback", "人工修复", "--reason", "PM 接管，人工修复");
      expect(result.ok).toBe(true);
      return ids;
    };
    expect(await s.run()).toMatchObject({ step: "waiting" });
    expect(s.w.st.windows).toEqual([OLD]);
    expect(s.w.trace).toEqual(boundary === 1 ? [] : ["save", "save"]); // boundary 2: the stopped mark, then its rollback (CVGATE2)
    expect(s.p.raw().agents[OLD].status).not.toBe("stopped");
    expect(s.p.raw().agents[OLD].pending).toBeUndefined();
    for (let pass = 0; pass < 2; pass++) await expect(s.run()).rejects.toMatchObject({ code: "conflict" });
    expect(s.effects()).toEqual([`archive:${OLD}`]);
    expect(s.authors()).toEqual([{ agent: OLD, sessionId: "s-one", state: "active" }]);
  } finally { f.close(); }
});


test("[验收线 2] final stop rechecks head, spec, ownership and shared binding after the last inventory await", async () => {
  for (const drift of ["head", "spec", "owner", "shared", "binding", "intent"] as const) {
    const f = await repeatedFix();
    try {
      const s = swap(f);
      await s.run();
      inside(s.w, "windowIds", 2, () => {
        if (drift === "head") f.db.run("UPDATE tasks SET headSHA = 'new-head' WHERE id = 'T1'");
        if (drift === "spec") f.db.run("UPDATE tasks SET specRev = specRev + 1 WHERE id = 'T1'");
        if (drift === "owner") f.db.run("UPDATE tasks SET agent = 'manual-author' WHERE id = 'T1'");
        if (drift === "shared") f.db.run(
          "INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt) VALUES ('T2', 'p', 'other', 'code', 'build', ?, 0, 0)", [OLD]);
        if (drift === "binding") f.db.run("UPDATE scheduler_sessions SET agent = 'manual-author', sessionId = 'manual-session' WHERE taskId = 'T1' AND role = 'author'");
        if (drift === "intent") f.db.run("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?", [s.intent.id]);
      });
      await s.run();
      expect(s.w.st.windows).toEqual([OLD]);
      expect([did(s.w, "killWindow"), did(s.w, "archive"), did(s.w, "deleteChannel")]).toEqual([0, 0, 0]);
      expect(s.effects()).toEqual([`archive:${OLD}`]);
      expect(s.authors()).toEqual([drift === "binding"
        ? { agent: "manual-author", sessionId: "manual-session", state: "active" }
        : { agent: OLD, sessionId: "s-one", state: "active" }]);
    } finally { f.close(); }
  }
});

test("[验收线 2] malformed or unreadable final stop ownership refuses untouched", async () => {
  for (const raw of ["", "{}", "{", '{"v":2}', JSON.stringify({ v: 1, path: "/missing/ledger", old: { agent: W, sessionId: "s-1" }, intent: { action: "fix_swap" }, pins: {} })]) {
    const w = world();
    expect(await runKill(W, w.deps, { session: "s-1", fixStop: raw, restartLock: freeLock(), sessionRegistry: () => w.st.reg })).toMatchObject({ ok: false, refused: "identity", untouched: true });
    untouched(w);
    expect(w.st.windows).toEqual([W]);
  }
});
