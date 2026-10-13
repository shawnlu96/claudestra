/**
 * SWAPWAIT1: a family-swap fix whose author tree cannot be built never sits silently in submitted. A tracking ref behind an
 * origin that really is at the delivered head is fast-forwarded and the swap goes on (journaled); origin drift goes to PM with
 * a reason event; a real wait (codex slots) stays a wait, journaled once per reason.
 */
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixTreePath } from "../src/lib/fix-strategy-worktree.js";
import { convergenceLifecycle } from "../src/lib/fix-strategy-lifecycle.js";
import { fixSwapStep } from "../src/lib/fix-strategy-runtime.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { getIntent } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { leaseLend } from "../src/lib/ledger-lend.js";
import { convergenceProbe, fourRoundFix } from "./fix-strategy-helpers.js";
import { peerAuthor, remoteProbe, runningOrder } from "./fix-strategy-remote-helpers.js";

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const sh = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
setDefaultTimeout(60_000);

/** An origin with the card branch pushed at its fourth fix head; the project main tree on main, without the local card branch. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "swapwait-"))), origin = join(root, "origin.git"), main = join(root, "main");
  mkdirSync(main); sh(root, "init", "-q", "--bare", origin);
  sh(main, "init", "-q", "-b", "main"); writeFileSync(join(main, "a.txt"), "base\n"); sh(main, "add", "a.txt"); sh(main, "commit", "-qm", "base");
  sh(main, "remote", "add", "origin", origin); sh(main, "push", "-q", "origin", "main");
  sh(main, "checkout", "-qb", "feat/T1");
  const heads = [1, 2, 3, 4].map((n) => { writeFileSync(join(main, "a.txt"), `fix ${n}\n`); sh(main, "commit", "-qam", `fix ${n}`); return sh(main, "rev-parse", "HEAD"); });
  sh(main, "push", "-q", "origin", "feat/T1"); sh(main, "checkout", "-q", "main"); sh(main, "branch", "-qD", "feat/T1");
  const wt = join(root, "worktrees"); mkdirSync(wt);
  return { root, main, origin, head: heads[3], heads, wt, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** The CONV2 path of the incident: peer author legally reclaimed, the new local family's tree opened through the real git port. */
async function reclaimedSwap(r: ReturnType<typeof repo>) {
  const f = await fourRoundFix(r.heads), p = remoteProbe(f), intent = p.plan();
  p.context.source = r.main; p.deps.worktreeRoot = r.wt; p.deps.authorTree = convergenceLifecycle().authorTree;
  peerAuthor(f, "claude"); runningOrder(f);
  leaseLend(f.db, f.at("lend"), "Peer", { v: 1, orderId: "old-running", gen: 1, action: "release", reason: "stopped", detail: "worker 已停" });
  return { f, p, intent };
}

const intentEvents = (f: Awaited<ReturnType<typeof fourRoundFix>>, id: string) =>
  listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.intentId === id);

test("red 1: a tracking ref behind an origin at the delivered head is fast-forwarded, the tree is built and the swap goes on, journaled", async () => {
  const r = repo();
  const { f, p, intent } = await reclaimedSwap(r);
  try {
    const stale = r.heads[1], dir = fixTreePath(r.wt, "T1")!;
    sh(r.main, "update-ref", "refs/remotes/origin/feat/T1", stale);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
    expect(sh(r.main, "rev-parse", "refs/remotes/origin/feat/T1")).toBe(r.head);
    expect(sh(dir, "rev-parse", "HEAD")).toBe(r.head);
    const author = getSchedulerSession(f.db, "T1", "author")!;
    expect(p.raw().agents[author.agent].cwd).toBe(dir);
    const refresh = intentEvents(f, intent.id).find((e) => String(e.dedupKey).includes(":ref-refresh:"));
    expect(refresh?.data).toMatchObject({ branch: "feat/T1", from: stale.slice(0, 12), to: r.head.slice(0, 12) });
    expect(getIntent(f.db, intent.id)?.status).toBe("done");
    // Only this branch's tracking ref was written: main's stays where it was.
    expect(sh(r.main, "rev-parse", "refs/remotes/origin/main")).toBe(sh(r.main, "rev-parse", "main"));
  } finally { f.close(); r.close(); }
});

test("red 2: origin drifted from the delivered head: a reason event with both heads, the intent goes to PM, no tree, no create", async () => {
  const r = repo();
  const { f, p, intent } = await reclaimedSwap(r);
  try {
    const other = join(r.root, "other"), dir = fixTreePath(r.wt, "T1")!;
    sh(r.root, "clone", "-q", "-b", "feat/T1", r.origin, other);
    writeFileSync(join(other, "a.txt"), "pushed elsewhere\n"); sh(other, "commit", "-qam", "elsewhere"); sh(other, "push", "-q", "origin", "feat/T1");
    const moved = sh(other, "rev-parse", "HEAD");
    sh(r.main, "update-ref", "refs/remotes/origin/feat/T1", r.heads[1]);
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "manual", detail: expect.stringContaining("漂移") });
    const refused = getEventByDedup(f.db, `scheduler:${intent.id}:tree-refused`);
    expect(String(refused?.data.reason)).toContain(r.head); expect(String(refused?.data.reason)).toContain(moved);
    expect(getIntent(f.db, intent.id)?.status).toBe("unknown");
    expect(getIntent(f.db, intent.id)?.receipt).toContain("交PM核对");
    expect(existsSync(dir)).toBe(false); expect(p.effects.some((e) => e.startsWith("create:"))).toBe(false);
    expect(sh(r.main, "rev-parse", "refs/remotes/origin/feat/T1")).toBe(r.heads[1]); // drift never moves the tracking ref
  } finally { f.close(); r.close(); }
});

test("keep: full codex slots still wait (no PM handoff), and the same wait reason is journaled once", async () => {
  const f = await fourRoundFix();
  try {
    const p = convergenceProbe(f);
    p.edit((r) => { for (let n = 0; n < 6; n++) r.agents[`agent-full-${n}`] = { runtime: "codex", status: "active", sessionId: `busy-${n}` }; });
    for (let n = 0; n < 6; n++) f.db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt)
      VALUES (?, 'p', 'busy', 'code', 'build', ?, 0, 0)`).run(`busy-${n}`, `agent-full-${n}`);
    const intent = p.plan();
    await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps);
    for (let pass = 0; pass < 3; pass++) {
      expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "waiting", detail: expect.stringContaining("Codex 全机会话已达 6") });
    }
    expect(getIntent(f.db, intent.id)?.status).toBe("submitted");
    expect(getEventByDedup(f.db, `scheduler:${intent.id}:tree-refused`)).toBeNull();
    const waits = intentEvents(f, intent.id).filter((e) => String(e.dedupKey).includes(":wait:"));
    expect(waits).toHaveLength(1);
    expect(String(waits[0].data.reason)).toContain("Codex 全机会话已达 6");
    p.edit((r) => { for (let n = 0; n < 6; n++) delete r.agents[`agent-full-${n}`]; });
    expect(await fixSwapStep(f.db, f.at("scheduler"), intent.id, p.deps)).toMatchObject({ step: "session" });
  } finally { f.close(); }
});
