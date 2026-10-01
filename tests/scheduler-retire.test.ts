/**
 * i28-S2 card retirement: a real ledger and the ledger CLI in-process, real git worktrees, a fake `manager` for archive / kill.
 * Covers the acceptance lines: full retirement, dirty worktree kept + PM told once, no --force / rm, idempotent across ticks and a
 * restart, unfinished cards untouched, peer sessions only marked.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { archiveReceipt, killOutcome, RETIRE_CARDS_PER_PASS, retireCandidates, schedulerRetireTick, worktreeDirs, type RetireDeps } from "../src/lib/scheduler-retire.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { getSchedulerSession, retireIntentId, type SchedulerSession } from "../src/lib/scheduler-sessions.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";

type Reply = Record<string, unknown>;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "i28s2-retire-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  const root = join(dir, "worktrees"), repo = join(dir, "repo");
  mkdirSync(root);
  const registryPath = join(dir, "registry.json");
  writeFileSync(registryPath, JSON.stringify({ socket: "", agents: {} }));
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
  let now = 1000;
  const deps = (actor: string): LedgerDeps => ({
    db, actor, registryPath, projectIds: ["p", "q"], now: () => (now += 10),
    loadRegistry: async () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry, saveRegistry: async () => {},
  });
  const calls: string[][] = [], gitCalls: string[][] = [], notices: string[] = [];
  const replies: Record<string, (args: string[]) => Reply> = {};
  const agent = async (...args: string[]): Promise<Reply> => {
    calls.push(args);
    const own = replies[`${args[0]} ${args[1]}`];
    if (own) return own(args);
    return args[0] === "archive" ? { ok: true, archived: ["a.jsonl"] } : { ok: true, message: `${args[1]} 已销毁。` };
  };
  const retireDeps: RetireDeps = {
    ledger: async (...args) => runLedger(args.slice(1), deps("scheduler")), agent,
    git: async (args) => { gitCalls.push(args); return git(args); },
    exists: existsSync, worktreeRoot: root, notifyPm: async (_t, text) => { notices.push(text); },
  };
  const sh = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  mkdirSync(repo);
  sh(repo, "init", "-q"); sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(join(repo, "a.txt"), "a"); sh(repo, "add", "a.txt"); sh(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a");

  /** A card at `stage` with scheduler-bound sessions; worktrees: the executor's on a branch, the reviewer's detached. */
  const card = (id: string, stage: string, opts: { project?: string; agent?: string; reviewer?: string | null; transport?: "tmux" | "peer";
    worktrees?: boolean } = {}) => {
    const author = opts.agent ?? `agent-task-${id.toLowerCase()}`;
    createTask(db, { actor: "owner", now: (now += 10) }, { project: opts.project ?? "p", id, title: id, kind: "code", agent: author });
    db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
    const bind = (role: "author" | "reviewer", name: string, transport: string) => {
      const ens = `ens:${id}:${role}`;
      db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
        VALUES (?, ?, ?, 'restate', 'ensure_session', 0, 1, 1, 2, 'done', 'test', 0, 0)`).run(ens, id, opts.project ?? "p");
      db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0, 0)`).run(id, role, name, `s-${id}-${role}`, role === "author" ? "claude" : "codex", transport, ens);
    };
    bind("author", author, opts.transport ?? "tmux");
    if (opts.reviewer !== null) bind("reviewer", opts.reviewer ?? `agent-rv-${id.toLowerCase()}`, opts.transport === "peer" ? "peer" : "acp");
    if (opts.worktrees !== false) {
      const [mine, rv] = worktreeDirs(root, id);
      sh(repo, "worktree", "add", "-q", mine, "-b", `feat/${id.toLowerCase()}`);
      sh(repo, "worktree", "add", "-q", "--detach", rv);
    }
  };
  const tick = async (projects = ["p"]) => {
    const r = await schedulerRetireTick(db, projects, retireDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards;
  };
  const row = (id: string, role: "author" | "reviewer") => getSchedulerSession(db, id, role) as SchedulerSession;
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  return { db, root, repo, card, tick, row, calls, gitCalls, notices, replies, retireDeps, cli: (actor: string, ...a: string[]) => runLedger(a, deps(actor)) };
}

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

  test("an agent PM already cleared counts as killed; a missing registry entry has nothing to archive", async () => {
    const f = fixture();
    f.card("T1", "verified", { reviewer: null, worktrees: false });
    f.replies["archive agent-task-t1"] = () => ({ ok: false, error: "agent-task-t1 不在 registry 或无 sessionId" });
    f.replies["kill agent-task-t1"] = () => ({ ok: false, error: "agent-task-t1 不存在" });
    expect((await f.tick())[0].step).toBe("retired");
    expect(f.row("T1", "author")).toMatchObject({ state: "retired", archiveReceipt: "agent 已不在 registry，无可归档", killReceipt: "agent 已不存在（先前已清）" });
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

describe("i28-S2 receipts", () => {
  test("archive / kill answers map to receipts, busy or failure", () => {
    expect(archiveReceipt({ ok: false, note: "源已被 CC 清理" })).toBe("归档没成，源 jsonl 留在原处：源已被 CC 清理");
    expect(killOutcome({ ok: true, alreadyStopped: true })).toEqual({ receipt: "agent 早已停止" });
    expect(killOutcome({ ok: false, error: "x 正在 kill（pid 1），等它结束再试" })).toHaveProperty("busy");
    expect(killOutcome({ ok: false, error: "boom" })).toEqual({ failed: "boom" });
    expect(worktreeDirs("/w", "../x")).toEqual([]);
  });
});
