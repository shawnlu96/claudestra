/**
 * i28-RT1: retirement stops the card's own executor when PM started it by hand (named in tasks.agent, not in scheduler_sessions)
 * and it still works in the card's worktree. A real ledger in a temp dir and the ledger CLI in-process; fake agents / agent /
 * git / exists, so no agent is started and no real checkout is touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { schedulerRetireTick, worktreeDirs, type LiveAgent, type RetireDeps } from "../src/lib/scheduler-retire.js";
import { retireIntentId } from "../src/lib/scheduler-sessions.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const OWN = "agent-task-t1";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "i28rt1-retire-")), path = join(dir, "ledger.sqlite");
  let db = openLedger(path);
  const registryPath = join(dir, "registry.json"), root = "/wt";
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: {} }));
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  let now = 1000;
  const deps = (actor: string): LedgerDeps => ({
    db, actor, registryPath, projectIds: ["p"], now: () => (now += 10),
    loadRegistry: async () => ({ socket: "", agents: {} }) as unknown as Registry, saveRegistry: async () => {},
  });
  const [mine, rv] = worktreeDirs(root, "T1");
  const present = new Set([mine, rv]), dirty = new Map<string, string>();
  const live: LiveAgent[] = [];
  /** kill marks the agent stopped and closes its window, unless `stuck` (the window stays, as a tmux error would leave it). */
  let stuck = false, settleFails = 0, agentsThrow = 0, archive: Record<string, unknown> = { ok: true, archived: ["a.jsonl"] };
  let onArchive = (_agent: string): void => {};
  const calls: string[][] = [], gitCalls: string[][] = [], notices: string[] = [];
  const retireDeps: RetireDeps = {
    ledger: async (...args) => {
      if (args[1] === "scheduler-settle" && settleFails > 0) { settleFails--; return { ok: false, error: "injected settle failure" }; }
      return runLedger(args.slice(1), deps("scheduler"));
    },
    agent: async (...args) => {
      calls.push(args);
      if (args[0] === "archive") { onArchive(args[1]); return archive; }
      const a = live.find((x) => x.name === args[1]);
      if (a) { a.status = "stopped"; a.window = stuck; }
      return { ok: true, message: `${args[1]} 已销毁。` };
    },
    git: async (args) => {
      gitCalls.push(args);
      const d = args[1], cmd = args[2];
      if (cmd === "rev-parse") return { code: 0, out: `/repo/.git/worktrees/${d.split("/").pop()}\n/repo/.git` };
      if (cmd === "status") return { code: 0, out: dirty.get(d) ?? "" };
      if (cmd === "worktree") { present.delete(d); return { code: 0, out: "" }; }
      return { code: 1, out: `unexpected ${args.join(" ")}` };
    },
    exists: (p) => present.has(p), worktreeRoot: root, notifyPm: async (_t, text) => { notices.push(text); },
    agents: async () => {
      if (calls.some((c) => c[0] === "kill") && agentsThrow > 0) { agentsThrow--; throw new Error("injected registry read failure"); }
      return live.map((a) => ({ ...a }));
    },
  };
  /** A verified card whose executor PM started by hand: tasks.agent = OWN, only the reviewer is bound in scheduler_sessions. */
  const card = (id: string, stage: string, agent = OWN, rvAgent: string | null = `agent-rv-${id.toLowerCase()}`) => {
    createTask(db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code", agent });
    db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
    if (!rvAgent) return;
    const ens = `ens:${id}:reviewer`;
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
      VALUES (?, ?, 'p', 'restate', 'ensure_session', 0, 1, 1, 2, 'done', 'test', 0, 0)`).run(ens, id);
    db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
      VALUES (?, 'reviewer', ?, ?, 'codex', 'acp', 'active', ?, 0, 0)`).run(id, rvAgent, `s-${id}-rv`, ens);
  };
  const working = (name: string, cwd = mine) => live.push({ name, status: "active", sessionId: `s-${name}`, cwd, pending: false, window: true });
  const tick = async () => {
    const r = await schedulerRetireTick(db, ["p"], retireDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards;
  };
  const tickRaw = () => schedulerRetireTick(db, ["p"], retireDeps);
  const settleReceipt = () => String(listEvents(db, { project: "p", target: "T1" }).find((e) => e.data.op === "settle" && e.data.to === "done")?.data.receipt);
  const removed = () => gitCalls.filter((a) => a[2] === "worktree").map((a) => a[1]);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  const inject = { settleFails: (n: number) => { settleFails = n; }, agentsThrow: (n: number) => { agentsThrow = n; },
    archive: (r: Record<string, unknown>) => { archive = r; }, onArchive: (fn: (agent: string) => void) => { onArchive = fn; },
    /** A service restart: the ledger is closed and reopened, so nothing kept in memory on the old Database object survives. */
    restart: () => { closeLedger(path); db = openLedger(path); } };
  return { ...inject, get db() { return db; }, mine, rv, present, dirty, live, calls, notices, card, working, tick, tickRaw, settleReceipt, removed, stuck: (on: boolean) => { stuck = on; } };
}

