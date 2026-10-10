import { expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixTreePath, openFixWorktree, type FixTreeTarget } from "../src/lib/fix-strategy-worktree.js";
import { convergenceLifecycle, createConvergenceWorker } from "../src/lib/fix-strategy-lifecycle.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { bindFixReplacement, getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { git, type Git } from "../src/lib/scheduler-review-worktree.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { listSteps } from "../src/lib/ledger-steps.js";
import { currentOrders } from "../src/lib/order-take.js";
import { holdWriteLease, heldLease } from "../src/lib/ledger-lend-lease.js";
import { leaseLend, getLendOrder } from "../src/lib/ledger-lend.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { convergenceProbe, fourRoundFix, repeatedFix } from "./fix-strategy-helpers.js";
import { peerAuthor, remoteProbe, runningOrder } from "./fix-strategy-remote-helpers.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
setDefaultTimeout(60_000); // each case spawns dozens of real git processes on a temporary repository
const realGit: Git = (args) => git(args);

/** An origin, a project main tree on main, and the card branch pushed at `head` (the local branch optionally kept). */
function repo(keepLocal = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "convwt-"))), origin = join(root, "origin.git"), main = join(root, "main");
  mkdirSync(main); sh(root, "init", "-q", "--bare", origin);
  sh(main, "init", "-q", "-b", "main"); writeFileSync(join(main, "a.txt"), "base\n"); sh(main, "add", "a.txt"); sh(main, "commit", "-qm", "base");
  sh(main, "remote", "add", "origin", origin); sh(main, "push", "-q", "origin", "main");
  sh(main, "checkout", "-qb", "feat/T1");
  const heads = [1, 2, 3, 4].map((n) => { writeFileSync(join(main, "a.txt"), `fix ${n}\n`); sh(main, "commit", "-qam", `fix ${n}`); return sh(main, "rev-parse", "HEAD"); });
  const head = heads[3];
  sh(main, "push", "-q", "origin", "feat/T1"); sh(main, "checkout", "-q", "main");
  if (!keepLocal) sh(main, "branch", "-qD", "feat/T1");
  const wt = join(root, "worktrees");
  mkdirSync(wt);
  return { root, main, head, heads, wt, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** The main tree byte for byte: HEAD, index file and porcelain status. */
const snapshot = (main: string) => [sh(main, "rev-parse", "HEAD"), sh(main, "symbolic-ref", "HEAD"),
  createHash("sha1").update(readFileSync(join(main, ".git", "index"))).digest("hex"), sh(main, "status", "--porcelain=v2", "--branch", "--untracked-files=all")];
const target = (r: ReturnType<typeof repo>, head: string | null = r.head): FixTreeTarget => ({ taskId: "T1", branch: "feat/T1", head, root: r.wt });
const worktrees = (main: string) => sh(main, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

test("a main-tree source gets a new card-branch tree at the canonical root, pinned to the reviewed head; the main tree is untouched", async () => {
  for (const keepLocal of [false, true]) {
    const r = repo(keepLocal);
    try {
      const before = snapshot(r.main), dir = fixTreePath(r.wt, "T1")!;
      expect(await openFixWorktree(realGit, r.main, target(r), dir)).toEqual({ dir });
      expect(sh(dir, "symbolic-ref", "--short", "HEAD")).toBe("feat/T1");
      expect(sh(dir, "rev-parse", "HEAD")).toBe(r.head);
      expect(snapshot(r.main)).toEqual(before);
      // A retry of the same intent re-verifies its own clean tree and adds nothing.
      expect(await openFixWorktree(realGit, r.main, target(r), dir)).toEqual({ dir });
      expect(worktrees(r.main)).toBe(2);
    } finally { r.close(); }
  }
});

test("missing head, origin drift, local WIP branch, unreadable source and an occupied or dirty target all refuse without creating", async () => {
  const r = repo();
  try {
    const before = snapshot(r.main), dir = fixTreePath(r.wt, "T1")!;
    const refuse = async (t: FixTreeTarget, source = r.main) => {
      const out = await openFixWorktree(realGit, source, t, dir);
      expect(out).toHaveProperty("manual");
      return (out as { manual: string }).manual;
    };
    expect(await refuse(target(r, null))).toContain("head");
    expect(await refuse({ ...target(r), branch: null })).toContain("分支");
    expect(await refuse(target(r), join(r.root, "missing"))).toContain("不可读");
    expect(await refuse(target(r, "e".repeat(40)))).toContain("没有已审修复 head");
    const base = sh(r.main, "rev-parse", "main");
    sh(r.main, "update-ref", "refs/remotes/origin/feat/T1", base);
    expect(await refuse(target(r))).toContain("漂移");
    sh(r.main, "update-ref", "refs/remotes/origin/feat/T1", r.head);
    sh(r.main, "branch", "-q", "feat/T1", base);
    expect(await refuse(target(r))).toContain("旧 WIP");
    sh(r.main, "branch", "-qD", "feat/T1");
    mkdirSync(dir); writeFileSync(join(dir, "foreign.txt"), "someone else's\n");
    expect(await refuse(target(r))).toContain("已被占用");
    expect(readFileSync(join(dir, "foreign.txt"), "utf8")).toBe("someone else's\n");
    rmSync(dir, { recursive: true });
    // The main tree itself on the card branch: git refuses a second checkout, nothing is forced.
    sh(r.main, "checkout", "-qb", "feat/T1", r.head);
    const mainBefore = snapshot(r.main);
    expect(await refuse(target(r))).toContain("建作者工作树失败");
    expect(snapshot(r.main)).toEqual(mainBefore);
    sh(r.main, "checkout", "-q", "main"); sh(r.main, "branch", "-qD", "feat/T1");
    expect(existsSync(dir)).toBe(false); expect(worktrees(r.main)).toBe(1);
    expect([0, 1, 3].map((i) => snapshot(r.main)[i])).toEqual([0, 1, 3].map((i) => before[i]));
  } finally { r.close(); }
});

test("the old author's own clean linked tree at the canonical path is adopted; with WIP or off the head it is kept for PM", async () => {
  const r = repo(true);
  try {
    const dir = fixTreePath(r.wt, "T1")!;
    sh(r.main, "worktree", "add", "-q", dir, "feat/T1");
    expect(await openFixWorktree(realGit, dir, target(r), dir)).toEqual({ dir });
    writeFileSync(join(dir, "a.txt"), "old author WIP\n");
    expect(await openFixWorktree(realGit, dir, target(r), dir)).toHaveProperty("manual");
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("old author WIP\n");
    // The same tree seen from the main tree is a foreign occupant, never adopted through another source.
    sh(dir, "checkout", "-q", "--", "a.txt");
    expect(await openFixWorktree(realGit, r.main, target(r), dir)).toHaveProperty("manual");
  } finally { r.close(); }
});

test("the old author's tree with the scheduler's exact dependency links is adopted; any other link or ignored content is kept for PM", async () => {
  const r = repo(true);
  try {
    const dir = fixTreePath(r.wt, "T1")!;
    sh(r.main, "worktree", "add", "-q", dir, "feat/T1");
    mkdirSync(join(r.main, "node_modules")); mkdirSync(join(r.main, "web", "node_modules"), { recursive: true }); mkdirSync(join(dir, "web"));
    // Exactly what scheduler-local-author writes into a fresh author checkout.
    symlinkSync(join(r.main, "node_modules"), join(dir, "node_modules"));
    symlinkSync(join(r.main, "web", "node_modules"), join(dir, "web", "node_modules"));
    expect(await openFixWorktree(realGit, dir, target(r), dir)).toEqual({ dir });
    // A link to some other directory is not the scheduler's link.
    const elsewhere = join(r.root, "elsewhere", "node_modules");
    mkdirSync(elsewhere, { recursive: true });
    rmSync(join(dir, "node_modules")); symlinkSync(elsewhere, join(dir, "node_modules"));
    expect((await openFixWorktree(realGit, dir, target(r), dir) as { manual: string }).manual).toContain("node_modules");
    // A real dependency directory in place of the link is not exempt either.
    rmSync(join(dir, "node_modules")); mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x\n");
    expect((await openFixWorktree(realGit, dir, target(r), dir) as { manual: string }).manual).toContain("node_modules");
    expect(readFileSync(join(dir, "node_modules", "x.js"), "utf8")).toBe("x\n");
  } finally { r.close(); }
});

test("lease loss inside the tree port propagates and nothing is created", async () => {
  const r = repo();
  try {
    let n = 0;
    const lost: Git = async (args) => { if (++n === 3) throw new SchedulerStopped("lease-lost"); return git(args); };
    await expect(openFixWorktree(lost, r.main, target(r), fixTreePath(r.wt, "T1"))).rejects.toBeInstanceOf(SchedulerStopped);
    expect(existsSync(fixTreePath(r.wt, "T1")!)).toBe(false);
  } finally { r.close(); }
});

type Fixture = Awaited<ReturnType<typeof repeatedFix>>;
/** Point the card at the real repository: reviewed head, card branch, old author working in the project main tree. */
function realCard(f: Fixture, r: ReturnType<typeof repo>, oldCwd = r.main) {
  f.db.run("UPDATE tasks SET branch = 'feat/T1' WHERE id = 'T1'");
  const p = convergenceProbe(f), creates: { dir: string; tree: boolean; branch: string; head: string }[] = [];
  p.edit((x) => { x.agents["agent-task-one"].cwd = oldCwd; });
  p.deps.worktreeRoot = r.wt; p.deps.authorTree = convergenceLifecycle().authorTree;
  const manager = p.deps.manager;
  p.deps.manager = async (cmd, name, dir, ...args) => {
    if (cmd === "create") creates.push({ dir, tree: existsSync(join(dir, ".git")), branch: sh(dir, "symbolic-ref", "--short", "HEAD"), head: sh(dir, "rev-parse", "HEAD") });
    return manager(cmd, name, dir, ...args);
  };
  return { p, creates };
}

test("local swap from a main-tree author: tree before create, new fix step owned by the new session, old session can no longer take it", async () => {
  const r = repo(), f = await repeatedFix(r.heads.slice(2));
  try {
    const { p, creates } = realCard(f, r), before = snapshot(r.main), intent = p.plan(), dir = fixTreePath(r.wt, "T1")!;
    expect(listSteps(f.db, "T1").some((s) => s.step === "fix" && s.round === f.task().round)).toBe(false);
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(creates).toEqual([{ dir, tree: true, branch: "feat/T1", head: r.head }]);
    expect(snapshot(r.main)).toEqual(before);
    const author = getSchedulerSession(f.db, "T1", "author")!;
    expect(p.raw().agents[author.agent].cwd).toBe(dir);
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:worktree`)?.data).toMatchObject({ dir, head: r.head, branch: "feat/T1" });
    const step = listSteps(f.db, "T1").find((s) => s.step === "fix" && s.round === f.task().round)!;
    expect(step).toMatchObject({ executor: author.agent, executorKind: "agent", state: "assigned" });
    expect(listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.kind === "step" && e.data.op === "assign" && e.data.intentId === intent.id))
      .toHaveLength(1);
    const call = (agent: string, sessionId: string) => ({ agent, sessionId, family: "claude", channelId: "c" });
    expect(currentOrders(f.db, call(author.agent, author.sessionId)).map((o) => o.step)).toEqual(["fix"]);
    expect(currentOrders(f.db, call("agent-task-one", "s-one"))).toEqual([]);
    expect(currentOrders(f.db, call(author.agent, "s-one"))).toEqual([]);
    // Replaying the done intent writes no second tree, create or step.
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(creates).toHaveLength(1); expect(worktrees(r.main)).toBe(2);
    expect(listSteps(f.db, "T1").filter((s) => s.step === "fix" && s.round === f.task().round)).toHaveLength(1);
  } finally { f.close(); r.close(); }
});

test("an old author already in its own canonical linked tree keeps working: the tree is adopted, never the main tree", async () => {
  const r = repo(true), f = await repeatedFix(r.heads.slice(2));
  try {
    const dir = fixTreePath(r.wt, "T1")!;
    sh(r.main, "worktree", "add", "-q", dir, "feat/T1");
    mkdirSync(join(r.main, "node_modules")); symlinkSync(join(r.main, "node_modules"), join(dir, "node_modules")); // scheduler-local-author's link
    const { p, creates } = realCard(f, r, dir), intent = p.plan();
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(creates).toEqual([{ dir, tree: true, branch: "feat/T1", head: r.head }]);
  } finally { f.close(); r.close(); }
});

test("drift, a dirty occupant and an unreadable source wait with zero create, bind or step; no remote fallback", async () => {
  for (const breakIt of ["drift", "dirty", "source"] as const) {
    const r = repo(), f = await repeatedFix(r.heads.slice(2));
    try {
      const { p, creates } = realCard(f, r, breakIt === "source" ? join(r.root, "gone") : r.main), intent = p.plan(), dir = fixTreePath(r.wt, "T1")!;
      if (breakIt === "drift") sh(r.main, "update-ref", "refs/remotes/origin/feat/T1", sh(r.main, "rev-parse", "main"));
      if (breakIt === "dirty") { mkdirSync(dir); writeFileSync(join(dir, "x"), "x"); }
      if (breakIt === "source") mkdirSync(join(r.root, "gone"));
      await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
      for (let n = 0; n < 2; n++) expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
      expect(creates).toEqual([]); expect(p.effects.some((e) => e.startsWith("create:"))).toBe(false);
      expect(getSchedulerSession(f.db, "T1", "author")?.sessionId).toBe("s-one");
      expect(listSteps(f.db, "T1").some((s) => s.step === "fix" && s.round === f.task().round)).toBe(false);
      expect(f.db.query("SELECT COUNT(*) n FROM lend_orders").get()).toMatchObject({ n: 0 });
      expect(getIntent(f.db, intent.id)?.status).toBe("submitted");
    } finally { f.close(); r.close(); }
  }
});

test("held peer lease, a changed card and a non-auto card never reach the tree port", async () => {
  const f = await repeatedFix();
  try {
    const p = convergenceProbe(f), intent = p.plan(), ctx = f.at("scheduler");
    f.db.run("UPDATE scheduler_intents SET status = 'submitted' WHERE id = ?", [intent.id]);
    const run = () => createConvergenceWorker(f.db, ctx, getIntent(f.db, intent.id)!, f.task(), "claude", f.dir, "author", p.deps);
    holdWriteLease(f.db, f.task(), { peer: "Peer", fp: "abcd-bbbb-cccc-dddd", repo: "o/r", branch: "feat/T1" }, f.tickDeps.now());
    expect(heldLease(f.db, f.task())).not.toBeNull();
    expect(await run()).toMatchObject({ tree: true, wait: expect.stringContaining("租约") });
    f.db.run("DELETE FROM lend_write_leases");
    f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", ["9".repeat(40)]);
    expect(await run()).toMatchObject({ tree: true, wait: expect.stringContaining("已变化") });
    f.db.run("UPDATE tasks SET headSHA = ? WHERE id = 'T1'", [intent.head]);
    f.db.run("UPDATE task_workflows SET mode = 'observe' WHERE taskId = 'T1'");
    expect(await run()).toMatchObject({ tree: true, wait: expect.stringContaining("auto") });
    expect(p.trees).toEqual([]); expect(p.effects).toEqual([]);
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:worktree`)).toBeNull();
  } finally { f.close(); }
});

