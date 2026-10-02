/**
 * i28-S2c: reviewers' scratch folders (`.review-tmp/`, old name `.review-env/`) sit in the repository's shared exclude once a review
 * worktree is opened, so retirement's plain `git worktree remove` (no --force) deletes the checkout with them; any other untracked
 * file still keeps it for PM. Real git and a real ledger throughout.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { peerPrSpec } from "../src/lib/peer-pr-spec.js";
import { readLiveAgents, schedulerRetireTick, worktreeDirs, type RetireDeps } from "../src/lib/scheduler-retire.js";
import { ensureReviewExcludes, git, openReviewWorktree, REVIEW_EXCLUDES } from "../src/lib/scheduler-review-worktree.js";
import { retireIntentId } from "../src/lib/scheduler-sessions.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import type { Registry } from "../src/manager/core.js";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

const sh = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", "-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "i28s2c-")), author = join(dir, "author"), root = join(dir, "worktrees");
  mkdirSync(author); mkdirSync(root);
  sh(author, "init", "-q");
  writeFileSync(join(author, "a.ts"), "one\n");
  sh(author, "add", "a.ts");
  sh(author, "commit", "-q", "-m", "one");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const exclude = join(author, ".git", "info", "exclude");
  return { dir, author, root, head: sh(author, "rev-parse", "HEAD"), exclude, lines: () => readFileSync(exclude, "utf8").split("\n") };
}

/** Scratch files the way a reviewer leaves them: a nested HOME and TMPDIR with a cache in it. */
function scratch(checkout: string, name: string): void {
  for (const sub of ["home/.bun/install/cache", "tmp"]) mkdirSync(join(checkout, name, sub), { recursive: true });
  writeFileSync(join(checkout, name, "home/.bun/install/cache/pkg.tgz"), "x".repeat(4096));
  writeFileSync(join(checkout, name, "tmp/out.log"), "log");
}

