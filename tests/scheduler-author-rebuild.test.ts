/**
 * AREB1 end to end, in production wiring: the LOCAL1 shape. A local author has delivered, the card sits in merge, LIFE1 retires the
 * author through the real `ledger scheduler-worker-retire` child, the merge driver bounces ci_fail back to fix (its ledger writes are
 * real ledger children under the scheduler identity and lease), and the next auto tick runs the real autoTickDeps ensure — whose
 * ledger writes are again real children. Temp HOME / state / ledger / registry, a real git repo with a local origin; only
 * `manager create`, the swap reading, the PR snapshot and the order transport are stand-ins. No bridge, peer or GitHub.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { recoveryPolicy } from "../src/lib/recovery-policy.js";
import { readRegistryAgentsSync } from "../src/lib/registry.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { parseSchedulerConfig, readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { encodeLease } from "../src/lib/scheduler-lease-env.js";
import { beginMergeRun } from "../src/lib/scheduler-merge.js";
import type { MergeExternal, PrSnapshot } from "../src/lib/scheduler-merge-driver.js";
import { clearQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { schedulerMergeTick } from "../src/lib/scheduler-service.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { testChildEnv } from "./test-env.js";

const MANAGER = join(import.meta.dir, "..", "src", "manager.ts");
const OLD = "agent-task-t1-code-local-r1", NEW = "agent-task-t1-r2", BRANCH = "task/T1";
const RUN = "https://github.com/example/repo/actions/runs/7";
const cleanups: (() => void)[] = [];
const saved = { state: process.env.CLAUDESTRA_STATE_DIR, runtime: process.env.CLAUDESTRA_RUNTIME_DIR };
afterEach(() => {
  clearQueuedLocalStarts();
  process.env.CLAUDESTRA_STATE_DIR = saved.state; process.env.CLAUDESTRA_RUNTIME_DIR = saved.runtime;
  for (const c of cleanups.splice(0)) c();
});

interface FixtureOpts {
  old?: string; retire?: boolean; retireWire?: Record<string, unknown>; binding?: { agent: string; transport: string; state: string };
  /** runs after every git call of the service (the race window between its checks and its effects) */ afterGit?: (args: string[]) => Promise<void>;
  /** rewrites a git result of the service (fault injection) */ gitOut?: (args: string[], r: { code: number; out: string }) => { code: number; out: string };
  createFails?: number;
}
const CAPACITY = { ok: false, cleanedUp: true, error: "Selected model is at capacity.\n（已清理：窗口已关；频道已删；占位已删）" };