for (const stopped of [false, true]) {
  test(`peer author ${stopped ? "legally reclaimed: the new local family works in its own tree from the main-tree source" : "still running: no local tree or worker"}`, async () => {
    const r = repo(), f = await fourRoundFix(r.heads);
    try {
      const p = remoteProbe(f), intent = p.plan(), before = snapshot(r.main), dir = fixTreePath(r.wt, "T1")!;
      p.context.source = r.main; p.deps.worktreeRoot = r.wt; p.deps.authorTree = convergenceLifecycle().authorTree;
      peerAuthor(f, "claude"); runningOrder(f);
      if (!stopped) {
        expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting" });
        expect(heldLease(f.db, f.task())).not.toBeNull(); expect(existsSync(dir)).toBe(false);
        expect(p.effects.some((e) => e.startsWith("create:"))).toBe(false); expect(getSchedulerSession(f.db, "T1", "author")?.transport).toBe("peer");
        return;
      }
      leaseLend(f.db, f.at("lend"), "Peer", { v: 1, orderId: "old-running", gen: 1, action: "release", reason: "stopped", detail: "worker 已停" });
      expect(getLendOrder(f.db, "old-running")?.status).toBe("unknown");
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
      const author = getSchedulerSession(f.db, "T1", "author")!;
      expect(author.family).toBe("codex"); expect(p.raw().agents[author.agent].cwd).toBe(dir);
      expect(sh(dir, "symbolic-ref", "--short", "HEAD")).toBe("feat/T1");
      expect(sh(dir, "rev-parse", "HEAD")).toBe(r.head); expect(snapshot(r.main)).toEqual(before);
      expect(listSteps(f.db, "T1").find((s) => s.step === "fix" && s.round === f.task().round)).toMatchObject({ executor: author.agent });
      expect(getWorkflow(f.db, "T1")?.authorFamily).toBe("codex");
    } finally { f.close(); r.close(); }
  });
}

