/**
 * LIFE3 retired worktree cleanup on real temporary git worktrees: untracked-only checkouts are archived (bytes, permission bits,
 * symlink text, dotfiles, ignored files; regenerable dirs listed as excluded), verified and then `git worktree remove`d; tracked /
 * staged / conflicting changes are kept and reported once per state across ticks and restarts with a persistent back-off; a
 * failed archive, an occupied target, a symlinked / outside / main checkout, a holder and any read failure all delete nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "../src/lib/agent-lifecycle-config.js";
import { archiveSurvey, archiveTarget } from "../src/lib/agent-lifecycle-cleanup-archive.js";
import { BACKOFF_BASE_MS } from "../src/lib/agent-lifecycle-cleanup-gate.js";
import { surveyCheckout, type Survey } from "../src/lib/agent-lifecycle-cleanup-scan.js";
import { retireWorktree, type WorktreeCleanupDeps } from "../src/lib/agent-lifecycle-cleanup.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";
import { cardWorkerIndex, pendingCleanups, recordWorkerRetire, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle } from "../src/lib/agent-lifecycle.js";
import { ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { LiveAgent } from "../src/lib/scheduler-retire.js";
import { git } from "../src/lib/scheduler-review-worktree.js";

const H = 3_600_000, NOW = 100 * H;
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
};

/** A repo with one tracked file and `.gitignore`, and a linked worktree `wt` under `root`. */
function fixture(name = "w1") {
  const dir = mkdtempSync(join(tmpdir(), "life3-"));
  cleanup.push(() => { try { chmodSync(join(dir, "worktrees", name, "locked-dir"), 0o755); } catch { /* only one test makes it */ } rmSync(dir, { recursive: true, force: true }); });
  const repo = join(dir, "repo"), root = join(dir, "worktrees"), wt = join(root, name), archive = join(dir, "archive");
  mkdirSync(repo); mkdirSync(root);
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "tracked\n"); writeFileSync(join(repo, ".gitignore"), "node_modules\n.env\n*.log\n");
  sh(repo, "add", "."); sh(repo, "commit", "-q", "-m", "base");
  sh(repo, "worktree", "add", "-q", "--detach", wt);
  const deps: WorktreeCleanupDeps = { git, worktreeRoot: root, now: () => NOW, cleanupArchiveRoot: archive, cleanupStatePath: join(dir, "cleanup.json") };
  return { dir, repo, root, wt, archive, deps };
}

const none = async (): Promise<LiveAgent[]> => [];
const owner = { agent: "agent-x", sessionId: "sess-1", regAt: 7 };

