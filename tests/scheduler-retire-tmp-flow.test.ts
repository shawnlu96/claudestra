/** Real-ledger/real-worktree integration for cleanup ordering, audit receipts, restart safety and the existing PM batch. */
import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { schedulerRetireTick, worktreeDirs } from "../src/lib/scheduler-retire.js";
import { removeClaudeTmp } from "../src/lib/scheduler-retire-tmp.js";
import { recordSessionRetirement } from "../src/lib/scheduler-sessions.js";
import { fixture, scratchFixture } from "./scheduler-retire-tmp-fixture.js";

function flow(stage = "verified", opts: Parameters<ReturnType<typeof fixture>["card"]>[2] = {}) {
  const f = fixture(), scratch = scratchFixture();
  f.card("T1", stage, opts);
  const dirs = worktreeDirs(f.root, "T1"), tmpDirs = dirs.map(scratch.populate);
  f.retireDeps.removeTmp = (cwd, verify) => {
    expect(existsSync(cwd)).toBe(false);
    for (const role of ["author", "reviewer"] as const) expect(f.row("T1", role).state).toBe("retired");
    return removeClaudeTmp(cwd, verify, scratch.fs);
  };
  const events = () => listEvents(f.db, { target: "T1", project: "p" }).filter((e) => e.data.effect === "tmp");
  return { ...f, scratch, dirs, tmpDirs, events };
}