test("binding rolls back with its step when the session identity is refused; an existing round row is reassigned, earlier rounds kept", async () => {
  const f = await repeatedFix();
  try {
    const p = convergenceProbe(f), intent = p.plan(), ctx = f.at("scheduler"), round = f.task().round;
    await fixSwapStep(f.db, ctx, intent.id, p.deps);
    const now = Date.now();
    f.db.run(`INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, createdAt, updatedAt)
      VALUES ('T1', 'fix', ?, 'agent-task-one', 'agent', 'delivered', ?, ?), ('T1', 'fix', ?, 'agent-task-one', 'agent', 'assigned', ?, ?)`,
    [round - 1, now, now, round, now, now]);
    // The killed old session is not a fresh identity: the whole binding and its step write roll back.
    const stale = { taskId: "T1", role: "author" as const, agent: "agent-task-one", sessionId: "s-one", family: "claude" as const, transport: "tmux" as const };
    expect(() => bindFixReplacement(f.db, ctx, intent.id, stale, "m.md", p.deps.registryPath)).toThrow();
    expect(listSteps(f.db, "T1").find((s) => s.step === "fix" && s.round === round)).toMatchObject({ executor: "agent-task-one", rev: 1 });
    expect(getSchedulerSession(f.db, "T1", "author")?.sessionId).toBe("s-one");
    expect(await fixSwapStep(f.db, ctx, intent.id, p.deps)).toMatchObject({ step: "session" });
    const author = getSchedulerSession(f.db, "T1", "author")!, steps = listSteps(f.db, "T1").filter((s) => s.step === "fix");
    expect(steps.find((s) => s.round === round)).toMatchObject({ executor: author.agent, state: "assigned", rev: 2 });
    expect(steps.find((s) => s.round === round - 1)).toMatchObject({ executor: "agent-task-one", state: "delivered" });
    expect(f.db.query("SELECT state FROM scheduler_sessions WHERE sessionId = 's-one'").get()).toMatchObject({ state: "retired" });
    expect(p.trees).toEqual([{ source: f.dir, dir: join(f.dir, "t1"), branch: f.task().branch, head: intent.head }]);
  } finally { f.close(); }
});

