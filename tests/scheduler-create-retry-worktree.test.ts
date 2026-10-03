/**
 * i28-SC1f1: the backoff retry after a clean create failure really creates again, instead of being held by the worktree
 * the failed try prepared. Real ensureLocalAuthor / createReviewer + retryCleanCreate over real git; only `manager create` is fake.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unknownQuota } from "../src/lib/ai-quota.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runStart, type StepIO } from "../src/lib/dag-tools-steps.js";
import { claimNode, settleClaim } from "../src/lib/ledger-autostart.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { readRegistryAgentsSync } from "../src/lib/registry.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { readSchedulerConfig, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { createRetryDelay, retryCleanCreate } from "../src/lib/scheduler-create-retry.js";
import { ensureLocalAuthor, type LocalAuthorEnv } from "../src/lib/scheduler-local-author.js";
import { writeLocalAuthor } from "../src/lib/scheduler-local-author-write.js";
import { clearQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { runLedger } from "../src/manager/ledger.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

const CAPACITY = { ok: false, cleanedUp: true, error: "Selected model is at capacity. Please try a different model.\n（已清理：窗口已关；频道已删；占位已删）" };
const cleanups: (() => void)[] = [];
afterEach(() => { clearQueuedLocalStarts(); for (const close of cleanups.splice(0)) close(); });

async function gitRepo(dir: string): Promise<{ repo: string; run: (cwd: string, ...args: string[]) => Promise<string> }> {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const run = async (cwd: string, ...args: string[]) => {
    const r = await git(["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    if (r.code !== 0) throw new Error(r.out);
    return r.out;
  };
  await run(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "one\n");
  mkdirSync(join(repo, "web"));
  writeFileSync(join(repo, "web", "a.ts"), "web\n");
  await run(repo, "add", ".");
  await run(repo, "commit", "-q", "-m", "one");
  await run(repo, "remote", "add", "origin", repo);
  await run(repo, "fetch", "-q", "origin");
  mkdirSync(join(repo, "node_modules")); // checkout links it into the worktree, untracked there: not "a change"
  mkdirSync(join(repo, "web", "node_modules"));
  return { repo, run };
}

/** The scheduler-local-author.test.ts shape (peer cools down → local author), over a real git repo and a fake `manager create`. */
async function authorFixture(fails: number) {
  const dir = mkdtempSync(join(tmpdir(), "sc1f1-")), dbPath = join(dir, "ledger.sqlite"), db = openLedger(dbPath);
  cleanups.push(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });
  const { repo, run } = await gitRepo(dir);
  const ledgerDir = join(dir, "ledger"), worktreeRoot = join(dir, "wt");
  mkdirSync(join(ledgerDir, "docs", "tasks"), { recursive: true });
  writeFileSync(join(ledgerDir, "docs", "tasks", "ap-a.md"), "# specification\n模板:code\n");
  const registryPath = join(dir, "registry.json"), configPath = join(dir, "scheduler.json"), projectsPath = join(dir, "projects.json");
  const agents: Record<string, object> = {};
  const saveRegistry = () => writeFileSync(registryPath, JSON.stringify({ agents })); saveRegistry();
  const remote: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: "o/r", poolTimeoutMin: 15 };
  writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: repo, localAuthorRuntime: "codex", remote } } }));
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [repo] }] }));
  const options = { registryPath, configPath, projectsPath, lockPath: join(dir, "codex.lock"), codexQuota: async () => unknownQuota("test") };
  let now = 10_000;
  const ctx = { actor: "owner", now };
  db.run("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, ctx, { project: "p", slug: "ap", title: "AP" });
  initDag(db, ctx, { id: "ab12-ap", rev: 1, nodes: [{ key: "a", oneLine: "author", fileGlobs: ["src/a.ts"] }] });
  const borrow: BorrowEntry[] = [{ peer: "Sekai", projects: ["p"], roles: ["write", "review"], priority: "first", maxOpen: 10 }];
  const hello = (paused: boolean) => recordHello(db, "Sekai", null, { v: 1, proto: 2, boot: "b", seq: paused ? 2 : 1,
    paused: paused ? { reason: "codex_quota", until: now + 3_600_000 } : null,
    slots: { codex: { total: 10, busy: 0 }, claude: { total: 0, busy: 0 } },
    grant: { until: now + 3_600_000, roles: ["write", "review"], repos: ["o/r"], ordersPerDay: 20, ordersLeftToday: 20 } }, now);
  hello(false);
  const cli = (actor: string, args: string[]) => runLedger(args, { db, actor, registryPath, projectIds: ["p"], now: () => ++now,
    autoProjects: () => ["p"], autoDispatch: () => true, loadRegistry: async () => ({ agents }) as never, saveRegistry: async () => {} });
  const pre = await preflightStart({ db, caller: "pm", ledgerDir, worktreeRoot, projectDirs: async () => [repo], agentNames: () => [],
    exists: existsSync, branchExists: async () => false, autoReady: () => null, template: () => null,
    placement: (db, q) => startPlacement(db, { policy: () => ({ remote, maxWorkers: 2 }), borrow: async () => borrow, originRepo: async () => "o/r", now: () => now }, q),
  }, { featureId: "ab12-ap", key: "a" });
  if (!pre.ok || "already" in pre) throw new Error(JSON.stringify(pre));
  const claim = claimNode(db, { actor: "scheduler", now }, { featureId: "ab12-ap", key: "a", arm: "a".repeat(16), template: "code",
    peer: pre.plan.peer, svc: { autoDispatch: true, projects: ["p"], maxWorkers: () => 2, now: () => now, pool: () => ({ remote, borrow }) } }).claim!;
  const io: StepIO = { db: () => db, attempt: "open", manager: async (args) => cli("scheduler", ["scheduler-autostart", "step", String(claim.seq), ...args.slice(1)]),
    git: async () => { throw new Error("peer opening must not use git"); }, exists: existsSync, read: () => null,
    write: () => {}, remove: () => {}, symlink: () => {}, agentExists: () => false };
  expect(await runStart(io, pre.plan)).toMatchObject({ ok: true });
  settleClaim(db, { actor: "scheduler", now }, { claim: claim.seq, outcome: "done" });
  db.query("UPDATE tasks SET spec = ? WHERE id = 'ap-a'").run(pre.plan.specPath);
  const creates: string[][] = [], notices: string[] = [];
  const env: LocalAuthorEnv = { db, registryPath, worktreeRoot, registryRow: (name) => readRegistryAgentsSync(registryPath).find((r) => r.name === name),
    active: () => {}, git,
    create: async (...args) => {
      creates.push(args);
      if (creates.length <= fails) return CAPACITY; // manager create cleaned window, channel and placeholder itself
      agents[`agent-${args[1]}`] = { cwd: args[2], projectId: "p", task: "ap-a", sessionId: "s-author", runtime: "codex", transport: "acp", status: "active" };
      saveRegistry(); return { ok: true };
    },
    ledger: async (...args) => {
      if (args[1] === "scheduler-autostart" && args[4].startsWith("local-author")) {
        const flags = Object.fromEntries(args.slice(7).map((x) => { const i = x.indexOf("="); return [x.slice(2, i), x.slice(i + 1)]; }));
        return db.transaction(() => writeLocalAuthor(db, { actor: "scheduler", now: ++now, dedupKey: flags.dedup },
          { claim: Number(args[3]), sub: args[4], pos: args.slice(5, 7), flags }, options)).immediate();
      }
      return cli("scheduler", args.slice(1));
    } };
  const normal = autoTickDeps(db, { registryPath, worktreeRoot });
  const deps: AutoTickDeps = { ...normal, manager: env.ledger, borrow: async () => borrow, now: () => ++now,
    // Production wiring (scheduler-auto-deps.ts ensure): the local author runs inside retryCleanCreate.
    ensure: (task, role, family) => task.agent ? normal.ensure(task, role, family)
      : retryCleanCreate(env, task, "author", (create) => ensureLocalAuthor({ ...env, create }, task, options), () => now),
    notifyPm: async (_task, text) => { notices.push(text); } };
  const tick = async () => {
    const r = await schedulerAutoTick(db, readSchedulerConfig(configPath).projects, deps);
    expect(r.failed).toEqual([]); return r.cards[0];
  };
  const ensureIntents = () => db.query("SELECT status, receipt FROM scheduler_intents WHERE action = 'ensure_session' ORDER BY eventSeq")
    .all() as { status: string; receipt: string | null }[];
  return { tick, hello, creates, notices, ensureIntents, run, repo, worktree: join(worktreeRoot, "ap-a"), branch: pre.plan.branch,
    setHead: (head: string) => db.query("UPDATE tasks SET headSHA = ? WHERE id = 'ap-a'").run(head),
    task: () => getTask(db, "ap-a")!, advance: (ms: number) => { now += ms; } };
}