const ownCalls = (calls: string[][]) => calls.filter((c) => c[1] === OWN);

describe("i28-RT1 retirement stops the card's own unregistered executor", () => {
  test("own executor in the worktree: archive, then kill, then `git worktree remove`; the event carries all three", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    const [out] = await f.tick();
    expect(out).toMatchObject({ taskId: "T1", step: "retired" });
    expect(ownCalls(f.calls)).toEqual([["archive", OWN], ["kill", OWN]]);
    expect(f.removed()).toEqual([f.mine, f.rv]);
    expect(f.present.size).toBe(0);
    expect(getIntent(f.db, retireIntentId("T1"))?.status).toBe("done");
    const receipt = f.settleReceipt();
    expect(receipt).toContain(`本卡执行者 ${OWN}`);
    expect(receipt).toContain("归档 已归档 1 个文件");
    expect(receipt).toContain(`停止 ${OWN} 已销毁`);
    expect(receipt).toContain("worktree 已清");
    expect(f.notices).toEqual([]);
  });

  test("an agent in the worktree that is not tasks.agent: not killed, the checkout stays, PM is told", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working("agent-pm-scratch");
    const [out] = await f.tick();
    expect(out.step).toBe("handoff");
    expect(f.calls.filter((c) => c[1] === "agent-pm-scratch")).toEqual([]);
    expect(f.present.has(f.mine)).toBe(true);
    expect(f.removed()).toEqual([f.rv]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("agent-pm-scratch 还在这里工作");
  });

  test("tasks.agent still used by another unfinished card: not killed, the checkout stays, PM is told", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.card("T2", "build", OWN, null);
    f.working(OWN);
    const [out] = await f.tick();
    expect(out.step).toBe("handoff");
    expect(ownCalls(f.calls)).toEqual([]);
    expect(f.present.has(f.mine)).toBe(true);
    expect(f.notices[0]).toContain(`${OWN} 还在这里工作`);
  });

  test("tasks.agent bound in scheduler_sessions (on any card): left to the session steps, not stopped here", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.card("T0", "done", "agent-other", OWN);
    f.db.query("UPDATE scheduler_sessions SET state = 'retired' WHERE taskId = 'T0'").run();
    f.working(OWN);
    await f.tick();
    expect(ownCalls(f.calls)).toEqual([]);
    expect(f.present.has(f.mine)).toBe(true);
    expect(f.notices[0]).toContain(`${OWN} 还在这里工作`);
  });

  test("kill answers ok but the window is still there: held, nothing removed or settled; the next pass kills again and finishes", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.stuck(true);
    const [held] = await f.tick();
    expect(held.step).toBe("held");
    expect(held.detail).toContain("窗口 / pending 还在");
    expect(f.removed()).toEqual([]);
    expect(f.present.size).toBe(2);
    expect(getIntent(f.db, retireIntentId("T1"))?.status).toBe("submitted");
    expect(f.notices).toEqual([]);
    f.stuck(false);
    const [out] = await f.tick();
    expect(out.step).toBe("retired");
    // the second pass does not archive again, and the first pass's archive receipt still reaches the event
    expect(ownCalls(f.calls)).toEqual([["archive", OWN], ["kill", OWN], ["kill", OWN]]);
    expect(f.removed()).toEqual([f.mine, f.rv]);
    expect(f.settleReceipt()).toContain("归档 已归档 1 个文件");
    expect(f.settleReceipt()).toContain(`停止 ${OWN} 已销毁`);
  });

  test("uncommitted changes after the executor stopped: the checkout stays and PM is told", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.dirty.set(f.mine, " M a.txt");
    const [out] = await f.tick();
    expect(out.step).toBe("handoff");
    expect(ownCalls(f.calls)).toEqual([["archive", OWN], ["kill", OWN]]);
    expect(f.present.has(f.mine)).toBe(true);
    expect(f.removed()).toEqual([f.rv]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("有未提交改动");
    expect(f.settleReceipt()).toContain(`停止 ${OWN} 已销毁`);
  });

  test("own executor working outside the card's checkouts: left alone", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN, "/elsewhere");
    const [out] = await f.tick();
    expect(out.step).toBe("retired");
    expect(ownCalls(f.calls)).toEqual([]);
  });

  test("settle refused after archive / kill / remove: the next pass settles with all three receipts, without acting again", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.settleFails(1);
    const [held] = await f.tick();
    expect(held.step).toBe("held");
    expect(getIntent(f.db, retireIntentId("T1"))?.status).toBe("submitted");
    const [out] = await f.tick();
    expect(out.step).toBe("retired");
    expect(ownCalls(f.calls)).toEqual([["archive", OWN], ["kill", OWN]]);
    const receipt = f.settleReceipt();
    expect(receipt).toContain("归档 已归档 1 个文件");
    expect(receipt).toContain(`停止 ${OWN} 已销毁`);
    expect(receipt).toContain("worktree 已清");
  });

  test("the registry read after the kill throws: the card fails this pass, the next one finishes with both receipts", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.agentsThrow(1);
    const first = await f.tickRaw();
    expect(first.failed.map((x) => x.taskId)).toEqual(["T1"]);
    expect(f.removed()).toEqual([]);
    const [out] = await f.tick();
    expect(out.step).toBe("retired");
    expect(ownCalls(f.calls)).toEqual([["archive", OWN], ["kill", OWN]]);
    expect(f.settleReceipt()).toContain("归档 已归档 1 个文件");
    expect(f.settleReceipt()).toContain(`停止 ${OWN} 已销毁`);
  });

  test("own executor already stopped in the checkout (e.g. stopped before a service restart): the stop is still receipted", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.live.push({ name: OWN, status: "stopped", sessionId: `s-${OWN}`, cwd: f.mine, pending: false, window: false });
    const [out] = await f.tick();
    expect(out.step).toBe("retired");
    expect(ownCalls(f.calls)).toEqual([]);
    expect(f.settleReceipt()).toContain(`本卡执行者 ${OWN}`);
    expect(f.settleReceipt()).toContain("registry 已是 stopped，不再 kill");
  });

  test("own executor's archive fails: still killed and the clean tree removed, but PM is told about the archive", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.archive({ ok: false, error: "injected archive failure" });
    const [out] = await f.tick();
    expect(out.step).toBe("handoff");
    expect(ownCalls(f.calls)).toEqual([["archive", OWN], ["kill", OWN]]);
    expect(f.removed()).toEqual([f.mine, f.rv]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain(`本卡执行者 ${OWN}`);
    expect(f.notices[0]).toContain("归档没成");
    expect(getIntent(f.db, retireIntentId("T1"))?.status).toBe("done");
  });

  test("settle refused, then a service restart: the next pass still writes the real archive / kill receipts", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.settleFails(1);
    expect((await f.tick())[0].step).toBe("held");
    f.restart();
    const [out] = await f.tick();
    expect(out.step).toBe("retired");
    expect(ownCalls(f.calls)).toEqual([["archive", OWN], ["kill", OWN]]);
    expect(f.settleReceipt()).toContain("归档 已归档 1 个文件");
    expect(f.settleReceipt()).toContain(`停止 ${OWN} 已销毁`);
  });

  test("archive failed, the read after the kill throws, then a restart: PM still hears about the archive", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.archive({ ok: false, error: "injected archive failure" });
    f.agentsThrow(1);
    expect((await f.tickRaw()).failed.map((x) => x.taskId)).toEqual(["T1"]);
    f.restart();
    const [out] = await f.tick();
    expect(out.step).toBe("handoff");
    expect(ownCalls(f.calls)).toEqual([["archive", OWN], ["kill", OWN]]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain(`本卡执行者 ${OWN}（不在 scheduler_sessions）：归档没成`);
    expect(f.settleReceipt()).toContain(`本卡执行者 ${OWN}（不在 scheduler_sessions）：归档 归档没成`);
    expect(f.settleReceipt()).toContain(`停止 ${OWN} 已销毁`);
  });

  test("settle refused, then the stopped executor's registry entry goes away: its receipts still reach the event", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.settleFails(1);
    expect((await f.tick())[0].step).toBe("held");
    f.live.splice(0, f.live.length);
    const [out] = await f.tick();
    expect(out.step).toBe("retired");
    expect(f.settleReceipt()).toContain(`本卡执行者 ${OWN}`);
    expect(f.settleReceipt()).toContain("归档 已归档 1 个文件");
    expect(f.settleReceipt()).toContain(`停止 ${OWN} 已销毁`);
  });

  test("another unfinished card takes the executor while it is being archived: not killed, the checkout stays, PM is told", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.working(OWN);
    f.onArchive((a) => { if (a === OWN) f.card("T2", "build", OWN, null); });
    const [out] = await f.tick();
    expect(out.step).toBe("handoff");
    expect(ownCalls(f.calls)).toEqual([["archive", OWN]]);
    expect(f.present.has(f.mine)).toBe(true);
    expect(f.removed()).toEqual([f.rv]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain(`${OWN} 还在这里工作`);
    expect(f.settleReceipt()).toContain("T2");
  });
});
