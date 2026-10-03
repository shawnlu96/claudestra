/**
 * state-protection-F5: a lend-written card's head pushed to origin but missing from the shared object store of the local
 * reviewer checkout. Real git all the way (bare origin, the lender's own clone, the configured project clone, a linked
 * reviewer worktree) through the production autoTickDeps wiring; HOME / TMPDIR / git global config are temporary.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTask } from "../src/lib/ledger-store.js";
import { deliver } from "../src/lib/ledger-write.js";
import { statePath } from "../src/lib/paths.js";
import { autoTickDeps, type AutoDepsOpts } from "../src/lib/scheduler-auto-deps.js";
import type { SchedulerConfig } from "../src/lib/scheduler-config.js";
import { remoteHeadFamily } from "../src/lib/scheduler-head-family.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { git, gitHeadSync, openReviewWorktree } from "../src/lib/scheduler-review-worktree.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { autoFixture } from "./scheduler-auto-helpers.js";

const RV: SessionRef = { taskId: "T1", role: "reviewer", agent: "agent-rv-t1", sessionId: "s-rv", family: "codex", transport: "acp" };
const BRANCH = "lend/state-protection-F5-9109";
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "TMPDIR", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"];
let sandbox = "";

beforeAll(() => {
  const realState = join(homedir(), ".claude-orchestrator");
  if (statePath("x").startsWith(realState)) throw new Error(`测试落到了生产状态目录 ${realState}，拒绝继续`);
  sandbox = mkdtempSync(join(tmpdir(), "f5-home-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  mkdirSync(join(sandbox, "tmp"));
  writeFileSync(join(sandbox, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n[init]\n\tdefaultBranch = main\n");
  Object.assign(process.env, { HOME: sandbox, TMPDIR: join(sandbox, "tmp"), GIT_CONFIG_GLOBAL: join(sandbox, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(sandbox, { recursive: true, force: true });
});

async function must(...args: string[]): Promise<string> {
  const r = await git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  return r.out;
}

/** origin (bare) ← lender's clone pushes h1 on main, then h2 on the lend branch; the project clone only has h1. */
async function world() {
  const root = mkdtempSync(join(sandbox, "tmp", "f5-")), origin = join(root, "origin.git"), lender = join(root, "lender"), project = join(root, "project");
  await must("init", "-q", "--bare", origin);
  await must("clone", "-q", origin, lender);
  writeFileSync(join(lender, "a.ts"), "one\n");
  await must("-C", lender, "add", "a.ts");
  await must("-C", lender, "commit", "-q", "-m", "one");
  await must("-C", lender, "push", "-q", "origin", "HEAD:main");
  const h1 = await must("-C", lender, "rev-parse", "HEAD");
  await must("clone", "-q", origin, project);
  await must("-C", lender, "checkout", "-q", "-b", BRANCH);
  writeFileSync(join(lender, "a.ts"), "two\n");
  await must("-C", lender, "commit", "-q", "-am", "two");
  const h2 = await must("-C", lender, "rev-parse", "HEAD");
  await must("-C", lender, "push", "-q", "origin", BRANCH);
  const mark = join(root, "fetched");
  /** Test-only probe: every upload-pack origin serves the project clone touches `mark` first (and may stall). */
  const probe = (sleep = 0) => must("-C", project, "config", "remote.origin.uploadpack", `touch '${mark}'; ${sleep ? `sleep ${sleep}; ` : ""}git-upload-pack`);
  await probe();
  const blob = await must("-C", project, "rev-parse", `${h1}:a.ts`);
  return { root, origin, lender, project, h1, h2, blob, mark, probe, checkout: join(root, "worktrees", "rv-t1"),
    fetched: () => existsSync(mark), has: async (sha: string) => (await git(["-C", project, "cat-file", "-e", `${sha}^{commit}`])).code === 0 };
}

