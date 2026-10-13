/**
 * SWAPWAIT2: the real shape of an advanced origin. The source repository has neither the delivered head's objects nor a
 * current tracking ref (another clone pushed it). Origin at the delivered head: this one branch is fetched once (fast-forward
 * only), the tree is built and the refresh is journaled. Origin elsewhere, a non-fast-forward, a failed fetch or a head still
 * missing after the fetch go to PM with that reason. Every repository here is a temporary one with a bare origin.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixTreePath, openFixWorktree, type FixTreeTarget } from "../src/lib/fix-strategy-worktree.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { git, type Git } from "../src/lib/scheduler-review-worktree.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { leaseLend } from "../src/lib/ledger-lend.js";
import { fourRoundFix } from "./fix-strategy-helpers.js";
import { peerAuthor, remoteProbe, runningOrder } from "./fix-strategy-remote-helpers.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
setDefaultTimeout(60_000);

/**
 * The source (project main tree, on main) pushed feat/T1 at its third fix head and knows nothing newer; another clone added
 * `ahead` commits and pushed them. heads[3] (the delivered head) exists on origin and in `other`, never in the source.
 */
function repo(ahead = 1) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "swapwait2-"))), origin = join(root, "origin.git"), main = join(root, "main"), other = join(root, "other");
  mkdirSync(main); sh(root, "init", "-q", "--bare", origin);
  sh(main, "init", "-q", "-b", "main"); writeFileSync(join(main, "a.txt"), "base\n"); sh(main, "add", "a.txt"); sh(main, "commit", "-qm", "base");
  sh(main, "remote", "add", "origin", origin); sh(main, "push", "-q", "origin", "main");
  sh(main, "checkout", "-qb", "feat/T1");
  const old = [1, 2, 3].map((n) => { writeFileSync(join(main, "a.txt"), `fix ${n}\n`); sh(main, "commit", "-qam", `fix ${n}`); return sh(main, "rev-parse", "HEAD"); });
  sh(main, "push", "-q", "-u", "origin", "feat/T1"); sh(main, "checkout", "-q", "main"); sh(main, "branch", "-qD", "feat/T1");
  sh(root, "clone", "-q", "-b", "feat/T1", origin, other);
  const pushed = Array.from({ length: ahead }, (_, n) => {
    writeFileSync(join(other, "a.txt"), `fix ${n + 4}\n`); sh(other, "commit", "-qam", `fix ${n + 4}`);
    return sh(other, "rev-parse", "HEAD");
  });
  sh(other, "push", "-q", "origin", "feat/T1");
  const wt = join(root, "worktrees"); mkdirSync(wt);
  return { root, main, origin, other, stale: old[2], head: pushed[0], tip: pushed[pushed.length - 1], heads: [...old, pushed[0]], wt,
    close: () => rmSync(root, { recursive: true, force: true }) };
}
type Repo = ReturnType<typeof repo>;

/** The real git port, counting fetches; `over` answers a call itself when it returns something. */
function counted(over: (args: string[]) => ReturnType<Git> | null = () => null) {
  const fetches: string[][] = [];
  const port: Git = (args) => { if (args.includes("fetch")) fetches.push(args); return over(args) ?? git(args); };
  return { port, fetches };
}

/** The CONV2 path: peer author legally reclaimed, the new local family's tree opened through `port` and the real ls-remote. */
async function reclaimedSwap(r: Repo, port: Git) {
  const f = await fourRoundFix(r.heads), p = remoteProbe(f), intent = p.plan();
  p.context.source = r.main; p.deps.worktreeRoot = r.wt;
  p.deps.authorTree = (source, target, recorded) => openFixWorktree(port, source, target, recorded);
  peerAuthor(f, "claude"); runningOrder(f);
  leaseLend(f.db, f.at("lend"), "Peer", { v: 1, orderId: "old-running", gen: 1, action: "release", reason: "stopped", detail: "worker 已停" });
  return { f, p, intent };
}

const target = (r: Repo, head: string = r.head): FixTreeTarget => ({ taskId: "T1", branch: "feat/T1", head, root: r.wt });
const tracking = (r: Repo) => sh(r.main, "rev-parse", "refs/remotes/origin/feat/T1");
const hasObject = (r: Repo, sha: string) => Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: r.main, env: ENV }).exitCode === 0;