describe("untracked only: archive, verify, remove", () => {
  test("every untracked / ignored / dot / symlink / empty-dir entry archived byte- and mode-exact; node_modules excluded; worktree removed", async () => {
    const { repo, wt, archive, deps } = fixture();
    mkdirSync(join(wt, "notes/deep"), { recursive: true });
    writeFileSync(join(wt, "notes/deep/wip.md"), "work in progress");
    writeFileSync(join(wt, ".hidden"), "dot"); writeFileSync(join(wt, ".env"), "SECRET=1"); writeFileSync(join(wt, "run.log"), "log");
    writeFileSync(join(wt, "tool.sh"), "#!/bin/sh\n"); chmodSync(join(wt, "tool.sh"), 0o750);
    symlinkSync("/definitely/not/here", join(wt, "dangling")); symlinkSync("a.txt", join(wt, "rel-link"));
    mkdirSync(join(wt, "empty"));
    mkdirSync(join(wt, "node_modules/pkg"), { recursive: true }); writeFileSync(join(wt, "node_modules/pkg/index.js"), "x");
    const steps: string[] = [];
    expect(await retireWorktree(deps, wt, owner, [], none, steps)).toBeNull();
    expect(existsSync(wt)).toBe(false);
    expect(sh(repo, "worktree", "list")).not.toContain("w1");
    const dirs = steps.join("\n").match(/→ ([^；\s]+)/);
    expect(dirs).not.toBeNull();
    const files = join(dirs![1], "files");
    expect(dirs![1].startsWith(join(archive, "agent-x", "worktree-leftovers", "sess-1", "w1-"))).toBe(true);
    expect(readFileSync(join(files, "notes/deep/wip.md"), "utf8")).toBe("work in progress");
    expect([readFileSync(join(files, ".hidden"), "utf8"), readFileSync(join(files, ".env"), "utf8"), readFileSync(join(files, "run.log"), "utf8")]).toEqual(["dot", "SECRET=1", "log"]);
    expect(lstatSync(join(files, "tool.sh")).mode & 0o7777).toBe(0o750);
    expect([readlinkSync(join(files, "dangling")), readlinkSync(join(files, "rel-link"))]).toEqual(["/definitely/not/here", "a.txt"]);
    expect(lstatSync(join(files, "empty")).isDirectory()).toBe(true);
    expect(existsSync(join(files, "node_modules"))).toBe(false);
    const m = JSON.parse(readFileSync(join(dirs![1], "manifest.json"), "utf8"));
    expect(m).toMatchObject({ agent: "agent-x", sessionId: "sess-1", regAt: 7, excluded: ["node_modules"] });
    expect(m.entries.map((e: { path: string }) => e.path).sort()).toEqual([".env", ".hidden", "dangling", "empty", "notes/deep/wip.md", "rel-link", "run.log", "tool.sh"]);
    expect(steps.join()).toContain("可再生目录不归档：node_modules");
  });

  test("clean checkout: removed with no archive folder", async () => {
    const { wt, archive, deps } = fixture();
    const steps: string[] = [];
    expect(await retireWorktree(deps, wt, owner, [], none, steps)).toBeNull();
    expect([existsSync(wt), existsSync(archive), steps]).toEqual([false, false, []]);
  });
});

describe("kept as is", () => {
  test("modified / staged / conflict: nothing moved, untracked files stay, reason lists real names and kinds", async () => {
    for (const kind of ["modified", "staged", "conflict"] as const) {
      const { wt, archive, deps } = fixture();
      writeFileSync(join(wt, "untracked.txt"), "keep me");
      if (kind === "modified") writeFileSync(join(wt, "a.txt"), "changed\n");
      if (kind === "staged") { writeFileSync(join(wt, "new.ts"), "x"); sh(wt, "add", "new.ts"); }
      if (kind === "conflict") {
        sh(wt, "checkout", "-q", "-b", "one"); writeFileSync(join(wt, "a.txt"), "one\n"); sh(wt, "commit", "-qam", "one");
        sh(wt, "checkout", "-q", "-b", "two", "HEAD~1"); writeFileSync(join(wt, "a.txt"), "two\n"); sh(wt, "commit", "-qam", "two");
        expect(() => sh(wt, "merge", "one")).toThrow();
      }
      const why = await retireWorktree(deps, wt, owner, [], none, []);
      expect(why).toContain({ modified: "已修改 1：a.txt", staged: "已暂存 1：new.ts", conflict: "冲突 1：a.txt" }[kind]);
      expect([existsSync(join(wt, "untracked.txt")), existsSync(archive)]).toEqual([true, false]);
    }
  });

  test("symlinked, outside, nested, main repo, locked: zero deletion", async () => {
    const { dir, repo, root, wt, deps } = fixture();
    writeFileSync(join(wt, "u.txt"), "u");
    symlinkSync(wt, join(root, "link"));
    expect(await retireWorktree(deps, join(root, "link"), owner, [], none, [])).toContain("符号链接");
    expect(await retireWorktree(deps, repo, owner, [], none, [])).toContain("外部路径");
    expect(await retireWorktree({ ...deps, worktreeRoot: dir }, repo, owner, [], none, [])).toContain("主仓库");
    mkdirSync(join(wt, "sub"));
    expect(await retireWorktree({ ...deps, worktreeRoot: wt }, join(wt, "sub"), owner, [], none, [])).toContain("顶层");
    sh(repo, "worktree", "lock", wt);
    expect(await retireWorktree(deps, wt, owner, [], none, [])).toContain("lock");
    expect([existsSync(join(wt, "u.txt")), existsSync(repo)]).toEqual([true, true]);
  });

  test("a holder (same-name new session, or appearing before the move) and git read failure keep everything", async () => {
    const { wt, archive, deps } = fixture();
    writeFileSync(join(wt, "u.txt"), "u");
    const newcomer: LiveAgent = { name: "agent-x", status: "active", sessionId: "sess-2", cwd: wt, pending: false, window: true };
    expect(await retireWorktree(deps, wt, owner, [newcomer], none, [])).toContain("还在这里工作");
    expect(await retireWorktree(deps, wt, owner, [], async () => [newcomer], [])).toContain("刚进了这个目录");
    expect(existsSync(join(wt, "u.txt"))).toBe(true); // archived, but not moved
    const broken = { ...deps, git: async () => ({ code: 128, out: "fatal: synthetic" }) };
    expect(await retireWorktree(broken, wt, owner, [], none, [])).toContain("synthetic");
    expect(existsSync(join(wt, "u.txt"))).toBe(true);
    expect(existsSync(archive)).toBe(true);
  });

  test("a file written between archive and move: nothing moved this pass", async () => {
    const { wt, deps } = fixture();
    writeFileSync(join(wt, "u.txt"), "u");
    const sneaky = async () => { writeFileSync(join(wt, "late.txt"), "late"); return []; };
    expect(await retireWorktree(deps, wt, owner, [], sneaky, [])).toContain("复核时内容变了");
    expect([existsSync(join(wt, "u.txt")), existsSync(join(wt, "late.txt"))]).toEqual([true, true]);
  });
});