describe("i28-S2c review worktree: scratch folders are excluded in the shared git dir", () => {
  test("opening adds both lines to the common exclude once; reopening and pinning never repeat them; other lines stay", async () => {
    const r = repo();
    writeFileSync(r.exclude, "# keep me\n*.local"); // no trailing newline: the append must not glue onto it
    const checkout = join(r.root, "rv-t1");
    expect(await openReviewWorktree(r.author, checkout, r.head)).toEqual({ dir: checkout });
    expect(r.lines()).toEqual(["# keep me", "*.local", "/.review-tmp/", "/.review-env/", ""]);
    expect(await openReviewWorktree(r.author, checkout, r.head)).toEqual({ dir: checkout }); // existing checkout: pin path
    expect(await openReviewWorktree(r.author, join(r.root, "rv-t2"), r.head)).toEqual({ dir: join(r.root, "rv-t2") });
    expect(await ensureReviewExcludes(checkout)).toBeNull();
    expect(r.lines()).toEqual(["# keep me", "*.local", "/.review-tmp/", "/.review-env/", ""]);
    expect(existsSync(join(checkout, ".git", "info"))).toBe(false); // the linked worktree's own .git is a file, never written to
  });

  test("only the missing line is appended; a repo with no exclude file gets one", async () => {
    const r = repo();
    writeFileSync(r.exclude, "/.review-env/\n");
    expect(await ensureReviewExcludes(r.author)).toBeNull();
    expect(r.lines()).toEqual(["/.review-env/", "/.review-tmp/", ""]);
    rmSync(join(r.author, ".git", "info"), { recursive: true });
    expect(await ensureReviewExcludes(r.author)).toBeNull();
    expect(r.lines()).toEqual([...REVIEW_EXCLUDES, ""]);
    expect(await ensureReviewExcludes(join(r.dir, "nowhere"))).toContain("读不出公共 git 目录");
  });

  test("real git: plain `worktree remove` deletes a checkout holding only .review-tmp/ or .review-env/; other untracked files still stop it", async () => {
    const r = repo();
    for (const [i, name] of [".review-tmp", ".review-env"].entries()) {
      const checkout = join(r.root, `rv-s${i}`);
      await openReviewWorktree(r.author, checkout, r.head);
      scratch(checkout, name);
      expect(sh(checkout, "status", "--porcelain")).toBe("");
      expect((await git(["-C", checkout, "worktree", "remove", checkout])).code).toBe(0);
      expect(existsSync(checkout)).toBe(false);
    }
    const kept = join(r.root, "rv-k");
    await openReviewWorktree(r.author, kept, r.head);
    scratch(kept, ".review-tmp");
    writeFileSync(join(kept, "notes.md"), "draft");
    expect(sh(kept, "status", "--porcelain")).toBe("?? notes.md");
    const rm = await git(["-C", kept, "worktree", "remove", kept]);
    expect(rm.code).not.toBe(0);
    expect(existsSync(join(kept, "notes.md"))).toBe(true);
  });

  test("retirement end to end: the reviewer's scratch no longer keeps its checkout; a stray file still goes to PM", async () => {
    const r = repo();
    const path = join(r.dir, "ledger.sqlite"), db = openLedger(path), registryPath = join(r.dir, "registry.json");
    cleanup.push(() => closeLedger(path));
    writeFileSync(registryPath, JSON.stringify({ socket: "", agents: {} })); // agents already gone: nothing to kill, checkouts free
    db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]') ON CONFLICT (project, key) DO UPDATE SET value = excluded.value").run();
    let now = 1000;
    const deps = (actor: string): LedgerDeps => ({ db, actor, registryPath, projectIds: ["p"], now: () => (now += 10),
      loadRegistry: async () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry, saveRegistry: async () => {} });
    const gitCalls: string[][] = [], notices: string[] = [];
    const retireDeps: RetireDeps = {
      ledger: async (...args) => runLedger(args.slice(1), deps("scheduler")),
      agent: async (...args) => (args[0] === "archive" ? { ok: true, archived: [] } : { ok: true, message: "已销毁。" }),
      git: async (args) => { gitCalls.push(args); return git(args); },
      exists: existsSync, worktreeRoot: r.root, notifyPm: async (_t, text) => { notices.push(text); },
      agents: () => readLiveAgents(registryPath, async () => []),
    };
    const card = async (id: string) => {
      createTask(db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code", agent: `agent-task-${id.toLowerCase()}` });
      db.query("UPDATE tasks SET stage = 'verified' WHERE id = ?").run(id);
      db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
        VALUES (?, ?, 'p', 'restate', 'ensure_session', 0, 1, 1, 2, 'done', 'test', 0, 0)`).run(`ens:${id}`, id);
      db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
        VALUES (?, 'reviewer', ?, ?, 'codex', 'acp', 'active', ?, 0, 0)`).run(id, `agent-rv-${id.toLowerCase()}`, `s-${id}`, `ens:${id}`);
      const rv = worktreeDirs(r.root, id)[1];
      expect(await openReviewWorktree(r.author, rv, r.head)).toEqual({ dir: rv });
      scratch(rv, ".review-tmp");
      scratch(rv, ".review-env");
      return rv;
    };
    const clean = await card("T1"), stray = await card("T2");
    writeFileSync(join(stray, "report.md"), "left by reviewer");
    const out = await schedulerRetireTick(db, ["p"], retireDeps);
    expect(out.failed).toEqual([]);
    expect(out.cards.map((c) => [c.taskId, c.step])).toEqual([["T1", "retired"], ["T2", "handoff"]]);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(join(stray, "report.md"))).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(`${stray}：有未提交改动：?? report.md`);
    expect(notices[0]).not.toContain(".review-");
    expect(getIntent(db, retireIntentId("T1"))?.status).toBe("done");
    expect(gitCalls.flat().some((a) => /^(--force|-f)$/.test(a))).toBe(false);
  });

  test("the peer PR review rules name the fixed scratch folder", () => {
    const spec = peerPrSpec({ number: 1, url: "u", login: "l", head: "h", base: "b", branch: "br", title: "t", body: "", surface: "plain", reasons: [] });
    expect(spec).toContain("`.review-tmp/home`、`.review-tmp/tmp`");
    expect(spec).not.toContain(".review-env");
  });
});