/** Fail once clean, then let the 2-minute backoff run out. */
async function failOnceAndWait(f: Awaited<ReturnType<typeof authorFixture>>) {
  f.hello(true);
  expect((await f.tick()).step).toBe("stage");
  expect((await f.tick()).step).toBe("waiting");
  expect(f.creates).toHaveLength(1);
  expect(f.ensureIntents().at(-1)).toMatchObject({ status: "cancelled", receipt: expect.stringContaining("第 1 次") });
  expect(existsSync(f.worktree)).toBe(true); // the failed try prepared its worktree and left it
  f.advance(createRetryDelay(1));
}


async function reviewerFixture() {
  const f = autoFixture();
  const root = mkdtempSync(join(tmpdir(), "sc1f1-rv-"));
  cleanups.push(() => { f.close(); rmSync(root, { recursive: true, force: true }); });
  const { repo, run } = await gitRepo(root);
  const head = await run(repo, "rev-parse", "HEAD");
  await toBuild(f);
  await f.tick(); // author receives build order
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", head)).ok).toBe(true);
  f.db.query("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'").run();
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-task-one"].cwd = repo;
  delete reg.agents["agent-rv-t1"];
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const creates: string[][] = [];
  const d = autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(root, "wt"), create: async (...args) => {
    creates.push(args);
    if (creates.length === 1) return CAPACITY;
    const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
    r.agents[args[1]] = { runtime: "claude-code", sessionId: "s-rv2", cwd: args[2] };
    writeFileSync(f.registryPath, JSON.stringify(r));
    return { ok: true };
  } });
  f.tickDeps.ensure = d.ensure;
  expect((await f.tick()).step).toBe("waiting");
  expect(creates).toHaveLength(1);
  expect(f.intents().at(-1)).toMatchObject({ node: "adversarial_review", status: "cancelled" });
  expect((await f.tick()).detail).toContain("连续 1 次失败");
  f.advance(createRetryDelay(1) - 1_000);
  await f.tick();
  expect(creates).toHaveLength(1);
  f.advance(1_000);
  return { f, d, creates, repo, run, checkout: join(root, "wt", "rv-t1") };
}

