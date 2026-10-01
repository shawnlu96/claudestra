/**
 * i28-S2 card retirement: a real ledger and the ledger CLI in-process, real git worktrees, a registry file, a fake `manager` for
 * archive / kill (a kill that works marks the agent stopped, as the real one does). Covers the acceptance lines: full retirement,
 * dirty worktree kept + PM told once, no --force / rm, idempotent across ticks and a restart, unfinished cards untouched, peer
 * sessions only marked; and round 1's findings: no second kill, notices resent, cancelled cards, shared checkouts, fairness, budget.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { createTask, moveStage } from "../src/lib/ledger-write.js";
import { schedulerPass } from "../src/lib/scheduler-pass.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import type { TickPace } from "../src/lib/scheduler-yield.js";
import { archiveReceipt, killOutcome, readLiveAgents, RETIRE_CARDS_PER_PASS, retireCandidates, schedulerRetireTick, worktreeDirs }
  from "../src/lib/scheduler-retire.js";
import { retireIntentId } from "../src/lib/scheduler-sessions.js";
import { runManagerProcess } from "../src/lib/run-manager.js";

import { fixture } from "./scheduler-retire-tmp-fixture.js";

describe("i28-S2 card retirement", () => {
  test("verified card: archive then kill each session, remove both clean worktrees, rows retired with receipts", async () => {
    const f = fixture();
    f.card("T1", "verified");
    const [out] = await f.tick();
    expect(out).toMatchObject({ taskId: "T1", step: "retired" });
    expect(f.calls).toEqual([["archive", "agent-task-t1"], ["kill", "agent-task-t1"], ["archive", "agent-rv-t1"], ["kill", "agent-rv-t1"]]);
    for (const role of ["author", "reviewer"] as const) {
      expect(f.row("T1", role)).toMatchObject({ state: "retired", retireIntentId: "retire:T1", archiveReceipt: "已归档 1 个文件" });
      expect(f.row("T1", role).killReceipt).toContain("已销毁");
    }
    for (const d of worktreeDirs(f.root, "T1")) expect(existsSync(d)).toBe(false);
    expect(getIntent(f.db, retireIntentId("T1"))?.status).toBe("done");
    expect(f.notices).toEqual([]);
  });

  test("a dirty worktree stays, PM hears once, the card carries the event; the clean one is still removed", async () => {
    const f = fixture();
    f.card("T1", "verified");
    const [mine, rv] = worktreeDirs(f.root, "T1");
    writeFileSync(join(mine, "a.txt"), "edited");
    writeFileSync(join(mine, "new.txt"), "untracked");
    const [out] = await f.tick();
    expect(out.step).toBe("handoff");
    expect(readFileSync(join(mine, "a.txt"), "utf8")).toBe("edited");
    expect(existsSync(join(mine, "new.txt"))).toBe(true);
    expect(existsSync(rv)).toBe(false);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain(mine);
    expect(f.notices[0]).toContain("a.txt");
    const settle = listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.data.op === "settle" && e.data.to === "done");
    expect(String(settle?.data.receipt)).toContain("有未提交改动");
    expect(await f.tick()).toEqual([]);
    expect(f.notices).toHaveLength(1);
  });

  test("worktrees kept on several cards in one pass reach PM as one combined notice", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    f.card("T2", "cancelled", { reviewer: null });
    for (const id of ["T1", "T2"]) writeFileSync(join(worktreeDirs(f.root, id)[0], "wip.txt"), "wip");
    expect((await f.tick()).map((c) => c.step)).toEqual(["handoff", "handoff"]);
    expect(f.notices).toHaveLength(1);
    for (const id of ["T1", "T2"]) expect(f.notices[0]).toContain(worktreeDirs(f.root, id)[0]);
    for (const id of ["T1", "T2"]) {
      expect(listEvents(f.db, { project: "p", target: id }).filter((e) => e.data.op === "settle" && e.data.to === "done")).toHaveLength(1);
    }
  });

  test("never --force, rm, or -delete: removal is plain `git worktree remove`", async () => {
    const f = fixture();
    f.card("T1", "verified");
    f.card("T2", "cancelled");
    writeFileSync(join(worktreeDirs(f.root, "T2")[0], "x.txt"), "x");
    await f.tick();
    const all = [...f.calls, ...f.gitCalls].flat();
    expect(all.some((a) => /^(--force|-f|rm|-delete|--delete)$/.test(a))).toBe(false);
    expect(f.gitCalls.filter((a) => a.includes("remove"))).toEqual(
      [...worktreeDirs(f.root, "T1"), worktreeDirs(f.root, "T2")[1]].map((d) => ["-C", d, "worktree", "remove", d]));
  });

  test("unfinished cards are never retired, whatever their sessions; the ledger refuses them too", async () => {
    const f = fixture();
    for (const [i, stage] of ["spec", "restate", "build", "review", "fix", "merge", "live", "blocked"].entries()) f.card(`U${i}`, stage, { worktrees: false });
    expect(retireCandidates(f.db, ["p"])).toEqual([]);
    expect(await f.tick()).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.row("U6", "author").state).toBe("active");
    const r = await f.cli("scheduler", "scheduler-retire", "U6");
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(String(r.error)).toContain("没收尾的卡不退役");
  });

  test("cancelled and done cards retire too; projects outside the scheduler config are left alone", async () => {
    const f = fixture();
    f.card("C1", "cancelled", { worktrees: false });
    f.card("D1", "done", { worktrees: false });
    f.card("Q1", "verified", { project: "q", worktrees: false });
    expect((await f.tick()).map((c) => [c.taskId, c.step])).toEqual([["C1", "retired"], ["D1", "retired"]]);
    expect(f.row("Q1", "author").state).toBe("active");
  });

  test("peer sessions: nothing is sent anywhere, the row is only marked retired", async () => {
    const f = fixture();
    f.card("P1", "verified", { transport: "peer", worktrees: false });
    const [out] = await f.tick();
    expect(out.step).toBe("retired");
    expect(f.calls).toEqual([]);
    expect(f.row("P1", "author")).toMatchObject({ state: "retired", killReceipt: "peer 会话：不在本机，不发命令，只标退役" });
  });

  test("an agent PM already cleared is not killed again; a missing registry entry has nothing to archive", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null, worktrees: false });
    f.setAgent("agent-task-t1", null);
    f.windows.delete("agent-task-t1");
    f.replies["archive agent-task-t1"] = () => ({ ok: false, error: "agent-task-t1 不在 registry 或无 sessionId" });
    expect((await f.tick())[0].step).toBe("retired");
    expect(f.calls).toEqual([["archive", "agent-task-t1"]]);
    expect(f.row("T1", "author")).toMatchObject({ state: "retired", archiveReceipt: "agent 已不在 registry，无可归档",
      killReceipt: "agent 已不在（registry 没有条目，tmux 没有窗口）" });
  });

  test("busy kill resumes next tick without archiving again; repeated ticks and a fresh service never kill twice", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    f.replies["kill agent-task-t1"] = () => ({ ok: false, error: "agent-task-t1 正在 restart（窗口在重建），等它结束再 kill" });
    expect((await f.tick())[0].step).toBe("held");
    expect(f.row("T1", "author")).toMatchObject({ state: "retiring", killReceipt: null });
    delete f.replies["kill agent-task-t1"];
    // a restarted service: brand-new deps over the same ledger
    const again = await schedulerRetireTick(f.db, ["p"], { ...f.retireDeps });
    expect(again.cards[0].step).toBe("retired");
    for (let i = 0; i < 3; i++) expect(await f.tick()).toEqual([]);
    expect(f.calls.filter((c) => c[0] === "archive")).toHaveLength(1);
    expect(f.calls.filter((c) => c[0] === "kill")).toHaveLength(2); // the busy refusal + the one that worked
  });

  test("a kill that fails for another reason goes to PM once as an unknown intent and is not retried", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    f.replies["kill agent-task-t1"] = () => ({ ok: false, error: "registry 写不进去" });
    expect((await f.tick())[0].step).toBe("unknown");
    expect(getIntent(f.db, "retire:T1")?.status).toBe("unknown");
    expect(f.notices).toHaveLength(1);
    expect(existsSync(worktreeDirs(f.root, "T1")[0])).toBe(true);
    expect(await f.tick()).toEqual([]);
    expect(f.notices).toHaveLength(1);
  });

  test("an agent still used by an unfinished card is not killed", async () => {
    const f = fixture();
    f.card("T1", "verified", { agent: "agent-shared", reviewer: null, worktrees: false });
    createTask(f.db, { actor: "owner", now: 5000 }, { project: "p", id: "T9", title: "busy", kind: "code", agent: "agent-shared" });
    await f.tick();
    expect(f.calls).toEqual([["archive", "agent-shared"]]);
    expect(f.row("T1", "author")).toMatchObject({ state: "retired", killReceipt: "agent 仍被未收尾的 T9 使用：不 kill，只标退役" });
  });

  test("a card with another open intent waits; at most RETIRE_CARDS_PER_PASS cards per pass", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null, worktrees: false });
    f.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('rv:T1', 'T1', 'p', 'adversarial_review', 'review', 0, 1, 1, 2, 'submitted', 'test', 0, 0)`).run();
    expect(retireCandidates(f.db, ["p"])).toEqual([]);
    for (let i = 0; i < 6; i++) f.card(`V${i}`, "verified", { reviewer: null, worktrees: false });
    expect(await f.tick()).toHaveLength(RETIRE_CARDS_PER_PASS);
    expect(await f.tick()).toHaveLength(6 - RETIRE_CARDS_PER_PASS);
    expect(f.row("T1", "author").state).toBe("active");
  });
});

const intentRow = (id: string, taskId: string, action: string, status: string) =>
  [`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
    VALUES (?, ?, 'p', 'write', ?, 0, 1, 1, 2, ?, 'test', 0, 0)`, id, taskId, action, status] as const;

describe("i28-S2 round 1 findings", () => {
  test("kill-retry: a kill whose receipt never reached the ledger is not sent again", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null, worktrees: false });
    const ledger = f.retireDeps.ledger;
    let fail = true;
    f.retireDeps.ledger = async (...args) => {
      if (fail && args[1] === "scheduler-session-retire" && args.includes("kill")) { fail = false; return { ok: false, error: "injected" }; }
      return ledger(...args);
    };
    expect((await f.tick())[0].step).toBe("held");
    expect(f.row("T1", "author").killReceipt).toBeNull();
    expect((await schedulerRetireTick(f.db, ["p"], { ...f.retireDeps })).cards[0].step).toBe("retired");
    expect(f.calls.filter((c) => c[0] === "kill")).toHaveLength(1);
    expect(f.row("T1", "author").killReceipt).toBe("agent 早已停止，不再 kill");
  });

  test("kill-retry: a name now running another session is not killed; PM hears about it", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null, worktrees: false });
    f.setAgent("agent-task-t1", { sessionId: "s-other" });
    expect((await f.tick())[0].step).toBe("handoff");
    expect(f.calls.filter((c) => c[0] === "kill")).toEqual([]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("s-other");
  });

  test("notice-lost: a notice that failed keeps the card open and goes out next pass, once", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    const dir = worktreeDirs(f.root, "T1")[0];
    writeFileSync(join(dir, "draft.txt"), "keep");
    const notify = f.retireDeps.notifyPm;
    f.retireDeps.notifyPm = async () => { throw new Error("bridge down"); };
    expect((await f.tick())[0]).toMatchObject({ step: "held" });
    expect(getIntent(f.db, "retire:T1")?.status).toBe("submitted");
    f.retireDeps.notifyPm = notify;
    expect((await f.tick())[0].step).toBe("handoff");
    expect(await f.tick()).toEqual([]);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain(dir);
    expect(existsSync(join(dir, "draft.txt"))).toBe(true);
    expect(getIntent(f.db, "retire:T1")?.status).toBe("done");
  });

  test("archive-notice: a failed archive still retires the session and reaches PM in the combined notice", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null, worktrees: false });
    f.replies["archive agent-task-t1"] = () => ({ ok: false, archived: [], note: "archive destination full" });
    expect((await f.tick())[0].step).toBe("handoff");
    expect(f.row("T1", "author").state).toBe("retired");
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("archive destination full");
  });

  test("shared-worktree: a checkout a live agent of an unfinished card works in stays and goes to PM", async () => {
    const f = fixture();
    f.card("T1", "verified", { agent: "agent-shared", reviewer: null });
    createTask(f.db, { actor: "owner", now: 5000 }, { project: "p", id: "T9", title: "busy", kind: "code", agent: "agent-shared" });
    f.db.query("UPDATE tasks SET stage = 'build' WHERE id = 'T9'").run();
    const [mine, rv] = worktreeDirs(f.root, "T1");
    expect((await f.tick())[0].step).toBe("handoff");
    expect(f.calls.filter((c) => c[0] === "kill")).toEqual([]);
    expect(existsSync(mine)).toBe(true);
    expect(existsSync(rv)).toBe(false);
    expect(f.notices[0]).toContain("agent-shared 还在这里工作");
  });

  test("cancel-open: a card cancelled mid-dispatch has its stray intent closed and its sessions retired", async () => {
    const f = fixture();
    f.card("T1", "build", { reviewer: null, worktrees: false });
    f.db.query(intentRow("write:T1", "T1", "dispatch", "submitted")[0]).run(...intentRow("write:T1", "T1", "dispatch", "submitted").slice(1));
    moveStage(f.db, { actor: "owner", now: 5000 }, { taskId: "T1", from: "build", to: "cancelled" });
    expect((await f.tick())[0].step).toBe("retired");
    expect(getIntent(f.db, "write:T1")?.status).toBe("cancelled");
    expect(f.row("T1", "author").state).toBe("retired");
  });

  test("cancel-open: merge queue intents and unknown ones still make a cancelled card wait", () => {
    const f = fixture();
    f.card("T1", "cancelled", { reviewer: null, worktrees: false });
    f.card("T2", "cancelled", { reviewer: null, worktrees: false });
    for (const r of [intentRow("m:T1", "T1", "merge", "submitted"), intentRow("w:T2", "T2", "dispatch", "unknown")]) f.db.query(r[0]).run(...r.slice(1));
    expect(retireCandidates(f.db, ["p"])).toEqual([]);
  });

  test("retire-fairness: five cards held every pass do not keep a sixth from its turn", async () => {
    const f = fixture();
    for (let n = 0; n < 6; n++) {
      f.card(`T${n}`, "verified", { reviewer: null, worktrees: false });
      if (n < 5) f.replies[`kill agent-task-t${n}`] = () => ({ ok: false, error: "正在 restart，等它结束再 kill" });
    }
    const pace: TickPace = { cursor: {}, yieldNow: () => false };
    for (let n = 0; n < 2; n++) expect(await f.tick(["p"], pace)).toHaveLength(RETIRE_CARDS_PER_PASS);
    expect(f.row("T5", "author").state).toBe("retired");
  });

  test("retire-budget: retirement gets its own floor after a slow autostart spent the pass budget", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null, worktrees: false });
    const res = await schedulerPass(f.db, passConfig(f.repo, true), {
      assertOwner: () => {}, budgetMs: 300, manager: f.retireDeps.ledger, peerPr: async () => ({ failed: [] }),
      maintenance: { path: join(f.root, "m.lock"), marker: join(f.root, "u.marker"), request: join(f.root, "u.request") },
      autoDeps: () => ({}) as never,
      autostart: () => ({ resume: async () => [], start: async () => { await Bun.sleep(400); return []; } }),
      retire: async (db, _c, _m, _a, _l, pace) => (await schedulerRetireTick(db, ["p"], f.retireDeps, pace)).failed,
    });
    expect(res.failed).toEqual([]);
    expect(f.row("T1", "author").state).toBe("retired");
  });
});

const passConfig = (repo: string, autoDispatch: boolean) =>
  ({ enabled: true, pollMs: 1000, autoDispatch, projects: { p: { repo, requiredChecks: [], maxActiveWorkers: 1 } } }) as unknown as SchedulerConfig;

describe("i28-S2 round 2 findings", () => {
  test("kill-retry: a kill left half done (stopped + pending) is run again, and its checkout waits for it", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    f.setAgent("agent-task-t1", { status: "stopped", pending: { op: "kill", pid: 0, at: 1 } });
    expect((await f.tick())[0].step).toBe("retired");
    expect(f.calls.filter((c) => c[0] === "kill")).toEqual([["kill", "agent-task-t1"]]);
    expect(f.row("T1", "author").killReceipt).toContain("已销毁");
  });

  test("kill-retry: a half-done kill that is still running holds the card and keeps the checkout", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    f.setAgent("agent-task-t1", { status: "stopped", pending: { op: "kill", pid: 1, at: 1 } });
    f.replies["kill agent-task-t1"] = () => ({ ok: false, error: "agent-task-t1 正在 kill（pid 1），等它结束再试" });
    expect((await f.tick())[0].step).toBe("held");
    expect(f.row("T1", "author").killReceipt).toBeNull();
    expect(existsSync(worktreeDirs(f.root, "T1")[0])).toBe(true);
  });

  test("kill-retry: stopped with no pending but a window still open is not taken as stopped: kill runs", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    f.setAgent("agent-task-t1", { status: "stopped" });
    expect((await f.tick())[0].step).toBe("retired");
    expect(f.calls.filter((c) => c[0] === "kill")).toEqual([["kill", "agent-task-t1"]]);
  });

  test("kill-retry: tmux that cannot be read stops the card before any kill or removal", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    f.setAgent("agent-task-t1", { status: "stopped" });
    f.tmux(false);
    const r = await schedulerRetireTick(f.db, ["p"], f.retireDeps);
    expect(r.failed[0].error).toContain("tmux 列不出窗口");
    expect(f.calls.filter((c) => c[0] === "kill")).toEqual([]);
    expect(f.row("T1", "author").killReceipt).toBeNull();
    expect(existsSync(worktreeDirs(f.root, "T1")[0])).toBe(true);
  });

  test("kill-retry: an unreadable registry stops the card before any kill or removal", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    const r = await schedulerRetireTick(f.db, ["p"], { ...f.retireDeps, agents: () => readLiveAgents(join(f.dir, "missing.json"), async () => []) });
    expect(r.failed[0].error).toContain("registry 读不出来");
    expect(f.calls.filter((c) => c[0] === "kill")).toEqual([]);
    expect(existsSync(worktreeDirs(f.root, "T1")[0])).toBe(true);
  });

  test("notice-lost: a notice that went out is not resent when only its settle failed", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    writeFileSync(join(worktreeDirs(f.root, "T1")[0], "draft.txt"), "keep");
    const ledger = f.retireDeps.ledger;
    let fail = true;
    f.retireDeps.ledger = async (...args) => {
      if (fail && args[1] === "scheduler-settle" && args[2] === "retire:T1") { fail = false; return { ok: false, error: "injected" }; }
      return ledger(...args);
    };
    expect((await f.tick())[0].step).toBe("held");
    expect((await schedulerRetireTick(f.db, ["p"], { ...f.retireDeps })).cards[0].step).toBe("handoff");
    expect(f.notices).toHaveLength(1);
    expect(getIntent(f.db, "retire:T1")?.status).toBe("done");
  });

  test("retire-gate: finished cards are collected with autoDispatch off too", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null, worktrees: false });
    let auto = 0;
    for (let n = 0; n < 2; n++) {
      await schedulerPass(f.db, passConfig(f.repo, false), {
        assertOwner: () => {}, manager: f.retireDeps.ledger, peerPr: async () => { auto++; return { failed: [] }; },
        maintenance: { path: join(f.root, "m.lock"), marker: join(f.root, "u.marker"), request: join(f.root, "u.request") },
        retire: async (db, _c, _m, _a, _l, pace) => (await schedulerRetireTick(db, ["p"], f.retireDeps, pace)).failed,
      });
    }
    expect(auto).toBe(0);
    expect(f.row("T1", "author").state).toBe("retired");
  });
});

describe("i28-S2 round 3 findings", () => {
  test("notice-lost: a notice whose text keeps changing goes out once while its settle keeps failing", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    const mine = worktreeDirs(f.root, "T1")[0];
    writeFileSync(join(mine, "draft-0.txt"), "keep");
    const ledger = f.retireDeps.ledger;
    let fail = true;
    f.retireDeps.ledger = async (...args) => (fail && args[1] === "scheduler-settle" && args[2] === "retire:T1" ? { ok: false, error: "injected" } : ledger(...args));
    for (let n = 0; n < 5; n++) {
      expect((await f.tick())[0].step).toBe("held");
      renameSync(join(mine, `draft-${n % 2}.txt`), join(mine, `draft-${(n + 1) % 2}.txt`)); // the porcelain flips between two states
    }
    expect(f.notices).toHaveLength(1);
    expect(getIntent(f.db, "retire:T1")?.status).toBe("submitted");
    fail = false;
    expect((await f.tick())[0].step).toBe("handoff");
    expect(f.notices).toHaveLength(1);
    expect(getIntent(f.db, "retire:T1")?.status).toBe("done");
    expect(existsSync(mine)).toBe(true);
  });

  test("kill-retry: a kill that answers ok with the window still open is not receipted; the next pass kills again", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null });
    f.replies["kill agent-task-t1"] = () => { f.setAgent("agent-task-t1", { status: "stopped", pending: undefined }); return { ok: true, message: "已销毁" }; };
    expect((await f.tick())[0].step).toBe("held");
    expect(f.row("T1", "author").killReceipt).toBeNull();
    expect(f.row("T1", "author").state).not.toBe("retired");
    expect(getIntent(f.db, "retire:T1")?.status).toBe("submitted");
    expect(existsSync(worktreeDirs(f.root, "T1")[0])).toBe(true);
    delete f.replies["kill agent-task-t1"];
    expect((await f.tick())[0].step).toBe("retired");
    expect(f.calls.filter((c) => c[0] === "kill")).toHaveLength(2);
    expect(f.row("T1", "author").state).toBe("retired");
  });
});

describe("i28-S2 round 5 findings", () => {
  test("notice-lost: a settle that rejects keeps every card of the delivered notice remembered; nothing is resent", async () => {
    const f = fixture();
    for (const id of ["T1", "T2"]) {
      f.card(id, "verified", { reviewer: null });
      writeFileSync(join(worktreeDirs(f.root, id)[0], "draft.txt"), "keep");
    }
    const ledger = f.retireDeps.ledger;
    let fail = true;
    f.retireDeps.ledger = async (...a) => {
      if (!fail || a[1] !== "scheduler-settle" || a[2] !== "retire:T1") return ledger(...a);
      fail = false; // the manager child failing to start rejects instead of answering {ok:false}
      return runManagerProcess(a, { bunPath: join(f.dir, "missing-executable"), managerPath: "unused", timeoutMs: 1000, env: {} });
    };
    expect((await f.tick()).map((c) => [c.taskId, c.step])).toEqual([["T1", "held"], ["T2", "handoff"]]);
    expect(f.notices).toHaveLength(1);
    expect((await f.tick()).map((c) => [c.taskId, c.step])).toEqual([["T1", "handoff"]]);
    expect(f.notices).toHaveLength(1);
    expect(["retire:T1", "retire:T2"].map((id) => getIntent(f.db, id)?.status)).toEqual(["done", "done"]);
  });
});

describe("i28-S2 receipts", () => {
  test("archive / kill answers map to receipts, busy or failure", () => {
    expect(archiveReceipt({ ok: false, note: "源已被 CC 清理" })).toBe("归档没成，源 jsonl 留在原处：源已被 CC 清理");
    expect(killOutcome({ ok: true, alreadyStopped: true })).toEqual({ receipt: "agent 早已停止" });
    expect(killOutcome({ ok: false, error: "x 正在 kill（pid 1），等它结束再试" })).toHaveProperty("busy");
    expect(killOutcome({ ok: false, error: "boom" })).toEqual({ failed: "boom" });
    expect(killOutcome({ ok: false, error: "x 不存在" })).toEqual({ receipt: "agent 已不存在（先前已清）" });
    expect(worktreeDirs("/w", "../x")).toEqual([]);
  });
});