test("red 1: the source lacks the delivered head another clone pushed: one fetch of this branch refreshes the tracking ref, the tree is built, the swap goes on, journaled", async () => {
  const r = repo(), g = counted();
  const { f, p, intent } = await reclaimedSwap(r, g.port);
  try {
    const dir = fixTreePath(r.wt, "T1")!;
    expect(hasObject(r, r.head)).toBe(false); expect(tracking(r)).toBe(r.stale);
    writeFileSync(join(r.main, "a.txt"), "uncommitted edit\n"); writeFileSync(join(r.main, "wip.txt"), "untracked\n");
    const mainRef = sh(r.main, "rev-parse", "refs/remotes/origin/main");
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(g.fetches).toHaveLength(1);
    expect(g.fetches[0].slice(-2)).toEqual(["origin", "refs/heads/feat/T1:refs/remotes/origin/feat/T1"]); // this branch only, no `+`
    expect(tracking(r)).toBe(r.head);
    expect(sh(dir, "rev-parse", "HEAD")).toBe(r.head); expect(sh(dir, "symbolic-ref", "--short", "HEAD")).toBe("feat/T1");
    const author = getSchedulerSession(f.db, "T1", "author")!;
    expect(p.raw().agents[author.agent].cwd).toBe(dir);
    const refresh = listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.intentId === intent.id && String(e.dedupKey).includes(":ref-refresh:"));
    expect(refresh).toHaveLength(1);
    expect(refresh[0].data).toMatchObject({ branch: "feat/T1", from: r.stale.slice(0, 12), to: r.head.slice(0, 12) });
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:tree-refused`)).toBeNull();
    expect(getIntent(f.db, intent.id)?.status).toBe("done");
    // The source's own checkout, its uncommitted edits and every other ref are where they were.
    expect(sh(r.main, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(readFileSync(join(r.main, "a.txt"), "utf8")).toBe("uncommitted edit\n"); expect(existsSync(join(r.main, "wip.txt"))).toBe(true);
    expect(sh(r.main, "rev-parse", "refs/remotes/origin/main")).toBe(mainRef);
    expect(p.effects.filter((e) => e.startsWith("create:"))).toHaveLength(1);
  } finally { f.close(); r.close(); }
});

test("keep: origin moved past the delivered head (drift) while the source lacks it: PM with both heads, no fetch, no tree, no create", async () => {
  const r = repo(2), g = counted();
  const { f, p, intent } = await reclaimedSwap(r, g.port);
  try {
    const dir = fixTreePath(r.wt, "T1")!;
    expect(r.tip).not.toBe(r.head);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "manual", detail: expect.stringContaining("漂移") });
    const reason = String(getEventByDedup(f.db, `scheduler:${intent.id}:tree-refused`)?.data.reason);
    expect(reason).toContain("没有已审修复 head"); expect(reason).toContain(r.head); expect(reason).toContain(r.tip);
    expect(g.fetches).toHaveLength(0);
    expect(tracking(r)).toBe(r.stale); expect(hasObject(r, r.head)).toBe(false);
    expect(getIntent(f.db, intent.id)?.status).toBe("unknown");
    expect(existsSync(dir)).toBe(false); expect(p.effects.some((e) => e.startsWith("create:"))).toBe(false);
  } finally { f.close(); r.close(); }
});

test("a missing delivered head whose fetch is not a fast-forward, fails, or still leaves no object is refused with that reason and no tree", async () => {
  const dirOf = (r: Repo) => fixTreePath(r.wt, "T1")!;
  const refusal = async (r: Repo, port: Git) => {
    const out = await openFixWorktree(port, r.main, target(r), dirOf(r));
    expect(existsSync(dirOf(r))).toBe(false);
    return "manual" in out ? out.manual : "";
  };
  // Not a fast-forward: the source's tracking ref sits on a commit origin does not contain; without `+` git refuses it.
  const a = repo(), ga = counted();
  try {
    sh(a.main, "checkout", "-q", "--detach", a.stale); writeFileSync(join(a.main, "a.txt"), "diverged\n"); sh(a.main, "commit", "-qam", "diverged");
    const diverged = sh(a.main, "rev-parse", "HEAD");
    sh(a.main, "checkout", "-q", "main"); sh(a.main, "update-ref", "refs/remotes/origin/feat/T1", diverged);
    const why = await refusal(a, ga.port);
    expect(why).toContain("没有已审修复 head"); expect(why).toContain("快进刷新"); expect(why).toContain("失败");
    expect(ga.fetches).toHaveLength(1); expect(tracking(a)).toBe(diverged);
  } finally { a.close(); }
  // The fetch itself fails.
  const b = repo(), gb = counted((args) => args.includes("fetch") ? Promise.resolve({ code: 128, out: "fatal: unable to access origin" }) : null);
  try {
    const why = await refusal(b, gb.port);
    expect(why).toContain("没有已审修复 head"); expect(why).toContain("失败"); expect(why).toContain("unable to access origin");
    expect(gb.fetches).toHaveLength(1); expect(tracking(b)).toBe(b.stale);
  } finally { b.close(); }
  // The fetch succeeded and the tracking ref is at the head, yet the source still cannot resolve the commit.
  const c = repo(), gc = counted((args) => args.some((x) => x.endsWith("^{commit}")) ? Promise.resolve({ code: 1, out: "" }) : null);
  try {
    const why = await refusal(c, gc.port);
    expect(why).toContain("仍没有已审修复 head");
    expect(gc.fetches).toHaveLength(1);
  } finally { c.close(); }
});