test("the real origin moved while the cached tracking ref still shows the head: no tree; a late move refuses the built tree", async () => {
  const r = repo();
  try {
    const before = snapshot(r.main), dir = fixTreePath(r.wt, "T1")!, other = join(r.root, "other");
    sh(r.root, "clone", "-q", "-b", "feat/T1", join(r.root, "origin.git"), other);
    writeFileSync(join(other, "a.txt"), "pushed elsewhere\n"); sh(other, "commit", "-qam", "elsewhere"); sh(other, "push", "-q", "origin", "feat/T1");
    expect(sh(r.main, "rev-parse", "refs/remotes/origin/feat/T1")).toBe(r.head);
    const out = await openFixWorktree(realGit, r.main, target(r), dir);
    expect((out as { manual: string }).manual).toContain("实际远端分支");
    expect(existsSync(dir)).toBe(false); expect(worktrees(r.main)).toBe(1); expect(snapshot(r.main)).toEqual(before);
    // Origin still at the head when the tree is planned, moved by the time it would be handed out: refused, tree kept for PM.
    sh(other, "push", "-qf", "origin", `${r.head}:refs/heads/feat/T1`);
    let calls = 0;
    const late = async (cwd: string, branch: string) => ++calls === 1 ? { ok: true as const, head: r.head } : { ok: true as const, head: "f".repeat(40) };
    expect((await openFixWorktree(realGit, r.main, target(r), dir, late) as { manual: string }).manual).toContain("实际远端分支");
    expect(calls).toBe(2);
    const gone = async () => ({ ok: false as const, error: "offline" });
    expect((await openFixWorktree(realGit, r.main, target(r), dir, gone) as { manual: string }).manual).toContain("查不到实际远端");
  } finally { r.close(); }
});

