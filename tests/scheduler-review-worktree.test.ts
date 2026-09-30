import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { getTask } from "../src/lib/ledger-store.js";
import { reviewWorktreeChecks } from "../src/lib/doctor-review-worktrees.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { git, gitDirtySync, gitHeadSync, openReviewWorktree, pinReviewWorktree, type Git } from "../src/lib/scheduler-review-worktree.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const RV: SessionRef = { taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", transport: "acp" };

/** Real git underneath; the lease is lost the moment `lostAfter` returns, before the scheduler sees its output. */
function losingLease(lostAfter: string) {
  const calls: string[] = [];
  let lost = false;
  const g: Git = async (args) => {
    const r = await git(args);
    calls.push(args[2]);
    if (args[2] === lostAfter) lost = true;
    return r;
  };
  return { calls, git: g, active: () => { if (lost) throw new SchedulerStopped("maintenance lease lost"); } };
}

function setAgentCwd(registryPath: string, agent: string, cwd: string | null): void {
  const reg = JSON.parse(readFileSync(registryPath, "utf8"));
  if (cwd === null) delete reg.agents[agent];
  else reg.agents[agent].cwd = cwd;
  writeFileSync(registryPath, JSON.stringify(reg));
}

async function repo() {
  const root = mkdtempSync(join(tmpdir(), "t68f-rvwt-")), author = join(root, "author");
  mkdirSync(author);
  const run = async (...args: string[]) => {
    const r = await git(["-C", author, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    if (r.code !== 0) throw new Error(r.out);
    return r.out;
  };
  await run("init", "-q");
  writeFileSync(join(author, "a.ts"), "one\n");
  await run("add", "a.ts");
  await run("commit", "-q", "-m", "one");
  const h1 = await run("rev-parse", "HEAD");
  writeFileSync(join(author, "a.ts"), "two\n");
  await run("commit", "-q", "-am", "two");
  const h2 = await run("rev-parse", "HEAD");
  return { root, author, h1, h2, checkout: join(root, "worktrees", "rv-t1"), close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("T68f reviewer checkout: its own detached worktree, pinned to the head under review", () => {
  test("created once from the author's repo, follows the reviewed head, never moves the author's tree", async () => {
    const r = await repo();
    try {
      expect(await openReviewWorktree(r.author, r.checkout, r.h1)).toEqual({ dir: r.checkout });
      expect(readFileSync(join(r.checkout, "a.ts"), "utf8")).toBe("one\n");
      expect(readFileSync(join(r.author, "a.ts"), "utf8")).toBe("two\n");
      expect(await openReviewWorktree(r.author, r.checkout, r.h2)).toEqual({ dir: r.checkout });
      expect(readFileSync(join(r.checkout, "a.ts"), "utf8")).toBe("two\n");
      writeFileSync(join(r.checkout, "scratch.txt"), "notes"); // untracked notes don't block a pin
      expect(await pinReviewWorktree(r.checkout, r.h1)).toEqual({ dir: r.checkout });
    } finally { r.close(); }
  });

  test("tracked edits by the reviewer, a non-repo author dir, an unknown head or no head all refuse instead of forcing", async () => {
    const r = await repo();
    try {
      await openReviewWorktree(r.author, r.checkout, r.h1);
      writeFileSync(join(r.checkout, "a.ts"), "patched by reviewer\n");
      expect(await pinReviewWorktree(r.checkout, r.h2)).toEqual({ manual: expect.stringContaining("已跟踪文件被改过") });
      expect(readFileSync(join(r.checkout, "a.ts"), "utf8")).toBe("patched by reviewer\n");
      const plain = join(r.root, "plain");
      mkdirSync(plain);
      expect(await openReviewWorktree(plain, join(r.root, "rv-x"), r.h1)).toEqual({ manual: expect.stringContaining("不是 git 仓库") });
      expect(await openReviewWorktree(r.author, join(r.root, "rv-y"), "f".repeat(40))).toEqual({ manual: expect.stringContaining("建审查 worktree 失败") });
      expect(await openReviewWorktree(r.author, join(r.root, "rv-z"), null)).toEqual({ manual: expect.stringContaining("没有交付 head") });
    } finally { r.close(); }
  });

  test("production deps only order a reviewer that lives in its own checkout", async () => {
    const r = await repo();
    const f = autoFixture();
    try {
      const d = autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(r.root, "worktrees") });
      const task = getTask(f.db, "T1")!;
      const ref: SessionRef = { taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", transport: "acp" };
      const setCwd = (cwd: string) => {
        const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
        reg.agents["agent-rv-t1"].cwd = cwd;
        writeFileSync(f.registryPath, JSON.stringify(reg));
      };
      setCwd(r.author);
      expect(await d.pinReview(task, ref, r.h1)).toEqual({ manual: expect.stringContaining("不是它独立的审查 worktree") });
      await openReviewWorktree(r.author, r.checkout, r.h1);
      setCwd(r.checkout);
      expect(await d.pinReview(task, ref, r.h2)).toEqual({ dir: r.checkout });
      expect((await git(["-C", r.checkout, "rev-parse", "HEAD"])).out).toBe(r.h2);
    } finally { f.close(); r.close(); }
  });

  test("an edit after the pin keeps HEAD but shows as dirty (working tree or index), to the writer and to the tick", async () => {
    const r = await repo();
    const f = autoFixture();
    try {
      await openReviewWorktree(r.author, r.checkout, r.h1);
      const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
      reg.agents["agent-rv-t1"].cwd = r.checkout;
      writeFileSync(f.registryPath, JSON.stringify(reg));
      const d = autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(r.root, "worktrees") });
      const ref: SessionRef = { taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", transport: "acp" };
      writeFileSync(join(r.checkout, "notes.md"), "untracked report draft");
      expect(gitDirtySync(r.checkout)).toBeNull();
      expect(await d.reviewDirty(getTask(f.db, "T1")!, ref)).toBeNull();
      writeFileSync(join(r.checkout, "a.ts"), "checked=false\n");
      expect(gitHeadSync(r.checkout)).toBe(r.h1);
      expect(gitDirtySync(r.checkout)).toBe("M a.ts");
      expect(await d.reviewDirty(getTask(f.db, "T1")!, ref)).toBe("M a.ts");
      await git(["-C", r.checkout, "add", "a.ts"]);
      expect(gitDirtySync(r.checkout)).toBe("M  a.ts");
      expect(gitDirtySync(join(r.root, "missing"))).toContain("读不了工作区状态");
    } finally { f.close(); r.close(); }
  });

  test("doctor counts reviewer checkouts and flags the ones whose reviewer is gone", () => {
    expect(reviewWorktreeChecks(["other"], new Set(), "/w")).toEqual([]);
    expect(reviewWorktreeChecks(["rv-t1"], new Set(["agent-rv-t1"]), "/w")).toEqual([
      { group: "调度引擎", name: "审查 worktree", status: "ok", detail: "1 个审查 worktree，审查员都还在" }]);
    const [c] = reviewWorktreeChecks(["rv-t1", "rv-t2"], new Set(["agent-rv-t1"]), "/w");
    expect(c).toMatchObject({ status: "warn", detail: "2 个审查 worktree，其中 1 个的审查员已不在：rv-t2" });
    expect(c.fix).toContain("git -C /w/rv-t2 worktree remove /w/rv-t2");
  });

  // T68f r4 P1-2: the liveness check sits on each git subprocess, not around the whole pin / create
  test("the lease lost as the pin's status returns: no checkout runs, the reviewer's HEAD stays put", async () => {
    const r = await repo();
    const f = autoFixture();
    try {
      await openReviewWorktree(r.author, r.checkout, r.h1);
      setAgentCwd(f.registryPath, "agent-rv-t1", r.checkout);
      const lease = losingLease("status");
      const d = autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(r.root, "worktrees"), ...lease });
      await expect(d.pinReview(getTask(f.db, "T1")!, RV, r.h2)).rejects.toBeInstanceOf(SchedulerStopped);
      expect(lease.calls).toEqual(["status"]);
      expect(gitHeadSync(r.checkout)).toBe(r.h1);
    } finally { f.close(); r.close(); }
  });

  test("the lease lost as creating the reviewer's rev-parse returns: no worktree add, no checkout on disk, no manager create", async () => {
    const r = await repo();
    const f = autoFixture();
    try {
      await f.tick(); // binds the author session
      setAgentCwd(f.registryPath, "agent-task-one", r.author);
      setAgentCwd(f.registryPath, "agent-rv-t1", null);
      const lease = losingLease("rev-parse");
      const d = autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(r.root, "worktrees"), ...lease });
      await expect(d.ensure({ ...getTask(f.db, "T1")!, headSHA: r.h1 }, "reviewer", "codex")).rejects.toBeInstanceOf(SchedulerStopped);
      expect(lease.calls).toEqual(["rev-parse"]);
      expect(existsSync(r.checkout)).toBe(false);
      expect((await git(["-C", r.author, "worktree", "list"])).out.split("\n")).toHaveLength(1);
    } finally { f.close(); r.close(); }
  });
});