describe("archive failures and restarts", () => {
  test("interrupted archive leaves originals and a partial nobody reads; a rerun completes into a new folder", async () => {
    const { wt, archive, deps } = fixture();
    writeFileSync(join(wt, "u1.txt"), "1"); writeFileSync(join(wt, "u2.txt"), "2");
    const survey = await surveyCheckout(git, realpathSync(wt)) as Survey;
    const o = { agent: "agent-x", sessionId: "sess-1", regAt: 7, checkout: wt };
    unlinkSync(join(wt, "u2.txt")); // source vanishes mid-copy
    const r = await archiveSurvey(archive, o, survey, NOW);
    expect("why" in r).toBe(true);
    expect(existsSync(archiveTarget(archive, o, survey)!)).toBe(false);
    writeFileSync(join(wt, "u2.txt"), "2");
    expect(await retireWorktree(deps, wt, owner, [], none, [])).toBeNull();
    expect(readFileSync(join(archiveTarget(archive, o, survey)!, "files", "u2.txt"), "utf8")).toBe("2");
  });

  test("an occupied target with other content is never overwritten; the worktree stays", async () => {
    const { wt, archive, deps } = fixture();
    writeFileSync(join(wt, "u.txt"), "u");
    const survey = await surveyCheckout(git, realpathSync(wt)) as Survey;
    const target = archiveTarget(archive, { agent: "agent-x", sessionId: "sess-1", regAt: 7, checkout: wt }, survey)!;
    mkdirSync(join(target, "files"), { recursive: true }); writeFileSync(join(target, "files", "u.txt"), "older archive");
    expect(await retireWorktree(deps, wt, owner, [], none, [])).toContain("不覆盖");
    expect([readFileSync(join(target, "files", "u.txt"), "utf8"), existsSync(join(wt, "u.txt"))]).toEqual(["older archive", true]);
  });
});

