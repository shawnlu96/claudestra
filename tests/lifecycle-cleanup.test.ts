/**
 * LIFE3 retired worktree cleanup on real temporary git worktrees: untracked-only checkouts are archived (bytes, file and directory
 * permission bits, symlink text, dotfiles, ignored files; only ignored regenerable directories excluded), verified, then removed;
 * tracked changes are kept and reported once per state across ticks / restarts with a persistent back-off; a failed archive, an
 * occupied or symlinked target, an outside / main checkout, a holder, an open write dispatch / lease and any read failure delete nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE, type LifecyclePolicy } from "../src/lib/agent-lifecycle-config.js";
import { archiveSurvey, archiveTarget } from "../src/lib/agent-lifecycle-cleanup-archive.js";
import { BACKOFF_BASE_MS, dueRetries, gatedCollect } from "../src/lib/agent-lifecycle-cleanup-gate.js";
import { reportRetireSteps } from "../src/lib/agent-lifecycle-cleanup-report.js";
import { surveyCheckout, type Survey } from "../src/lib/agent-lifecycle-cleanup-scan.js";
import { retireWorktree, type WorktreeCleanupDeps } from "../src/lib/agent-lifecycle-cleanup.js";
import { runLifecycle, type LifecycleDeps } from "../src/lib/agent-lifecycle-run.js";
import { cardWorkerIndex, pendingCleanups, recordWorkerRetire, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle, type Action } from "../src/lib/agent-lifecycle.js";
import { ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import type { LiveAgent } from "../src/lib/scheduler-retire.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { WORKER_CMDS } from "../src/manager/ledger-worker-cmds.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";

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
  const ledgerPath = join(dir, "ledger.sqlite"); openLedger(ledgerPath);
  cleanup.push(() => closeLedger(ledgerPath));
  const deps: WorktreeCleanupDeps = { git, cleanupLedgerPath: ledgerPath, worktreeRoot: root, now: () => NOW, cleanupArchiveRoot: archive, cleanupStatePath: join(dir, "cleanup.json") };
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
    expect(m.entries.map((e: { path: string }) => e.path).sort()).toEqual([".env", ".hidden", "dangling", "empty", "notes", "notes/deep", "notes/deep/wip.md",
      "rel-link", "run.log", "tool.sh"]);
    expect(steps.join()).toContain("可再生目录不归档（清单里列名）：node_modules");
  });

  test("an ignored ordinary file / symlink named like a regenerable dir is archived; only the real ignored directory is excluded", async () => {
    const { repo, wt, deps } = fixture();
    writeFileSync(join(repo, ".gitignore"), "build\ndist\ncoverage\nnode_modules\n"); sh(repo, "commit", "-qam", "ignore");
    sh(wt, "checkout", "-q", "--detach", "main");
    writeFileSync(join(wt, "build"), "irreplaceable evidence"); symlinkSync("/elsewhere", join(wt, "dist"));
    mkdirSync(join(wt, "coverage"), { recursive: true }); writeFileSync(join(wt, "coverage/lcov"), "regenerable");
    const steps: string[] = [];
    expect(await retireWorktree(deps, wt, owner, [], none, steps)).toBeNull();
    const dir = steps.join("\n").match(/→ ([^；\s]+)/)![1];
    expect([readFileSync(join(dir, "files/build"), "utf8"), readlinkSync(join(dir, "files/dist"))]).toEqual(["irreplaceable evidence", "/elsewhere"]);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect([m.excluded, m.entries.map((e: { path: string }) => e.path).sort()]).toEqual([["coverage"], ["build", "dist"]]);
    expect(m.excludedRule).toContain("真实目录");
  });

  test("only an excluded regenerable directory: still a manifest naming it before the worktree goes", async () => {
    const { wt, deps } = fixture();
    mkdirSync(join(wt, "node_modules/p"), { recursive: true }); writeFileSync(join(wt, "node_modules/p/i.js"), "x");
    const steps: string[] = [];
    expect(await retireWorktree(deps, wt, owner, [], none, steps)).toBeNull();
    const dir = steps.join("\n").match(/→ ([^；\s]+)/)![1];
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).toMatchObject({ entries: [], excluded: ["node_modules"] });
    expect(existsSync(wt)).toBe(false);
  });

  test("non-empty directory permission bits are archived and verified (0700 stays 0700)", async () => {
    const { wt, deps } = fixture();
    mkdirSync(join(wt, "private/inner"), { recursive: true }); writeFileSync(join(wt, "private/inner/note"), "secret");
    chmodSync(join(wt, "private/inner"), 0o750); chmodSync(join(wt, "private"), 0o700);
    const steps: string[] = [];
    expect(await retireWorktree(deps, wt, owner, [], none, steps)).toBeNull();
    const files = join(steps.join("\n").match(/→ ([^；\s]+)/)![1], "files");
    expect([lstatSync(join(files, "private")).mode & 0o7777, lstatSync(join(files, "private/inner")).mode & 0o7777]).toEqual([0o700, 0o750]);
    expect(readFileSync(join(files, "private/inner/note"), "utf8")).toBe("secret");
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
    // the same files but no manifest: not accepted as this attempt's archive either
    writeFileSync(join(target, "files", "u.txt"), "u");
    expect(await retireWorktree(deps, wt, owner, [], none, [])).toContain("manifest");
    expect(existsSync(join(wt, "u.txt"))).toBe(true);
  });

  test("a symlinked target (or ancestor) leading outside the archive root is never trusted or written through", async () => {
    const { dir, wt, archive, deps } = fixture();
    writeFileSync(join(wt, "u.txt"), "u");
    const survey = await surveyCheckout(git, realpathSync(wt)) as Survey;
    const o = { agent: "agent-x", sessionId: "sess-1", regAt: 7, checkout: wt };
    const target = archiveTarget(archive, o, survey)!, outside = join(dir, "outside");
    mkdirSync(join(outside, "files"), { recursive: true }); writeFileSync(join(outside, "files", "u.txt"), "u");
    mkdirSync(join(target, ".."), { recursive: true }); symlinkSync(outside, target);
    expect(await retireWorktree(deps, wt, owner, [], none, [])).toContain("软链");
    rmSync(target); mkdirSync(join(archive, "elsewhere"), { recursive: true });
    rmSync(join(archive, "agent-x"), { recursive: true }); symlinkSync(join(archive, "elsewhere"), join(archive, "agent-x"));
    expect("why" in await archiveSurvey(archive, o, survey, NOW)).toBe(true); // a symlinked agent folder is refused too
    expect(await retireWorktree(deps, wt, owner, [], none, [])).not.toBeNull();
    expect([existsSync(join(wt, "u.txt")), readdirSync(join(archive, "elsewhere"))]).toEqual([true, []]);
  });
});

describe("ledger: notify once, back off, survive restart", () => {
  function ledger() {
    const dir = mkdtempSync(join(tmpdir(), "life3-ledger-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
    cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
    createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "C1", title: "C1", kind: "code" });
    db.query("UPDATE tasks SET stage = 'verified' WHERE id = 'C1'").run();
    return { db, path };
  }

  test("tracked change: one worker_retire event and one failed report across ticks / restarts; a state change reports again; clean finishes", async () => {
    const { db, path } = ledger();
    const { wt, root, deps: wd } = fixture();
    writeFileSync(join(wt, "a.txt"), "changed\n");
    registerWorker(db, { agent: "agent-c", sessionId: "s1", taskId: "C1", role: "author", createdBy: "pm", now: 5 });
    recordWorkerRetire(db, "scheduler", { agent: "agent-c", sessionId: "s1", taskId: "C1", role: "author", rule: "card_finished", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: false });
    let t = NOW;
    const deps = (): LifecycleDeps => ({ manager: async () => ({ ok: true }), git, exists: existsSync, worktreeRoot: root, agents: none, du: async () => 0,
      swapPct: async () => 0, record: async (r) => recordWorkerRetire(db, "scheduler", r), now: () => t,
      cleanupLedgerPath: path, cleanupStatePath: wd.cleanupStatePath, cleanupArchiveRoot: wd.cleanupArchiveRoot }); // a fresh deps object = a restarted process
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

  test("tracked-summary production wire: complete long filename list survives CLI step and count caps", async () => {
    const { db, path } = ledger();
    const { wt, root, deps: wd } = fixture();
    const names = Array.from({ length: 25 }, (_, i) => `src/lib/agent-lifecycle-module-${String(i + 1).padStart(2, "0")}.ts`);
    mkdirSync(join(wt, "src/lib"), { recursive: true });
    for (const name of names) writeFileSync(join(wt, name), "base");
    sh(wt, "add", "."); sh(wt, "commit", "-qm", "tracked modules"); sh(wt, "branch", "saved-modules");
    for (const name of names) writeFileSync(join(wt, name), "modified");
    registerWorker(db, { agent: "agent-wire", sessionId: "s1", taskId: "C1", role: "author", createdBy: "pm", now: 5 });
    recordWorkerRetire(db, "scheduler", { agent: "agent-wire", sessionId: "s1", taskId: "C1", role: "author", rule: "card_finished", reason: "t",
      idleMs: 1, bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: false });
    let t = NOW;
    const cliDeps: LedgerDeps = { db, actor: "scheduler", projectIds: ["p"], now: () => t,
      loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} };
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const tick = () => runLifecycle(planLifecycle({ now: t, policy: on, agents: [], index: cardWorkerIndex(db), ...ledgerFacts(db),
      foreign: new Set(), master: new Set(), swapPct: 10, pending: pendingCleanups(db) }), on, {
      ...wd, worktreeRoot: root, agents: none, manager: async () => ({ ok: true }), exists: existsSync,
      du: async () => 0, swapPct: async () => 0, cleanupLedgerPath: path, now: () => t,
      record: async (r) => {
        await WORKER_CMDS["scheduler-worker-retire"].run(new LedgerCli(cliDeps, { pos: [], bools: new Set(), flags: { wire: JSON.stringify(r) } }));
      },
    });
    expect((await tick()).failed.length).toBe(1);
    const events = () => listEvents(db, { project: "p" }).filter((e) => (e.data as { retry?: boolean }).retry);
    const steps = (events()[0].data as { steps: string[] }).steps;
    const reference = steps.find((s) => s.includes("完整清单："));
    const visible = reference ? readFileSync(reference.split("完整清单：")[1], "utf8") : steps.join("\n");
    for (const name of names) expect(visible).toContain(name);
    expect(reference).toBeDefined();
    expect(reference!.length).toBeLessThanOrEqual(400);
    const reportPath = reference!.split("完整清单：")[1];
    const full = JSON.parse(readFileSync(reportPath, "utf8")) as { steps: string[] };
    expect(full.steps.join("\n")).toContain("已修改 25");
    for (const name of names) expect(full.steps.join("\n")).toContain(name);
    const original = readFileSync(reportPath, "utf8");
    t += 3 * H; expect((await tick()).failed.length).toBe(0); expect(events().length).toBe(1);
    writeFileSync(join(wt, names[24]), "base"); t += 3 * H;
    expect((await tick()).failed.length).toBe(1); expect(events().length).toBe(2);
    expect(readFileSync(reportPath, "utf8")).toBe(original);
    expect([existsSync(wt), pendingCleanups(db).length]).toEqual([true, 1]);
  });

  test("production wire count cap: a durable report retains all 30 steps, including the final filename", async () => {
    const { db, path } = ledger();
    const r = { ...owner, taskId: "C1", role: "author" as const, rule: "card_finished", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, now: NOW, pending: [], retry: false,
      steps: Array.from({ length: 30 }, (_, i) => `modified-file-${i}.ts`) };
    const reported = await reportRetireSteps(r, join(path, "..", "cleanup.json"));
    const cliDeps: LedgerDeps = { db, actor: "scheduler", projectIds: ["p"], now: () => NOW,
      loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {} };
    await WORKER_CMDS["scheduler-worker-retire"].run(new LedgerCli(cliDeps, { pos: [], bools: new Set(), flags: { wire: JSON.stringify(reported) } }));
    const event = listEvents(db, { project: "p" }).find((e) => (e.data as { op?: string }).op === "worker_retire")!;
    const stored = (event.data as { steps: string[] }).steps;
    expect(stored).toEqual(reported.steps);
    expect(JSON.parse(readFileSync(stored[0].split("完整清单：")[1], "utf8")).steps).toEqual(r.steps);
  });

  test("full report corruption / symlink / symlinked parent refuse to record or overwrite incomplete evidence", async () => {
    const { dir, deps } = fixture();
    const r = { ...owner, taskId: null, role: "author" as const, rule: "cleanup_retry", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, now: NOW, pending: [], retry: true, steps: ["x".repeat(401)] };
    const out = await reportRetireSteps(r, deps.cleanupStatePath!);
    const path = out.steps[0].split("完整清单：")[1];
    writeFileSync(path, "older evidence");
    await expect(reportRetireSteps(r, deps.cleanupStatePath!)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("older evidence");
    const outside = join(dir, "outside.json"); writeFileSync(outside, "outside evidence");
    unlinkSync(path); symlinkSync(outside, path);
    await expect(reportRetireSteps(r, deps.cleanupStatePath!)).rejects.toThrow("不跟软链");
    expect(readFileSync(outside, "utf8")).toBe("outside evidence");
    const outsideDir = join(dir, "outside-dir"), link = join(dir, "link"); mkdirSync(outsideDir); symlinkSync(outsideDir, link);
    await expect(reportRetireSteps(r, join(link, "cleanup.json"))).rejects.toThrow("父目录");
    expect(readdirSync(outsideDir)).toEqual([]);
  });

  test("registry read failure: the pending row is not closed and the same error is not re-reported", async () => {
    const { db, path } = ledger();
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
      record: async (r) => recordWorkerRetire(db, "scheduler", r), now: () => t, cleanupLedgerPath: path, cleanupStatePath: wd.cleanupStatePath, cleanupArchiveRoot: wd.cleanupArchiveRoot });
    expect((await tick()).failed.map((f) => f.error)).toEqual(["registry 读不出来"]);
    t += 3 * H;
    expect((await tick()).failed).toEqual([]);
    expect([existsSync(join(wt, "u.txt")), pendingCleanups(db).length]).toEqual([true, 1]);
  });

  test("open write dispatch (unknown effect) or a card write lease: nothing archived or removed, pending row kept, re-checked before moving", async () => {
    const { db, path } = ledger();
    const { wt, root, archive, deps: wd } = fixture();
    writeFileSync(join(wt, "u.txt"), "u");
    registerWorker(db, { agent: "agent-w", sessionId: "s1", taskId: "C1", role: "author", createdBy: "pm", now: 5 });
    recordWorkerRetire(db, "scheduler", { agent: "agent-w", sessionId: "s1", taskId: "C1", role: "author", rule: "card_finished", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: false });
    db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
      VALUES ('i1', 'C1', 'p', 'write', 'dispatch', 1, 1, 1, 1, 'unknown', 't', 1, 1)`).run();
    db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'src/**', 'C1', 'i1', 1, 'card')").run();
    const on: LifecyclePolicy = { ...DEFAULT_LIFECYCLE, mode: "on" };
    const tick = (now: number) => runLifecycle(planLifecycle({ now, policy: on, agents: [], index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: new Set(),
      master: new Set(), swapPct: 10, pending: pendingCleanups(db) }), on, { manager: async () => ({ ok: true }), git, exists: existsSync, worktreeRoot: root,
      agents: none, du: async () => 0, swapPct: async () => 0, record: async (r) => recordWorkerRetire(db, "scheduler", r), now: () => now,
      cleanupStatePath: wd.cleanupStatePath, cleanupArchiveRoot: archive, cleanupLedgerPath: path });
    expect((await tick(NOW)).failed.length).toBe(1);
    const steps = () => listEvents(db, { project: "p" }).filter((e) => (e.data as { retry?: boolean }).retry).map((e) => String((e.data as { steps: string[] }).steps));
    expect(steps()[0]).toContain("写派单 i1（write / unknown）");
    expect([existsSync(join(wt, "u.txt")), existsSync(archive), pendingCleanups(db).length]).toEqual([true, false, 1]);
    db.query("UPDATE scheduler_intents SET status = 'done' WHERE id = 'i1'").run(); // effect settled, lease still held
    expect((await tick(NOW + 3 * H)).failed.length).toBe(1);
    expect(steps().at(-1)).toContain("调度资源 src/**");
    expect([existsSync(join(wt, "u.txt")), pendingCleanups(db).length]).toEqual([true, 1]);
    db.query("DELETE FROM scheduler_resources").run();
    // a lease taken between the archive and the move: archived copy stays, nothing moved
    const o = { agent: "agent-w", sessionId: "s1", regAt: pendingCleanups(db)[0].createdAt, taskId: "C1", rule: "cleanup_retry" };
    const late = async () => { db.query("INSERT INTO scheduler_resources (project, resource, taskId, intentId, acquiredAt, scope) VALUES ('p', 'x', 'C1', 'i1', 1, 'card')").run(); return []; };
    expect(await retireWorktree({ ...wd, cleanupLedgerPath: path }, wt, o, [], late, [])).toContain("调度资源 x");
    expect([existsSync(join(wt, "u.txt")), existsSync(archive)]).toEqual([true, true]);
    db.query("DELETE FROM scheduler_resources").run();
    expect((await tick(NOW + 9 * H)).done.map((d) => d.agent)).toEqual(["agent-w"]);
    expect([existsSync(wt), pendingCleanups(db)]).toEqual([false, []]);
  });

  test("a retry whose pending row no longer matches (other createdAt / session) or an unreadable ledger touches nothing", async () => {
    const { db, path } = ledger();
    const { wt, deps } = fixture();
    writeFileSync(join(wt, "u.txt"), "u");
    registerWorker(db, { agent: "agent-v", sessionId: "s1", taskId: "C1", role: "author", createdBy: "pm", now: 5 });
    recordWorkerRetire(db, "scheduler", { agent: "agent-v", sessionId: "s1", taskId: "C1", role: "author", rule: "card_finished", reason: "t", idleMs: 1,
      bytesBefore: 1, bytesAfter: 1, steps: [], now: NOW, pending: [{ checkout: wt, tmp: null }], retry: false });
    const d = { ...deps, cleanupLedgerPath: path }, base = { agent: "agent-v", taskId: "C1", rule: "cleanup_retry" };
    expect(await retireWorktree(d, wt, { ...base, sessionId: "s1", regAt: 6 }, [], none, [])).toContain("核不上原登记");
    expect(await retireWorktree(d, wt, { ...base, sessionId: "s2", regAt: 5 }, [], none, [])).toContain("核不上原登记");
    const junk = join(deps.cleanupArchiveRoot!, "..", "junk.sqlite");
    writeFileSync(junk, "not a database");
    expect(await retireWorktree({ ...deps, cleanupLedgerPath: junk }, wt, { ...base, sessionId: "s1", regAt: 5 }, [], none, [])).toContain("台账读不了");
    expect([existsSync(join(wt, "u.txt")), existsSync(deps.cleanupArchiveRoot!)]).toEqual([true, false]);
  });
});

describe("r2 P1 regressions", () => {
  test("write-lease: missing ledger keeps original pending checkout and evidence", async () => {
    const { wt, dir, archive, deps } = fixture();
    writeFileSync(join(wt, "evidence"), "keep");
    expect(await retireWorktree({ ...deps, cleanupLedgerPath: join(dir, "missing.sqlite") }, wt,
      { ...owner, rule: "cleanup_retry" }, [], none, [])).toContain("台账读不了");
    expect(readFileSync(join(wt, "evidence"), "utf8")).toBe("keep");
    expect(existsSync(archive)).toBe(false);
  });

  test("archive-link: symlinked archive root never writes outside or removes originals", async () => {
    const { wt, dir, archive, deps } = fixture();
    writeFileSync(join(wt, "note"), "keep");
    const outside = join(dir, "outside"); mkdirSync(outside); symlinkSync(outside, archive);
    expect(await retireWorktree(deps, wt, owner, [], none, [])).toContain("软链");
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(wt, "note"), "utf8")).toBe("keep");
  });

  test("archive-link: replacing archive root after verification keeps the worktree", async () => {
    const { wt, dir, archive, deps } = fixture();
    writeFileSync(join(wt, "note"), "keep");
    const replace = async () => {
      renameSync(archive, join(dir, "original-archive")); mkdirSync(archive);
      return [];
    };
    expect(await retireWorktree(deps, wt, owner, [], replace, [])).toContain("归档根身份变了");
    expect(readFileSync(join(wt, "note"), "utf8")).toBe("keep");
    expect(readdirSync(archive)).toEqual([]);
  });

  test("retry-identity: same session with two createdAt debts independently backs off", async () => {
    const { dir, deps } = fixture();
    const dbPath = join(dir, "identity.sqlite"), db = openLedger(dbPath);
    cleanup.push(() => closeLedger(dbPath));
    createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "C2", title: "C2", kind: "code" });
    const actions: Action[] = [];
    for (const regAt of [10, 20]) {
      registerWorker(db, { agent: "agent-x", sessionId: "same", taskId: "C2", role: "author", createdBy: "pm", now: regAt });
      const pending = [{ checkout: join(dir, String(regAt)), tmp: null }];
      recordWorkerRetire(db, "scheduler", { ...owner, sessionId: "same", taskId: "C2", role: "author", rule: "card_finished", reason: "t",
        idleMs: null, bytesBefore: 0, bytesAfter: 0, steps: [], now: NOW, pending, retry: false });
      actions.push({ agent: "agent-x", sessionId: "same", regAt, taskId: null, role: "author", rule: "cleanup_retry",
        reason: "t", idleMs: null, entries: pending });
    }
    let records = 0;
    const d = { ...deps, record: async (_r: import("../src/lib/agent-lifecycle-store.js").RetireRecord) => { records++; } };
    for (let tick = 0; tick < 3; tick++) for (const a of await dueRetries(actions, d)) {
      await gatedCollect(a, d, async (a, wrapped) => {
        await wrapped.record({ ...owner, sessionId: a.sessionId!, regAt: a.regAt, taskId: null, role: "author", rule: a.rule, reason: "t",
          idleMs: null, bytesBefore: 0, bytesAfter: 0, steps: [], now: NOW, pending: a.entries!, retry: true });
        return { freed: 0, left: 1 };
      });
    }
    expect(records).toBe(2);
    expect(await dueRetries(actions, d)).toEqual([]);
    expect(pendingCleanups(db).map((p) => p.createdAt)).toEqual([10, 20]);
  });

  test("tracked-summary: changing ninth path preserves complete names and triggers another report", async () => {
    const { wt, deps } = fixture();
    for (let i = 1; i <= 10; i++) writeFileSync(join(wt, `${i}.txt`), "base");
    sh(wt, "add", "."); sh(wt, "commit", "-qm", "ten files"); sh(wt, "branch", "saved");
    for (let i = 1; i <= 9; i++) writeFileSync(join(wt, `${i}.txt`), "changed");
    let records = 0, t = NOW;
    const a: Action = { agent: owner.agent, sessionId: owner.sessionId, regAt: owner.regAt, taskId: null,
      role: "author", rule: "cleanup_retry", reason: "t", idleMs: null };
    const d = { ...deps, now: () => t, record: async (_r: import("../src/lib/agent-lifecycle-store.js").RetireRecord) => { records++; } };
    const collect = async (_a: Action, wrapped: typeof d) => {
      const why = await retireWorktree(wrapped, wt, owner, [], none, []);
      expect(why).toContain(t === NOW ? "9.txt" : "10.txt");
      await wrapped.record({ ...owner, taskId: null, role: "author", rule: a.rule, reason: "t", idleMs: null,
        bytesBefore: 0, bytesAfter: 0, steps: [`${wt}：${why}`], now: t, pending: [{ checkout: wt, tmp: null }], retry: true });
      return { freed: 0, left: 1 };
    };
    await gatedCollect(a, d, collect);
    writeFileSync(join(wt, "9.txt"), "base"); writeFileSync(join(wt, "10.txt"), "changed"); t += 3 * H;
    expect(await gatedCollect(a, d, collect)).not.toHaveProperty("quiet");
    expect(records).toBe(2);
    expect(existsSync(wt)).toBe(true);
  });
});

describe("back-off state", () => {
  const act = (agent: string): Action => ({ agent, taskId: "C1", role: "author", rule: "cleanup_retry", idleMs: null, reason: "t", sessionId: "s", regAt: 1 });
  test("a malformed slot (no nextAt) or a nextAt beyond the longest back-off never parks a debt for good", async () => {
    const dir = mkdtempSync(join(tmpdir(), "life3-gate-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, "cleanup.json");
    writeFileSync(p, JSON.stringify({ ["agent-a\0s\0" + "1"]: {}, ["agent-b\0s\0" + "1"]: { digest: "d", n: 1, nextAt: NOW + BACKOFF_BASE_MS, at: NOW } }));
    expect((await dueRetries([act("agent-a"), act("agent-b")], { cleanupStatePath: p, now: () => NOW })).map((a) => a.agent)).toEqual(["agent-a", "agent-b"]);
    expect(readdirSync(dir).some((f) => f.startsWith("cleanup.json.corrupt-"))).toBe(true);
    writeFileSync(p, JSON.stringify({
      ["agent-b\0s\0" + "1"]: { digest: "d", n: 1, nextAt: NOW + BACKOFF_BASE_MS, at: NOW },
      ["agent-c\0s\0" + "1"]: { digest: "d", n: 1, nextAt: NOW + 100 * H, at: NOW } }));
    expect((await dueRetries([act("agent-b"), act("agent-c")], { cleanupStatePath: p, now: () => NOW })).map((a) => a.agent)).toEqual(["agent-c"]);
  });
});