test("a stop or lease loss at any tree check propagates, including the dirty check helpers that catch errors", async () => {
  const r = repo(true);
  try {
    const dir = fixTreePath(r.wt, "T1")!;
    expect(await openFixWorktree(realGit, r.main, target(r), dir)).toEqual({ dir }); // the intent's own tree, reused on retry
    for (const at of ["status", "ls-tree", "symbolic-ref"]) {
      const lost: Git = async (args) => { if (args.includes(at)) throw new SchedulerStopped("lease-lost"); return git(args); };
      await expect(openFixWorktree(lost, r.main, target(r), dir)).rejects.toBeInstanceOf(SchedulerStopped);
    }
    rmSync(dir, { recursive: true }); sh(r.main, "worktree", "prune");
    sh(r.main, "worktree", "add", "-q", dir, "feat/T1"); // the old author's own tree, adopted through retryWorktreeDirty
    const lost: Git = async (args) => { if (args.includes("status")) throw new SchedulerStopped("lease-lost"); return git(args); };
    await expect(openFixWorktree(lost, dir, target(r), dir)).rejects.toBeInstanceOf(SchedulerStopped);
  } finally { r.close(); }
});

test("a card or spec change while the tree is being built stops before create: no creating, no worker, no bind", async () => {
  for (const change of ["cas", "lease", "mode"] as const) {
    const f = await repeatedFix();
    try {
      const p = convergenceProbe(f), intent = p.plan(), ctx = f.at("scheduler"), tree = p.deps.authorTree!;
      f.db.run("UPDATE scheduler_intents SET status = 'submitted' WHERE id = ?", [intent.id]);
      p.deps.authorTree = async (...args) => {
        const out = await tree(...args);
        if (change === "cas") f.db.run("UPDATE tasks SET rev = rev + 1, specRev = specRev + 1 WHERE id = 'T1'");
        if (change === "lease") holdWriteLease(f.db, f.task(), { peer: "Peer", fp: "abcd-bbbb-cccc-dddd", repo: "o/r", branch: "feat/T1" }, f.tickDeps.now());
        if (change === "mode") f.db.run("UPDATE task_workflows SET mode = 'observe' WHERE taskId = 'T1'");
        return out;
      };
      const out = await createConvergenceWorker(f.db, ctx, getIntent(f.db, intent.id)!, f.task(), "claude", f.dir, "author", p.deps);
      expect(out).toMatchObject({ tree: true });
      expect(p.effects.filter((e) => !e.startsWith("tree:"))).toEqual([]);
      expect(getEventByDedup(f.db, `scheduler:${intent.id}:creating`)).toBeNull();
      expect(getSchedulerSession(f.db, "T1", "author")?.sessionId).toBe("s-one");
    } finally { f.close(); }
  }
});