async function fixture(opts: FixtureOpts = {}) {
  const old = opts.old ?? OLD;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "areb1-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state"), runtime = join(root, "run"), home = join(root, "home"), tmp = join(root, "tmp");
  for (const d of [state, runtime, home, tmp]) mkdirSync(d, { recursive: true });
  // The service's own ledger children inherit process.env: point them at this fixture's state for the test's duration.
  process.env.CLAUDESTRA_STATE_DIR = state; process.env.CLAUDESTRA_RUNTIME_DIR = runtime;
  const childEnv = testChildEnv({ HOME: home, TMPDIR: tmp, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: runtime });
  const singleton = (await acquireLock(join(root, "scheduler.lock")))!, maintenance = (await acquireLock(join(root, "maintenance.lock")))!;
  const lease = { singleton: { path: join(root, "scheduler.lock"), token: singleton.token }, maintenance: { path: join(root, "maintenance.lock"), token: maintenance.token } };
  cleanups.unshift(() => { singleton.release(); maintenance.release(); });
  const cli = async (scheduler: boolean, ...args: string[]): Promise<Record<string, unknown>> => {
    const p = Bun.spawn([process.execPath, "--no-env-file", MANAGER, "ledger", ...args], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: scheduler ? { ...childEnv, CLAUDESTRA_SCHEDULER_SERVICE: "1", DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_LEASE: encodeLease(lease) } : childEnv });
    const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    await p.exited;
    const last = out.trim().split("\n").at(-1);
    if (!last) throw new Error(`ledger ${args[0]}: ${err}`);
    return JSON.parse(last) as Record<string, unknown>;
  };

  // real repo: origin is a bare clone; the author's work is pushed there, so origin/<branch> is the PR head
  const repo = join(root, "repo"), bare = join(root, "origin.git"), worktreeRoot = join(root, "wt");
  const run = async (cwd: string, ...args: string[]) => {
    const r = await git(["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    if (r.code !== 0) throw new Error(r.out);
    return r.out.trim();
  };
  mkdirSync(repo); mkdirSync(bare);
  await run(bare, "init", "-q", "--bare", "-b", "main");
  await run(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "one\n");
  await run(repo, "add", "."); await run(repo, "commit", "-q", "-m", "one");
  await run(repo, "remote", "add", "origin", bare); await run(repo, "push", "-q", "origin", "main");
  const oldTree = join(root, "old-author");
  await run(repo, "worktree", "add", "-q", "-b", BRANCH, oldTree, "main");
  writeFileSync(join(oldTree, "a.ts"), "two\n");
  await run(oldTree, "commit", "-qam", "author work");
  await run(oldTree, "push", "-q", "origin", BRANCH);
  const head = await run(oldTree, "rev-parse", "HEAD");

  const spec = join(root, "T1.md");
  writeFileSync(spec, "# T1\n模板:code\n");
  const registryPath = join(state, "registry.json"), configPath = join(state, "scheduler.json"), projectsPath = join(state, "projects.json");
  const agents: Record<string, Record<string, unknown>> = { [old]: { cwd: oldTree, projectId: "p", task: "T1", sessionId: "s-old", runtime: "claude-code", kind: "worker", status: "active" } };
  const saveRegistry = () => writeFileSync(registryPath, JSON.stringify({ agents }));
  saveRegistry();
  // The project's configured author runtime is codex; the card's workflow family is claude: a rebuild keeps claude.
  const config = { enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: repo, localAuthorRuntime: "codex" } } };
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [repo] }] }));

  const dbPath = join(state, "ledger.sqlite"), db = openLedger(dbPath);
  cleanups.unshift(() => closeLedger(dbPath));
  const ctx = { actor: "owner", now: 100 };
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createTask(db, ctx, { project: "p", id: "T1", title: "local author card", kind: "code", agent: old });
  createTask(db, ctx, { project: "p", id: "T2", title: "another card", kind: "code" });
  setWorkflow(db, ctx, { taskId: "T1", taskRev: 1, template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "缩小范围" });
  db.query("UPDATE tasks SET stage='merge', round=1, rev=2, headSHA=?, pr='https://github.com/example/repo/pull/42', branch=?, spec=?, extra=? WHERE id='T1'").run(head, BRANCH, spec,
    JSON.stringify({ fileGlobs: ["a.ts"] }));
  registerWorker(db, { agent: old, sessionId: "s-old", taskId: "T1", role: "author", createdBy: "agent-pm", now: 100 });
  insertEvent(db, { actor: old, now: 110 }, { project: "p", target: "T1", kind: "deliver", text: "build 交付", data: { op: "deliver", step: "build", headTo: head } }, false);
  insertEvent(db, { actor: "agent-review", now: 120 }, { project: "p", target: "T1", kind: "review", text: "", data: {
    round: 1, head, verdict: "pass", reviewer: "agent-review", reviewerSessionId: "rs-T1", reviewerFamily: "codex", path: "reviews/T1-r1/report.md", findings: [], p0: 0, p1: 0, p2: 0 } }, false);
  const intent = (id: string, node: string, action: string, status: string) => db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,
    causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt) VALUES (?,'T1','p',?,?,3,4,2,1,?,2,?,'r',100,100)`).run(id, node, action, head, status);
  intent("merge-T1", "merge_deploy", "merge", "submitted");
  intent("rc-T1", "adversarial_review", "ensure_session", "done");
  intent("ac-T1", "build", "ensure_session", "done");
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','task:T1','T1','merge-T1',100)").run();
  db.query("INSERT INTO scheduler_resources (project,resource,taskId,intentId,acquiredAt) VALUES ('p','merge:p','T1','merge-T1',100)").run();
  db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','reviewer','agent-review','rs-T1','codex','acp','active','rc-T1',100,100)`).run();
  // LOCAL1's author was start_node's, not scheduler-bound (the tick planned an author ensure); a binding is only added on request
  if (opts.binding) db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
    VALUES ('T1','author',?,'s-old','claude',?,?,'ac-T1',100,100)`).run(opts.binding.agent, opts.binding.transport, opts.binding.state);
  beginMergeRun(db, { actor: "scheduler", now: 130 }, "merge-T1", ["check"]);

  // LIFE1 retires the idle author while the card waits in merge: the real ledger child, then the agent and its checkout go.
  if (opts.retire !== false) {
    const wire = { agent: old, sessionId: "s-old", taskId: "T1", role: "author", rule: "memory", reason: "swap 91% 超过 70%，闲置 0.5h", idleMs: 1_800_000,
      bytesBefore: 9000, bytesAfter: 1000, steps: ["已归档", "已移除"], pending: [], retry: false, ...opts.retireWire };
    expect(await cli(true, "scheduler-worker-retire", "--wire", JSON.stringify(wire))).toMatchObject({ ok: true });
  }
  delete agents[old]; saveRegistry();
  await run(repo, "worktree", "remove", "--force", oldTree);

  // The merge queue sees the required check red on the reviewed head: ci_fail back to fix, written by real ledger children.
  const snap: PrSnapshot = { state: "OPEN", head, branch: BRANCH, base: "main", draft: false, crossRepository: false, mergeState: "UNSTABLE", mergeSha: null,
    checks: [{ name: "check", bucket: "fail", link: RUN }] };
  const external: MergeExternal = { inspect: async () => snap, freshness: async () => ({ behindBy: 0, mainHead: head }),
    carryReview: async () => ({ ok: false, reason: "不沿用" }), updateBranch: async () => {}, merge: async () => { throw new Error("must not merge"); } };
  const bounce = () => schedulerMergeTick(db, parseSchedulerConfig(config), (...args) => cli(true, ...args.slice(1)), () => external);

  const creates: string[][] = [], sent: SessionRef[] = [];
  let swap: number | null = 10;
  const start = { registryPath, configPath, projectsPath, lockPath: join(root, "codex.lock") };
  const prod = autoTickDeps(db, { registryPath, worktreeRoot, lease, readConfig: () => readSchedulerConfig(configPath),
    git: async (args) => {
      const r = await git(args);
      await opts.afterGit?.(args);
      return opts.gitOut ? opts.gitOut(args, r) : r;
    },
    create: async (...args) => {
      creates.push(args);
      if (creates.length <= (opts.createFails ?? 0)) return CAPACITY; // manager create cleaned its window, channel and placeholder
      const runtime = args.includes("codex") ? "codex" : "claude-code";
      agents[`agent-${args[1]}`] = { cwd: args[2], projectId: "p", task: "T1", sessionId: `s-${args[1]}`, runtime, transport: runtime === "codex" ? "acp" : "tmux", kind: "worker", status: "active" };
      saveRegistry(); return { ok: true };
    },
    rebuild: { policy: (project, key) => recoveryPolicy(project, key, join(state, "recovery-policy.json")), swapPct: async () => swap, start } });
  let now = Date.now();
  const deps: AutoTickDeps = { ...prod, now: () => ++now, borrow: async () => [], prState: async () => null as never, notifyPm: async () => {},
    worker: () => ({ route: "channel", fallbackReason: null, ensure: async () => ({ kind: "unknown", reason: "unused" }),
      submit: async (ref, key) => { sent.push(ref); return { status: "sent", route: "channel", messageKey: key, evidence: "mock" }; },
      observe: async () => ({ state: "running", busy: false }), cancel: async () => ({ ok: true, evidence: "mock" }), archive: async () => ({ ok: true, evidence: "mock" }) }) };
  const tick = async () => (await schedulerAutoTick(db, readSchedulerConfig(configPath).projects, deps)).cards.find((c) => c.taskId === "T1");
  const mode = (m: "on" | "observe" | "off") => cli(false, "scheduler-recovery", "p", m, "--key", "authorRebuild", "--reason", "AREB1 测试");
  const events = (op: string) => listEvents(db, { target: "T1" }).filter((e) => e.data.op === op);
  return { db, repo, run, head, worktreeRoot, cli, bounce, tick, mode, creates, sent, events, agents, saveRegistry, cleanups, old,
    setSwap: (v: number | null) => { swap = v; }, advance: (ms: number) => { now += ms; }, task: () => getTask(db, "T1")! };
}

type F = Awaited<ReturnType<typeof fixture>>;
/** Ticks until the card stops at a manual / waiting / sent outcome (each tick is one planner step). */
async function settle(f: F, n = 6) {
  const seen: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = await f.tick();
    seen.push(`${c?.step}:${c?.detail ?? ""}`);
    if (c && ["fallback_manual", "manual", "waiting", "sent", "held"].includes(String(c.step))) break;
  }
  return seen;
}

describe("AREB1 author rebuild after LIFE1 retired it (LOCAL1 shape, production wiring)", () => {
  test("off (= the old code): the merge ci_fail bounce stops the card for PM with 不在本机 registry", async () => {
    const f = await fixture();
    expect(await f.mode("off")).toMatchObject({ ok: true });
    await f.bounce();
    expect(f.task().stage).toBe("fix");
    const seen = await settle(f);
    expect(seen.join("\n")).toContain(`执行者 ${OLD} 不在本机 registry`);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
    expect(f.creates).toEqual([]);
  }, 60_000);

  test("on: a new-named claude author on the current head, the card's agent rewritten by the step, the fix order sent", async () => {
    const f = await fixture();
    expect(await f.mode("on")).toMatchObject({ ok: true });
    await f.bounce();
    expect(f.task().stage).toBe("fix");
    const seen = await settle(f, 8);
    expect(seen.join("\n")).not.toContain("不在本机 registry");
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0][1]).toBe(NEW.slice("agent-".length));
    expect(f.creates[0]).not.toContain("codex"); // the workflow's family, not the project's configured codex runtime
    const tree = f.creates[0][2];
    expect(await f.run(tree, "rev-parse", "HEAD")).toBe(f.head);
    expect(await f.run(tree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
    expect(f.task()).toMatchObject({ agent: NEW, stage: "fix" });
    expect(getWorkflow(f.db, "T1")).toMatchObject({ mode: "auto", authorFamily: "claude" });
    expect(f.events("local_author")).toEqual([expect.objectContaining({ actor: "scheduler", data: expect.objectContaining({ agent: NEW, family: "claude" }) })]);
    expect(f.events("worker_retire")).toHaveLength(1); // the old retire record stays as written
    expect(f.sent.map((r) => r.agent)).toContain(NEW);
  }, 60_000);

  test("observe (default): still manual with the old reason, plus one observe event naming the retire it relied on", async () => {
    const f = await fixture();
    await f.bounce();
    const seen = await settle(f);
    expect(seen.join("\n")).toContain(`执行者 ${OLD} 不在本机 registry`);
    const obs = f.events("recovery_observe");
    expect(obs).toHaveLength(1);
    expect(obs[0].data).toMatchObject({ mechanism: "authorRebuild", agent: OLD, retireSeq: f.events("worker_retire")[0].seq });
    expect(f.creates).toEqual([]);
  }, 60_000);
});

describe("AREB1 counter-examples (on)", () => {
  const manualWith = async (f: F, text: string) => {
    expect(await f.mode("on")).toMatchObject({ ok: true });
    await f.bounce();
    const seen = await settle(f);
    expect(seen.join("\n")).toContain(text);
    expect(f.creates).toEqual([]);
  };

  test("not in the registry but no retire record → manual", async () => {
    await manualWith(await fixture({ retire: false }), `执行者 ${OLD} 不在本机 registry`);
  }, 60_000);

  test("the retire record is another card's, or a reviewer's → manual", async () => {
    await manualWith(await fixture({ retireWire: { taskId: "T2" } }), `执行者 ${OLD} 不在本机 registry`);
    await manualWith(await fixture({ retireWire: { role: "reviewer" } }), `执行者 ${OLD} 不在本机 registry`);
  }, 90_000);

  test("PR head moved away from the card's head → manual", async () => {
    const f = await fixture();
    const other = join(f.worktreeRoot, "..", "mover");
    await f.run(f.repo, "worktree", "add", "-q", "--detach", other, f.head);
    writeFileSync(join(other, "a.ts"), "three\n");
    await f.run(other, "commit", "-qam", "moved");
    await f.run(other, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
    await f.run(f.repo, "worktree", "remove", "--force", other);
    await manualWith(f, "PR 当前 head");
  }, 60_000);

  test("a deliver after the retire → manual", async () => {
    const f = await fixture();
    insertEvent(f.db, { actor: OLD, now: Date.now() }, { project: "p", target: "T1", kind: "deliver", text: "late", data: { op: "deliver" } }, false);
    await manualWith(f, `执行者 ${OLD} 不在本机 registry`);
  }, 60_000);

  test("swap above LIFE1's line → waits with one note, builds nothing; builds once swap is back under", async () => {
    const f = await fixture();
    expect(await f.mode("on")).toMatchObject({ ok: true });
    await f.bounce();
    f.setSwap(91);
    for (let i = 0; i < 3; i++) await settle(f);
    expect(f.creates).toEqual([]);
    expect(f.events("author_rebuild_wait")).toHaveLength(1);
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    f.setSwap(null); // unreadable swap never builds either
    await settle(f);
    expect(f.creates).toEqual([]);
    f.setSwap(40);
    await settle(f, 8);
    expect(f.creates).toHaveLength(1);
  }, 90_000);

  test("no slot of the workflow's family (pool limit reached) → waits, not built, no family switch, not manual", async () => {
    const f = await fixture();
    expect(await f.mode("on")).toMatchObject({ ok: true });
    const cfgPath = join(String(process.env.CLAUDESTRA_STATE_DIR), "scheduler.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.projects.p.agents = { claude: 1, codex: 2 }; // the claude slot is taken, codex has room: wait, never switch family
    writeFileSync(cfgPath, JSON.stringify(cfg));
    f.db.query("UPDATE tasks SET stage='build', agent='agent-busy' WHERE id='T2'").run();
    f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
      VALUES ('x-T2','T2','p','build','ensure_session',1,1,1,1,NULL,2,'done','r',100,100)`).run();
    f.db.query(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES ('T2','author','agent-busy','s-busy','claude','tmux','active','x-T2',100,100)`).run();
    await f.bounce();
    const seen = await settle(f);
    expect(seen).toEqual(["waiting:等 claude 空位"]);
    expect(f.creates).toEqual([]);
    expect(seen.join("\n")).not.toContain("不在本机 registry");
    expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    expect(existsSync(join(f.worktreeRoot, "t1"))).toBe(false);
  }, 60_000);
});

/** on, bounced, settled: exactly one create, of `name`, on the card's branch at its head; the card names it. */
async function expectRebuilt(f: F, name: string) {
  expect(await f.mode("on")).toMatchObject({ ok: true });
  await f.bounce();
  await settle(f, 8);
  expect(f.creates.map((c) => c[1])).toEqual([name.slice("agent-".length)]);
  expect(await f.run(f.creates[0][2], "rev-parse", "HEAD")).toBe(f.head);
  expect(f.task().agent).toBe(name);
}
/** on, bounced, settled: nothing created, the card keeps the old author, the branch is where it was, the outcome names `text`. */
async function expectKept(f: F, text: string, branchAt?: string | (() => string)) {
  expect(await f.mode("on")).toMatchObject({ ok: true });
  await f.bounce();
  const seen = await settle(f);
  expect(seen.join("\n")).toContain(text);
  expect(f.creates).toEqual([]);
  expect(f.task().agent).toBe(f.old);
  expect(await f.run(f.repo, "rev-parse", `refs/heads/${BRANCH}`)).toBe((typeof branchAt === "function" ? branchAt() : branchAt) ?? f.head);
}

describe("AREB1 names (on)", () => {
  test("the retired author had start_node's default name → the next generation, never the old name", async () => {
    await expectRebuilt(await fixture({ old: "agent-task-t1" }), "agent-task-t1-r2");
  }, 60_000);
  test("the retired author was itself a rebuild (-r2) → -r3", async () => {
    await expectRebuilt(await fixture({ old: "agent-task-t1-r2" }), "agent-task-t1-r3");
  }, 60_000);
  test("the next name is already a registry agent (another session) → kept for PM as unknown, never overwritten", async () => {
    const f = await fixture();
    f.agents[NEW] = { cwd: "/elsewhere", projectId: "p", task: "T9", sessionId: "s-someone", runtime: "claude-code", kind: "worker", status: "active" };
    f.saveRegistry();
    expect(await f.mode("on")).toMatchObject({ ok: true });
    await f.bounce();
    const seen = await settle(f);
    expect(seen.join("\n")).toContain(`${NEW} 已存在但未绑定`);
    expect(f.creates).toEqual([]);
    expect(f.agents[NEW]).toMatchObject({ sessionId: "s-someone", cwd: "/elsewhere" });
    expect(f.task().agent).toBe(OLD);
  }, 60_000);
});

describe("AREB1 retire evidence (on)", () => {
  const gone = `执行者 ${OLD} 不在本机 registry`;
  test("a retire written by someone other than the scheduler service → manual", async () => {
    const f = await fixture({ retire: false });
    insertEvent(f.db, { actor: "agent-pm", now: 140 }, { project: "p", target: "T1", kind: "scheduler", text: "fake", data: { op: "worker_retire",
      agent: OLD, sessionId: "s-old", role: "author", rule: "memory", reason: "x", retry: false } }, false);
    await expectKept(f, gone);
  }, 60_000);
  test("a retire of another session than the registered one → manual", async () => {
    await expectKept(await fixture({ retireWire: { sessionId: "s-other" } }), gone);
  }, 60_000);
  test("the agent registered again after the retire → manual", async () => {
    const f = await fixture();
    registerWorker(f.db, { agent: OLD, sessionId: "s-again", taskId: "T1", role: "author", createdBy: "agent-pm" });
    await expectKept(f, gone);
  }, 60_000);
  test("another live author registered on the card → manual", async () => {
    const f = await fixture();
    registerWorker(f.db, { agent: "agent-other", sessionId: "s-x", taskId: "T1", role: "author", createdBy: "agent-pm" });
    await expectKept(f, gone);
  }, 60_000);
  test("the card is placed on a peer → never rebuilt here (the peer's author is not ours)", async () => {
    const f = await fixture();
    f.db.query("UPDATE tasks SET extra = ? WHERE id='T1'").run(JSON.stringify({ fileGlobs: ["a.ts"], placement: "peer:Sekai" }));
    await expectKept(f, "peer:Sekai");
  }, 60_000);
});

describe("AREB1 the retired author's branch (on)", () => {
  test("the local branch carries unpushed work past the card's head → kept (unknown), branch untouched", async () => {
    const f = await fixture();
    const side = join(f.worktreeRoot, "..", "side");
    await f.run(f.repo, "worktree", "add", "-q", side, BRANCH);
    writeFileSync(join(side, "a.ts"), "wip\n");
    await f.run(side, "commit", "-qam", "wip");
    const wip = await f.run(side, "rev-parse", "HEAD");
    await f.run(f.repo, "worktree", "remove", "--force", side);
    await expectKept(f, `分支 ${BRANCH} 不在本卡起点`, wip);
  }, 60_000);
  test("another worktree holds the branch → kept", async () => {
    const f = await fixture();
    await f.run(f.repo, "worktree", "add", "-q", join(f.worktreeRoot, "..", "holder"), BRANCH);
    await expectKept(f, `分支 ${BRANCH} 仍被 worktree 占用`);
  }, 60_000);
  test("the target path is a dangling symlink → kept, the link left as it was", async () => {
    const f = await fixture();
    mkdirSync(f.worktreeRoot, { recursive: true });
    symlinkSync(join(f.worktreeRoot, "nowhere"), join(f.worktreeRoot, "t1"));
    await expectKept(f, "已存在，保留并等待核对");
    expect(lstatSync(join(f.worktreeRoot, "t1")).isSymbolicLink()).toBe(true);
  }, 60_000);
  test("the branch moves between the first check and the add (race) → kept, the moved branch untouched", async () => {
    let moved = "";
    const f: F = await fixture({ afterGit: async (args) => {
      if (moved || !args.includes("fetch") || !args.includes("origin")) return;
      const tree = await f.run(f.repo, "commit-tree", "-p", f.head, "-m", "race", `${f.head}^{tree}`);
      await f.run(f.repo, "update-ref", `refs/heads/${BRANCH}`, tree);
      moved = tree;
    } });
    await expectKept(f, `分支 ${BRANCH} 不在本卡起点`, () => moved);
    expect(moved).not.toBe("");
  }, 60_000);
  test("saving the checkout's start record fails → kept (unknown), nothing created", async () => {
    const f = await fixture({ gitOut: (args, r) => args.at(-1) === "--absolute-git-dir" ? { code: 0, out: "/nonexistent/areb1" } : r });
    await expectKept(f, "保存 worktree 起点失败");
  }, 60_000);
  test("a clean create failure backs off, then the retry reuses its own checkout and builds once", async () => {
    const f = await fixture({ createFails: 1 });
    expect(await f.mode("on")).toMatchObject({ ok: true });
    await f.bounce();
    const first = await settle(f);
    expect(first.join("\n")).toContain("建会话失败，现场已清理");
    expect(f.task().agent).toBe(OLD);
    f.advance(20 * 60_000);
    await settle(f, 8);
    expect(f.creates.map((c) => c[1])).toEqual([NEW.slice("agent-".length), NEW.slice("agent-".length)]);
    expect(f.task().agent).toBe(NEW);
  }, 90_000);
});