describe("retirement includes Claude scratch cleanup", () => {
  test.each(["verified", "done", "cancelled"])("%s: both sessions removed after kill/worktree; audited and idempotent", async (stage) => {
    const f = flow(stage);
    expect((await f.tick())[0].step).toBe("retired");
    expect(f.scratch.calls).toEqual(f.tmpDirs);
    expect(f.tmpDirs.every((p) => !existsSync(p))).toBe(true);
    expect(f.events()).toHaveLength(2);
    for (const e of f.events()) expect(JSON.parse(String(e.data.receipt))).toEqual({ ok: true, detail: "目录已删除" });
    expect(await f.tick()).toEqual([]);
    expect(f.notices).toEqual([]);
    expect(f.scratch.calls).toHaveLength(2);
  });
  test("works with the service's read-only database connection", async () => {
    const f = flow(), reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
    try {
      const out = await schedulerRetireTick(reader.get()!, ["p"], f.retireDeps);
      expect(out.failed).toEqual([]);
      expect(out.cards[0].step).toBe("retired");
      expect(f.events()).toHaveLength(2);
    } finally { reader.close(); }
  });
  test.each(["spec", "restate", "build", "review", "fix", "merge", "live", "blocked"])("%s: no session or scratch deletion", async (stage) => {
    const f = flow(stage);
    expect(await f.tick()).toEqual([]);
    expect(f.scratch.calls).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.tmpDirs.every(existsSync)).toBe(true);
  });
  test("worktrees already absent still permit cleanup; peer sessions never invoke it", async () => {
    const f = flow("verified", { worktrees: false });
    expect((await f.tick())[0].step).toBe("retired");
    expect(f.scratch.calls).toHaveLength(2);
    const p = flow("verified", { transport: "peer" });
    expect((await p.tick())[0].step).toBe("retired");
    expect(p.scratch.calls).toEqual([]);
    expect(p.tmpDirs.every(existsSync)).toBe(true);
    expect(p.events()).toEqual([]);
  });
  test("a failed kill or a surviving window prevents every scratch deletion", async () => {
    const f = flow();
    f.replies["kill agent-task-t1"] = () => ({ ok: false, error: "permission denied" });
    expect((await f.tick())[0].step).toBe("unknown");
    expect(f.scratch.calls).toEqual([]);
    const pending = flow();
    pending.replies["kill agent-task-t1"] = () => ({ ok: true });
    expect((await pending.tick())[0].step).toBe("held");
    expect(pending.scratch.calls).toEqual([]);
  });
  test("dirty worktree keeps its scratch, while the clean reviewer is removed; PM hears once", async () => {
    const f = flow();
    writeFileSync(join(f.dirs[0], "untracked"), "keep");
    expect((await f.tick())[0].step).toBe("handoff");
    expect(f.scratch.calls).toEqual([f.tmpDirs[1]]);
    expect(existsSync(f.tmpDirs[0])).toBe(true);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("临时目录未清");
    expect(await f.tick()).toEqual([]);
    expect(f.notices).toHaveLength(1);
  });
  test("other agent with a different cwd but colliding slug is protected, including a stopped PM", async () => {
    for (const status of ["active", "stopped"]) {
      const f = flow();
      // Keep the cwd absolute, while preserving the exact slash/dot-to-hyphen slug collision.
      f.setAgent("agent-pm", { cwd: "/" + f.dirs[0].slice(1).replaceAll("/", "-"), role: "pm", status });
      expect((await f.tick())[0].step).toBe("handoff");
      expect(existsSync(f.tmpDirs[0])).toBe(true);
      expect(f.scratch.calls).toEqual([f.tmpDirs[1]]);
    }
  });
  test("legacy manual cwd never authorizes deleting either the derived directory or its own scratch", async () => {
    const f = flow("verified", { worktrees: false }), old = join(f.dir, "pm-scratch", "manual-T1"), keep = f.scratch.populate(old);
    f.setAgent("agent-task-t1", { cwd: old });
    await f.tick();
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(f.tmpDirs[0])).toBe(true);
    expect(f.scratch.calls).toEqual([f.tmpDirs[1]]);
  });
  test("other-card slug ownership remains protected after its registry entries disappear", async () => {
    const f = flow();
    f.card("RV-T1", "build", { worktrees: false });
    for (const name of ["agent-task-rv-t1", "agent-rv-rv-t1"]) { f.setAgent(name, null); f.windows.delete(name); }
    expect((await f.tick())[0].step).toBe("handoff");
    expect(f.scratch.calls).toEqual([f.tmpDirs[0]]);
    expect(existsSync(f.tmpDirs[1])).toBe(true);
    expect(f.notices[0]).toContain("RV-T1");
  });
  test("deletion failures persist across a lost notice and service restart; one eventual PM notice", async () => {
    const f = flow(); let tries = 0;
    f.scratch.fs.rm = async () => { tries++; throw new Error("EACCES scratch"); };
    const notify = f.retireDeps.notifyPm;
    f.retireDeps.notifyPm = async () => { throw new Error("bridge down"); };
    expect((await f.tick())[0].step).toBe("held");
    expect(tries).toBe(2);
    expect(f.events()).toHaveLength(2);
    expect(getIntent(f.db, "retire:T1")?.status).toBe("submitted");
    f.retireDeps.notifyPm = notify;
    const reader = new LedgerReader(join(f.dir, "ledger.sqlite"));
    try {
      expect((await schedulerRetireTick(reader.get()!, ["p"], { ...f.retireDeps })).cards[0].step).toBe("handoff");
      expect(tries).toBe(2);
      expect(f.notices).toHaveLength(1);
      expect(f.notices[0]).toContain("EACCES scratch");
      expect((await schedulerRetireTick(reader.get()!, ["p"], { ...f.retireDeps })).cards).toEqual([]);
    } finally { reader.close(); }
  });
  test("several failed cards share the existing per-project PM notice", async () => {
    const f = flow();
    f.card("T2", "verified");
    worktreeDirs(f.root, "T2").forEach(f.scratch.populate);
    let tries = 0;
    f.scratch.fs.rm = async () => { tries++; throw new Error("read only"); };
    await f.tick();
    expect(tries).toBe(4);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("T1");
    expect(f.notices[0]).toContain("T2");
    await f.tick();
    expect(tries).toBe(4);
    expect(f.notices).toHaveLength(1);
  });
  test("lost result write is never an excuse to retry recursive deletion", async () => {
    const f = flow(), ledger = f.retireDeps.ledger; let fail = true;
    f.retireDeps.ledger = async (...args) => args.includes("tmp") && fail ? { ok: false, error: "ledger unavailable" } : ledger(...args);
    expect((await schedulerRetireTick(f.db, ["p"], f.retireDeps)).failed).toHaveLength(1);
    expect(f.scratch.calls).toEqual([f.tmpDirs[0]]);
    fail = false;
    expect((await f.tick())[0].step).toBe("handoff");
    expect(f.scratch.calls).toEqual(f.tmpDirs);
    expect(f.notices[0]).toContain("上轮清理中断");
  });
  test("registry is refreshed after writing tmp-start and blocks a newly live slug owner", async () => {
    const f = flow(), ledger = f.retireDeps.ledger;
    f.retireDeps.ledger = async (...args) => {
      const r = await ledger(...args);
      if (args.includes("tmp-start") && args.includes("author")) f.setAgent("new-owner", { cwd: f.dirs[0], status: "active" });
      return r;
    };
    expect((await f.tick())[0].step).toBe("handoff");
    expect(existsSync(f.tmpDirs[0])).toBe(true);
    expect(f.scratch.calls).toEqual([f.tmpDirs[1]]);
  });
  test("stage recheck immediately before rm prevents a stale verified snapshot from deleting", async () => {
    const f = flow(), ledger = f.retireDeps.ledger;
    f.retireDeps.ledger = async (...args) => {
      const r = await ledger(...args);
      if (args.includes("tmp-start")) f.db.query("UPDATE tasks SET stage = 'build' WHERE id = 'T1'").run();
      return r;
    };
    await expect(f.tick()).rejects.toBeInstanceOf(SchedulerStopped);
    expect(f.scratch.calls).toEqual([]);
  });
  test("scratch receipt writes retain ledger authorization and retirement preconditions", async () => {
    const f = flow(), input = { taskId: "T1", role: "author" as const, intentId: "retire:T1", effect: "tmp" as const, receipt: "evidence" };
    expect(() => recordSessionRetirement(f.db, { actor: "agent-unknown" }, input)).toThrow();
    await f.cli("scheduler", "scheduler-retire", "T1");
    expect(() => recordSessionRetirement(f.db, { actor: "scheduler" }, input)).toThrow(/会话停止/);
    f.db.query("UPDATE tasks SET stage = 'build' WHERE id = 'T1'").run();
    expect(() => recordSessionRetirement(f.db, { actor: "scheduler" }, input)).toThrow(/不能退役/);
  });
});
