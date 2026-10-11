/**
 * LIFECAS1 round 2: the final re-check reads activity through the production lifecycleSnapshot (real readActivity, real session-file
 * stat). A source that exists but cannot be read must refuse the remove, never fall back to an older idle reading. The registry and
 * the ACP record live in the test process's temporary state dir (tests/preload.ts); the session path is pointed at a temp file; the
 * mutations go to the in-memory world (tests/resumable-world.ts). Nothing touches tmux, Discord, the bridge or the real state dir.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "../src/lib/agent-lifecycle-config.js";
import { registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { activityPath } from "../src/lib/agent-supervisor-activity.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { REGISTRY_PATH } from "../src/lib/registry.js";
import type { LifecycleRemoveFacts } from "../src/manager/agent-remove-guard.js";
import type { AgentInfo } from "../src/manager/core.js";
import { makeWorld } from "./resumable-world.js";

const H = 3_600_000, NAME = "agent-lifecas1-act", CWD = "/nowhere/lifecas1-act";
const ON: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };

// mock.module is process-wide: only this file's cwd is redirected, every other caller gets the real path
let sessionFile = "";
const realSource = await import("../src/lib/session-source.js");
mock.module("../src/lib/session-source.js", () => ({
  ...realSource,
  sessionJsonlPath: (runtime: string | undefined, cwd: string, sessionId: string) =>
    cwd === CWD ? sessionFile : realSource.sessionJsonlPath(runtime, cwd, sessionId),
}));
const { lifecycleSnapshot } = await import("../src/lib/agent-lifecycle-deps.js");
const { runRemove } = await import("../src/manager/agent-kill.js");

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const entry = (): AgentInfo =>
  ({ project: "p", purpose: "w", created: "c", status: "active", channelId: "ch-s1", notes: "", sessionId: "s1", cwd: CWD });

/** A verified card's author, idle 2h by its session file; registry on disk and in the world agree. */
function scene() {
  const dir = mkdtempSync(join(tmpdir(), "lifecas1-act-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]')").run();
  createTask(db, { actor: "owner", now: 1000 }, { project: "p", id: "T1", title: "T1", kind: "code" });
  db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'T1'").run();
  registerWorker(db, { agent: NAME, sessionId: "s1", taskId: "T1", role: "author", createdBy: "agent-pm", now: 1 });

  const prevReg = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : null;
  mkdirSync(join(REGISTRY_PATH, ".."), { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify({ socket: "s", agents: { [NAME]: entry() } }));
  const act = activityPath(NAME);
  cleanup.push(() => {
    if (prevReg === null) rmSync(REGISTRY_PATH, { force: true }); else writeFileSync(REGISTRY_PATH, prevReg);
    rmSync(act, { recursive: true, force: true });
  });

  sessionFile = join(dir, "s1.jsonl");
  writeFileSync(sessionFile, "{}\n");
  const activeAt = Math.floor((Date.now() - 2 * H) / 1000) * 1000;
  utimesSync(sessionFile, activeAt / 1000, activeAt / 1000);

  const w = makeWorld({ reg: { socket: "s", agents: { [NAME]: entry() } }, windows: [NAME], channels: new Set(["ch-s1"]) });
  const facts: LifecycleRemoveFacts = {
    lock: () => () => {},
    // realLifecycleRemoveFacts.replan, over this test's ledger instead of the bridge's read-only one
    replan: async (policy) => { const now = Date.now(); return { now, plan: await lifecycleSnapshot(db, policy, now, { strict: true }) }; },
    commit: async (mutate) => {
      const reg = await w.deps.loadRegistry();
      const why = mutate(reg);
      if (!why) await w.deps.saveRegistry(reg);
      return why;
    },
    dropSettings: () => {},
  };
  const remove = () => runRemove(NAME, w.deps, { lifecycle: {
    guard: JSON.stringify({ sessionId: "s1", taskId: "T1", role: "author", rule: "card_finished", activeAt, policy: ON }), facts } });
  const destroyed = () => w.trace.filter((t) => /^(killWindow|archive|deleteChannel|save|rescan|agentCleanup)/.test(t));
  return { db, w, act, activeAt, remove, destroyed };
}

async function plannedNow(s: ReturnType<typeof scene>) {
  const plan = await lifecycleSnapshot(s.db, ON, Date.now());
  expect(plan.actions.filter((a) => a.agent === NAME).map((a) => [a.rule, a.sessionId])).toEqual([["card_finished", "s1"]]);
}

const refusedUntouched = (s: ReturnType<typeof scene>, r: Record<string, unknown>, text: string) => {
  expect(r).toMatchObject({ ok: false, refused: true });
  expect(String(r.error)).toContain(text);
  expect(s.destroyed()).toEqual([]);
  expect(s.w.st.reg.agents[NAME]).toEqual(entry());
  expect(s.w.st.windows).toEqual([NAME]);
  expect(s.w.st.channels.has("ch-s1")).toBe(true);
};

describe("[验收线 2] 最终重核的活动读取失败：拒，不退回会话文件的旧空闲读数", () => {
  test("malformed ACP activity record written after the plan → refuses, zero kill / archive / remove", async () => {
    const s = scene();
    await plannedNow(s);
    mkdirSync(join(s.act, ".."), { recursive: true });
    writeFileSync(s.act, "{ not json");
    refusedUntouched(s, await s.remove(), "ACP 活动记录读不了");
  });

  test("ACP record that parses but has the wrong shape (e.g. a half-written busy turn) → refuses", async () => {
    const s = scene();
    mkdirSync(join(s.act, ".."), { recursive: true });
    writeFileSync(s.act, JSON.stringify({ v: 1, agent: NAME, sessionId: "s1", busy: true }));
    refusedUntouched(s, await s.remove(), "ACP 活动记录读不了");
  });

  test("ACP record path unreadable (a directory) → refuses", async () => {
    const s = scene();
    mkdirSync(s.act, { recursive: true });
    refusedUntouched(s, await s.remove(), "ACP 活动记录读不了");
  });

  test("session file stat fails with something other than ENOENT → refuses", async () => {
    const s = scene();
    sessionFile = join(sessionFile, "under-a-file.jsonl"); // ENOTDIR
    refusedUntouched(s, await s.remove(), "会话文件读不了");
  });

  test("the planner and doctor stay lenient: a malformed record still reads as absent there", async () => {
    const s = scene();
    mkdirSync(join(s.act, ".."), { recursive: true });
    writeFileSync(s.act, "{ not json");
    await plannedNow(s);
  });

  test("a valid busy ACP record for the session (new turn) → refuses", async () => {
    const s = scene();
    mkdirSync(join(s.act, ".."), { recursive: true });
    const t = Date.now();
    writeFileSync(s.act, JSON.stringify({ v: 1, agent: NAME, sessionId: "s1", hostPid: 1, busy: true, turnAt: t, updateAt: t, writtenAt: t }));
    refusedUntouched(s, await s.remove(), "生命周期收回拒绝");
  });

  test("control: no ACP record, stable idle session file → removed once", async () => {
    const s = scene();
    const r = await s.remove();
    expect(r).toMatchObject({ ok: true, lifecycle: true });
    expect(s.w.st.reg.agents[NAME]).toBeUndefined();
    expect(s.w.st.windows).toEqual([]);
    expect(s.w.st.channels.has("ch-s1")).toBe(false);
  });

  test("control: a valid idle ACP record of another session is ignored, session file decides → removed", async () => {
    const s = scene();
    mkdirSync(join(s.act, ".."), { recursive: true });
    writeFileSync(s.act, JSON.stringify({ v: 1, agent: NAME, sessionId: "s0", hostPid: 1, busy: false, turnAt: 1, updateAt: 1, writtenAt: 1 }));
    expect(await s.remove()).toMatchObject({ ok: true, lifecycle: true });
  });
});