describe("ledger: notify once, back off, survive restart", () => {
  function ledger() {
    const dir = mkdtempSync(join(tmpdir(), "life3-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
    createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "C1", title: "C1", kind: "code" });
    db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'C1'").run();
    return db;
  }

  test("tracked change: one worker_retire event and one failed report across ticks / restarts; a state change reports again; clean finishes", async () => {
    const db = ledger();
    const { wt, root, deps: wd } = fixture();
    writeFileSync(join(wt, "a.txt"), "changed\n");
    registerWorker(db, { agent: "agent-c", sessionId: "s1", taskId: "C1", role: "author", createdBy: "pm", now: 5 });
    recordWorkerRetire(db, "scheduler", { agent: "agent-c", sessionId: "s1", taskId: "C1", role: "author", rule: "card_finished", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: false });
    let t = NOW;
    const deps = (): LifecycleDeps => ({ manager: async () => ({ ok: true }), git, exists: existsSync, worktreeRoot: root, agents: none, du: async () => 0,
      swapPct: async () => 0, record: async (r) => recordWorkerRetire(db, "scheduler", r), now: () => t,
      cleanupStatePath: wd.cleanupStatePath, cleanupArchiveRoot: wd.cleanupArchiveRoot }); // a fresh deps object = a restarted process
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const tick = () => runLifecycle(planLifecycle({ now: t, policy: on, agents: [], index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: new Set(),
      master: new Set(), swapPct: 10, pending: pendingCleanups(db) }), on, deps());
    const events = () => listEvents(db, { project: "p" }).filter((e) => (e.data as { op?: string }).op === "worker_retire" && (e.data as { retry?: boolean }).retry);
    const reports: string[] = [];
    for (let i = 0; i < 6; i++) { reports.push(...(await tick()).failed.map((f) => f.error)); t += BACKOFF_BASE_MS / 2; }
    expect(reports.length).toBe(1);
    expect(events().length).toBe(1);
    expect(String((events()[0].data as { steps: string[] }).steps)).toContain("已修改 1：a.txt");
    expect([existsSync(join(wt, "a.txt")), pendingCleanups(db).length]).toEqual([true, 1]);
    // state change: another file staged → reported again once
    writeFileSync(join(wt, "b.ts"), "b"); sh(wt, "add", "b.ts");
    t += 3 * H;
    expect((await tick()).failed.length).toBe(1);
    t += 3 * H;
    expect((await tick()).failed.length).toBe(0);
    expect(events().length).toBe(2);
    // PM resolves it: next due tick finishes and closes the row
    sh(wt, "reset", "-q", "--hard"); rmSync(join(wt, "b.ts"), { force: true });
    t += 3 * H;
    expect((await tick()).done.map((d) => d.agent)).toEqual(["agent-c"]);
    expect([existsSync(wt), pendingCleanups(db)]).toEqual([false, []]);
  });

  test("registry read failure: the pending row is not closed and the same error is not re-reported", async () => {
    const db = ledger();
    const { wt, root, deps: wd } = fixture();
    writeFileSync(join(wt, "u.txt"), "u");
    registerWorker(db, { agent: "agent-r", sessionId: "s1", taskId: "C1", role: "author", createdBy: "pm", now: 5 });
    recordWorkerRetire(db, "scheduler", { agent: "agent-r", sessionId: "s1", taskId: "C1", role: "author", rule: "card_finished", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: false });
    let t = NOW;
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const tick = () => runLifecycle(planLifecycle({ now: t, policy: on, agents: [], index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: new Set(),
      master: new Set(), swapPct: 10, pending: pendingCleanups(db) }), on, { manager: async () => ({ ok: true }), git, exists: existsSync, worktreeRoot: root,
      agents: async () => { throw new Error("registry 读不出来"); }, du: async () => 0, swapPct: async () => 0,
      record: async (r) => recordWorkerRetire(db, "scheduler", r), now: () => t, cleanupStatePath: wd.cleanupStatePath, cleanupArchiveRoot: wd.cleanupArchiveRoot });
    expect((await tick()).failed.map((f) => f.error)).toEqual(["registry 读不出来"]);
    t += 3 * H;
    expect((await tick()).failed).toEqual([]);
    expect([existsSync(join(wt, "u.txt")), pendingCleanups(db).length]).toEqual([true, 1]);
  });
});