/** The card's newest delivery carries `head` and is the done write order of a Codex lender (remoteHeadFamily ≠ null). */
function lendWritten(f: ReturnType<typeof autoFixture>, head: string, card: { branch?: string | null; pr?: string | null } = {}) {
  deliver(f.db, { actor: "agent-task-one", now: f.tickDeps.now() + 1 }, { taskId: "T1", headSHA: head });
  const seq = (f.db.query("SELECT MAX(seq) AS s FROM events WHERE target = 'T1' AND kind = 'deliver'").get() as { s: number }).s;
  f.db.query("UPDATE tasks SET branch = ?, pr = ? WHERE id = 'T1'").run(card.branch === undefined ? BRANCH : card.branch, card.pr ?? null);
  f.db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs,
    eventSeq, createdBy, createdAt, updatedAt, branch) VALUES (?, 'T1', 'p', 'mate', 'codex', 'write', 1, 0, ?, 'o/r', '{}', 't', 's', 'done', 1, ?, 'pm', 1, 1, ?)`)
    .run(`lo-${seq}`, head, seq, BRANCH);
  expect(remoteHeadFamily(f.db, getTask(f.db, "T1")!)).toBe("codex");
  return getTask(f.db, "T1")!;
}

function setAgentCwd(registryPath: string, agent: string, cwd: string | null): void {
  const reg = JSON.parse(readFileSync(registryPath, "utf8"));
  if (cwd === null) delete reg.agents[agent];
  else reg.agents[agent].cwd = cwd;
  writeFileSync(registryPath, JSON.stringify(reg));
}

async function setup(opts: Partial<AutoDepsOpts> = {}) {
  const w = await world(), f = autoFixture();
  const cfg = (): SchedulerConfig => ({ projects: { p: { repoDir: w.project } } }) as unknown as SchedulerConfig;
  await openReviewWorktree(w.project, w.checkout, w.h1);
  setAgentCwd(f.registryPath, "agent-rv-t1", w.checkout);
  const deps = (o: Partial<AutoDepsOpts> = {}) => autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(w.root, "worktrees"), readConfig: cfg, ...opts, ...o });
  return { w, f, d: deps(), deps, close: () => { f.close(); rmSync(w.root, { recursive: true, force: true }); } };
}

describe("F5 reviewer checkout reused: the delivered head only exists on origin", () => {
  test("red→green: production pinReview fetches the lend branch and pins the exact head", async () => {
    const { w, f, d, close } = await setup();
    try {
      const remotes = await must("-C", w.project, "config", "--get-regexp", "^remote\\.");
      expect(await w.has(w.h2)).toBe(false);
      const task = lendWritten(f, w.h2);
      expect(await d.pinReview(task, RV, w.h2)).toEqual({ dir: w.checkout });
      expect(gitHeadSync(w.checkout)).toBe(w.h2);
      expect(readFileSync(join(w.checkout, "a.ts"), "utf8")).toBe("two\n");
      expect(w.fetched()).toBe(true);
      expect(await must("-C", w.project, "config", "--get-regexp", "^remote\\.")).toBe(remotes); // remote / refspec untouched
      expect(gitHeadSync(w.lender)).toBe(w.h2);
      expect(readFileSync(join(w.project, "a.ts"), "utf8")).toBe("one\n"); // the project clone's tree is not moved
    } finally { close(); }
  });

  test("head already local: the old fast path, no network", async () => {
    const { w, f, d, close } = await setup();
    try {
      await must("-C", w.checkout, "checkout", "-q", "--detach", w.h1);
      const task = lendWritten(f, w.h1);
      expect(await d.pinReview(task, RV, w.h1)).toEqual({ dir: w.checkout });
      expect(w.fetched()).toBe(false);
    } finally { close(); }
  });

  test("the lend branch moved on after delivery: the delivered head is pinned, not the branch tip", async () => {
    const { w, f, d, close } = await setup();
    try {
      writeFileSync(join(w.lender, "a.ts"), "three\n");
      await must("-C", w.lender, "commit", "-q", "-am", "three");
      await must("-C", w.lender, "push", "-q", "origin", BRANCH);
      expect(await d.pinReview(lendWritten(f, w.h2), RV, w.h2)).toEqual({ dir: w.checkout });
      expect(gitHeadSync(w.checkout)).toBe(w.h2);
    } finally { close(); }
  });

  test("the branch was rewritten without the head, or the dispatch head is not the card's: refuse, keep the checkout", async () => {
    const { w, f, d, close } = await setup();
    try {
      await must("-C", w.lender, "checkout", "-q", "--detach", w.h1);
      writeFileSync(join(w.lender, "a.ts"), "other\n");
      await must("-C", w.lender, "commit", "-q", "-am", "other");
      await must("-C", w.lender, "push", "-q", "-f", "origin", `HEAD:refs/heads/${BRANCH}`);
      const task = lendWritten(f, w.h2);
      expect(await d.pinReview(task, RV, w.h2)).toEqual({ manual: expect.stringContaining("取到了但不含该 commit") });
      expect(gitHeadSync(w.checkout)).toBe(w.h1);
      const stale = "e".repeat(40);
      expect(await d.pinReview(task, RV, stale)).toEqual({ manual: expect.stringContaining("不是卡上的交付 head") });
    } finally { close(); }
  });

  test("no usable source (no branch / PR, a non-lend branch) or not a commit: refuse without fetching", async () => {
    const { w, f, d, close } = await setup();
    try {
      let task = lendWritten(f, w.h2, { branch: null });
      expect(await d.pinReview(task, RV, w.h2)).toEqual({ manual: expect.stringContaining("没有可取的出借分支或 PR 号") });
      f.db.query("UPDATE tasks SET branch = 'feat/x', pr = 'https://example.invalid/pull/1' WHERE id = 'T1'").run();
      task = getTask(f.db, "T1")!;
      expect(await d.pinReview(task, RV, w.h2)).toEqual({ manual: expect.stringContaining("没有可取的出借分支或 PR 号") });
      expect(w.fetched()).toBe(false);
      task = lendWritten(f, w.blob);
      expect(await d.pinReview(task, RV, w.blob)).toEqual({ manual: expect.stringContaining("取不到") });
      expect(gitHeadSync(w.checkout)).toBe(w.h1);
    } finally { close(); }
  });

  test("a PR number is a source too: refs/pull/<n>/head from the same origin", async () => {
    const { w, f, d, close } = await setup();
    try {
      await must("-C", w.lender, "push", "-q", "origin", `${w.h2}:refs/pull/7/head`);
      await must("-C", w.lender, "push", "-q", "origin", "--delete", BRANCH);
      const task = lendWritten(f, w.h2, { pr: "7" });
      expect(await d.pinReview(task, RV, w.h2)).toEqual({ dir: w.checkout });
      expect(gitHeadSync(w.checkout)).toBe(w.h2);
    } finally { close(); }
  });

  test("tracked edits in the checkout refuse before any fetch; untracked evidence stays", async () => {
    const { w, f, d, close } = await setup();
    try {
      writeFileSync(join(w.checkout, "a.ts"), "patched\n");
      writeFileSync(join(w.checkout, "notes.md"), "evidence");
      expect(await d.pinReview(lendWritten(f, w.h2), RV, w.h2)).toEqual({ manual: expect.stringContaining("不取远端、不覆盖") });
      expect(w.fetched()).toBe(false);
      expect(await w.has(w.h2)).toBe(false);
      expect(readFileSync(join(w.checkout, "a.ts"), "utf8")).toBe("patched\n");
      expect(readFileSync(join(w.checkout, "notes.md"), "utf8")).toBe("evidence");
    } finally { close(); }
  });

  test("origin unreachable or stalled past the deadline: refuse, checkout and evidence unchanged", async () => {
    const { w, f, deps, close } = await setup();
    try {
      writeFileSync(join(w.checkout, "notes.md"), "evidence");
      const task = lendWritten(f, w.h2);
      await w.probe(30);
      const started = Date.now();
      expect(await deps({ netTimeoutMs: 1500 }).pinReview(task, RV, w.h2)).toEqual({ manual: expect.stringContaining("超时") });
      expect(Date.now() - started).toBeLessThan(10_000);
      await w.probe();
      renameSync(w.origin, `${w.origin}.gone`);
      expect(await deps().pinReview(task, RV, w.h2)).toEqual({ manual: expect.stringContaining("从项目仓库 origin 取不到") });
      expect(gitHeadSync(w.checkout)).toBe(w.h1);
      expect(readFileSync(join(w.checkout, "notes.md"), "utf8")).toBe("evidence");
    } finally { close(); }
  }, 15_000);

  test("a checkout outside the configured project repository is never fed from elsewhere", async () => {
    const { w, f, d, close } = await setup();
    try {
      const other = join(w.root, "other");
      await must("clone", "-q", w.origin, other);
      const cfgOther = (): SchedulerConfig => ({ projects: { p: { repoDir: other } } }) as unknown as SchedulerConfig;
      const task = lendWritten(f, w.h2);
      const dOther = autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(w.root, "worktrees"), readConfig: cfgOther });
      expect(await dOther.pinReview(task, RV, w.h2)).toEqual({ manual: expect.stringContaining("不共用对象库") });
      expect(gitHeadSync(w.checkout)).toBe(w.h1);
      expect(d).toBeDefined();
    } finally { close(); }
  });

  test("the lease lost as the fetch returns: no checkout, HEAD stays put", async () => {
    const { w, f, deps, close } = await setup();
    try {
      const task = lendWritten(f, w.h2);
      const d = deps({ active: () => { if (w.fetched()) throw new SchedulerStopped("maintenance lease lost"); } });
      await expect(d.pinReview(task, RV, w.h2)).rejects.toBeInstanceOf(SchedulerStopped);
      expect(w.fetched()).toBe(true);
      expect(gitHeadSync(w.checkout)).toBe(w.h1);
    } finally { close(); }
  });

  test("a card written here (no lend delivery) keeps the old behaviour: no fetch, refused as before", async () => {
    const { w, f, d, close } = await setup();
    try {
      expect(await d.pinReview(getTask(f.db, "T1")!, RV, w.h2)).toEqual({ manual: expect.stringContaining("切不到") });
      expect(w.fetched()).toBe(false);
    } finally { close(); }
  });
});

describe("F5 reviewer created for a lend-written card whose author directory lacks the head", () => {
  const created = (registryPath: string, checkout: string) => async (...args: string[]) => {
    if (args[0] !== "create") return { ok: false, error: "unexpected" };
    const reg = JSON.parse(readFileSync(registryPath, "utf8"));
    reg.agents["agent-rv-t1"] = { runtime: "claude-code", sessionId: "s-rv2", cwd: checkout };
    writeFileSync(registryPath, JSON.stringify(reg));
    return { ok: true };
  };

  test("first creation: the head is fetched into the project repository, then the worktree is added at it", async () => {
    const { w, f, deps, close } = await setup();
    try {
      await must("-C", w.project, "worktree", "remove", w.checkout);
      await f.tick(); // binds the author session
      setAgentCwd(f.registryPath, "agent-task-one", w.project);
      setAgentCwd(f.registryPath, "agent-rv-t1", null);
      const task = lendWritten(f, w.h2);
      const d = deps({ create: created(f.registryPath, w.checkout) });
      expect(await d.ensure(task, "reviewer", "claude")).toMatchObject({ kind: "ready", created: true });
      expect(gitHeadSync(w.checkout)).toBe(w.h2);
      expect(gitHeadSync(w.project)).toBe(w.h1);
    } finally { close(); }
  });

  test("an existing checkout reused on creation: fetched, then pinned", async () => {
    const { w, f, deps, close } = await setup();
    try {
      await f.tick();
      setAgentCwd(f.registryPath, "agent-task-one", w.project);
      setAgentCwd(f.registryPath, "agent-rv-t1", null);
      const task = lendWritten(f, w.h2);
      expect(await deps({ create: created(f.registryPath, w.checkout) }).ensure(task, "reviewer", "claude")).toMatchObject({ kind: "ready" });
      expect(gitHeadSync(w.checkout)).toBe(w.h2);
    } finally { close(); }
  });
});