describe("i28-SC1f1 the backoff retry is not held by the failed try's own worktree", () => {
  test("[验收线 1] real ensureLocalAuthor + retryCleanCreate: fail clean, then after the backoff create runs again and the card gets its author", async () => {
    const f = await authorFixture(1);
    await failOnceAndWait(f);
    expect(lstatSync(join(f.worktree, "node_modules")).isSymbolicLink()).toBe(true);
    expect((await f.tick()).step).toBe("session");
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1][2]).toBe(f.worktree);
    expect(f.task().agent).toBe("agent-task-ap-a");
    expect(f.ensureIntents().map((r) => r.status)).toEqual(["cancelled", "done"]);
    expect(await f.run(f.worktree, "symbolic-ref", "--short", "HEAD")).toBe(f.branch);
    expect(f.notices).toEqual([]);
  });

  test("[验收线 2] the leftover worktree has uncommitted changes → not reused, not removed, held with the reason", async () => {
    const f = await authorFixture(1);
    await failOnceAndWait(f);
    writeFileSync(join(f.worktree, "a.ts"), "edited\n");
    writeFileSync(join(f.worktree, "new.ts"), "new\n");
    const held = await f.tick();
    expect(held.step).toBe("held");
    expect(f.ensureIntents().at(-1)).toMatchObject({ status: "unknown", receipt: expect.stringContaining("worktree 有改动") });
    expect(f.creates).toHaveLength(1);
    expect(f.task().agent).toBeNull();
    expect(readFileSync(join(f.worktree, "a.ts"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(f.worktree, "new.ts"), "utf8")).toBe("new\n");
  });

  test("[验收线 2] a leftover on another branch, or with commits of its own past the base, is held as well", async () => {
    const f = await authorFixture(1);
    await failOnceAndWait(f);
    await f.run(f.worktree, "checkout", "-q", "-b", "other");
    expect((await f.tick()).step).toBe("held");
    expect(f.ensureIntents().at(-1)!.receipt).toContain("不在本卡分支");

    const g = await authorFixture(1);
    await failOnceAndWait(g);
    await g.run(g.worktree, "commit", "-q", "--allow-empty", "-m", "own work");
    expect((await g.tick()).step).toBe("held");
    expect(g.ensureIntents().at(-1)!.receipt).toContain("有自己的提交");
    expect(g.creates).toHaveLength(1);
    expect(existsSync(g.worktree)).toBe(true);
  });

  test("wrong-start: a correct branch at ancestor A cannot retry from immutable base B", async () => {
    const f = await authorFixture(1);
    const ancestor = await f.run(f.repo, "rev-parse", "HEAD");
    await f.run(f.repo, "commit", "-q", "--allow-empty", "-m", "base B");
    f.setHead(await f.run(f.repo, "rev-parse", "HEAD"));
    await failOnceAndWait(f);
    await f.run(f.worktree, "reset", "--hard", ancestor); // only the disposable fixture, before any human edits
    expect((await f.tick()).step).toBe("held");
    expect(f.ensureIntents().at(-1)!.receipt).toContain("不在本卡起点");
    expect(f.creates).toHaveLength(1);
    expect(await f.run(f.worktree, "rev-parse", "HEAD")).toBe(ancestor);
  });

  for (const state of ["legacy clean", "legacy wrong start", "corrupt saved start", "different card"]) {
    test(`saved-start validation: ${state}`, async () => {
      const f = await authorFixture(1);
      const ancestor = await f.run(f.repo, "rev-parse", "HEAD");
      await f.run(f.repo, "commit", "-q", "--allow-empty", "-m", "expected base");
      f.setHead(await f.run(f.repo, "rev-parse", "HEAD"));
      await failOnceAndWait(f);
      const metadata = join(await f.run(f.worktree, "rev-parse", "--absolute-git-dir"), "scheduler-author-start.json");
      if (state.startsWith("legacy")) rmSync(metadata);
      else if (state === "corrupt saved start") writeFileSync(metadata, "{");
      else writeFileSync(metadata, JSON.stringify({ ...JSON.parse(readFileSync(metadata, "utf8")), branch: "another-card" }));
      if (state === "legacy wrong start") await f.run(f.worktree, "reset", "--hard", ancestor);
      expect((await f.tick()).step).toBe(state === "legacy clean" ? "session" : "held");
      expect(f.creates).toHaveLength(state === "legacy clean" ? 2 : 1);
    });
  }

  for (const obstacle of ["invalid base", "existing branch"]) {
    test(`initial checkout still refuses ${obstacle}`, async () => {
      const f = await authorFixture(0);
      if (obstacle === "invalid base") f.setHead("f".repeat(40));
      else await f.run(f.repo, "branch", f.branch);
      f.hello(true);
      expect((await f.tick()).step).toBe("stage");
      expect((await f.tick()).step).toBe("held");
      expect(f.creates).toHaveLength(0);
      expect(existsSync(f.worktree)).toBe(false);
      expect(f.ensureIntents().at(-1)!.receipt).toContain(obstacle === "invalid base" ? "创建本机 worktree 失败" : "分支");
    });
  }

  test("the saved start survives origin/main advancing while create backs off", async () => {
    const f = await authorFixture(1);
    await failOnceAndWait(f);
    const start = await f.run(f.worktree, "rev-parse", "HEAD");
    await f.run(f.repo, "commit", "-q", "--allow-empty", "-m", "new main");
    await f.run(f.repo, "fetch", "-q", "origin");
    expect(await f.run(f.repo, "rev-parse", "origin/main")).not.toBe(start);
    expect((await f.tick()).step).toBe("session");
    expect(f.creates).toHaveLength(2);
    expect(await f.run(f.worktree, "rev-parse", "HEAD")).toBe(start);
  });

  test("hidden-untracked: status.showUntrackedFiles=no cannot conceal an uncommitted file", async () => {
    const f = await authorFixture(1);
    await failOnceAndWait(f);
    await f.run(f.repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(f.worktree, "new.ts"), "human edit\n");
    expect((await f.tick()).step).toBe("held");
    expect(f.ensureIntents().at(-1)!.receipt).toContain("worktree 有改动");
    expect(f.creates).toHaveLength(1);
    expect(readFileSync(join(f.worktree, "new.ts"), "utf8")).toBe("human edit\n");
  });

  for (const sub of ["node_modules", "web/node_modules"]) {
    for (const shape of ["directory", "redirected link", "ignored directory"]) {
      test(`dependency-exemption: ${sub} replaced by ${shape} is preserved and held`, async () => {
        const f = await authorFixture(1);
        await failOnceAndWait(f);
        const dest = join(f.worktree, sub), other = join(f.repo, "other-deps");
        rmSync(dest); // unlink the fixture's scheduler link, never its shared target
        if (shape === "redirected link") { mkdirSync(other); symlinkSync(other, dest); }
        else mkdirSync(dest);
        writeFileSync(join(dest, "human-edits"), "keep me\n");
        if (shape === "ignored directory") {
          const exclude = await f.run(f.repo, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude");
          writeFileSync(exclude, "node_modules\n");
        }
        expect((await f.tick()).step).toBe("held");
        expect(f.ensureIntents().at(-1)!.receipt).toContain("worktree 有改动");
        expect(f.creates).toHaveLength(1);
        expect(readFileSync(join(dest, "human-edits"), "utf8")).toBe("keep me\n");
      });
    }
  }

  test("[验收线 3] reviewer: fail clean, wait through planner backoff, then create again", async () => {
    const { f, d, creates, checkout } = await reviewerFixture();
    expect(existsSync(checkout)).toBe(true);
    expect((await f.tick()).step).toBe("session");
    expect(f.intents().at(-1)).toMatchObject({ node: "adversarial_review", status: "done" });
    expect(creates).toHaveLength(2);
    expect(creates[1][2]).toBe(checkout);
    const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
    delete r.agents["agent-rv-t1"];
    writeFileSync(f.registryPath, JSON.stringify(r));
    writeFileSync(join(checkout, "a.ts"), "patched\n");
    expect(await d.ensure(f.task(), "reviewer", "claude")).toMatchObject({ kind: "manual", reason: expect.stringContaining("已跟踪文件被改过") });
    expect(creates).toHaveLength(2);
    expect(readFileSync(join(checkout, "a.ts"), "utf8")).toBe("patched\n");
  });

  for (const change of ["tracked", "hidden untracked", "wrong branch", "wrong head", "dependency directory"]) {
    test(`reviewer clean-failure retry preserves and holds ${change}`, async () => {
      const { f, creates, checkout, repo, run } = await reviewerFixture();
      let edited: string | null = null;
      if (change === "wrong branch") await run(checkout, "checkout", "-q", "-b", "human-branch");
      else if (change === "wrong head") await run(checkout, "commit", "-q", "--allow-empty", "-m", "human commit");
      else {
        await run(repo, "config", "status.showUntrackedFiles", "no");
        if (change === "dependency directory") mkdirSync(join(checkout, "node_modules"));
        edited = join(checkout, change === "tracked" ? "a.ts" : change === "dependency directory" ? "node_modules/human-edits" : "new.ts");
        writeFileSync(edited, "keep me\n");
      }
      const head = await run(checkout, "rev-parse", "HEAD");
      const held = await f.tick();
      expect(held.step).toBe("held");
      expect(held.detail).toContain(edited ? "worktree 有改动" : "不在预期 detached 起点");
      expect(creates).toHaveLength(1);
      expect(await run(checkout, "rev-parse", "HEAD")).toBe(head);
      if (edited) expect(readFileSync(edited, "utf8")).toBe("keep me\n");
    });
  }
});
