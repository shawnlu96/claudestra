import { afterEach, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { unknownQuota } from "../src/lib/ai-quota.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runStart, type StepIO } from "../src/lib/dag-tools-steps.js";
import { claimNode, settleClaim } from "../src/lib/ledger-autostart.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { LedgerReader } from "../src/lib/ledger-read.js";
import { getIntent, getWorkflow } from "../src/lib/ledger-scheduler.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setFrozen, setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { readRegistryAgentsSync } from "../src/lib/registry.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { readSchedulerConfig, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { ensureLocalAuthor, type LocalAuthorEnv } from "../src/lib/scheduler-local-author.js";
import { localAuthorPlan } from "../src/lib/scheduler-local-author-plan.js";
import { queuedLocalAuthor } from "../src/lib/scheduler-local-author-queue.js";
import { writeLocalAuthor } from "../src/lib/scheduler-local-author-write.js";
import { clearQueuedLocalStarts, retryQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import { codexSlotHeld } from "../src/lib/scheduler-local-runtime-slots.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { encodeLease, SCHEDULER_LEASE_ENV } from "../src/lib/scheduler-lease-env.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import type { SessionRef } from "../src/lib/worker-session.js";
import { runLedger } from "../src/manager/ledger.js";
import { testChildEnv } from "./test-env.js";

const cleanups: (() => void)[] = [];
afterEach(() => { clearQueuedLocalStarts(); for (const close of cleanups.splice(0)) close(); });

async function fixture(slots = 0, runtime = "codex", explicit = false) {
  const dir = mkdtempSync(join(tmpdir(), "ap1-")), dbPath = join(dir, "ledger.sqlite"), db = openLedger(dbPath);
  cleanups.push(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });
  const repo = join(dir, "repo"), ledgerDir = join(dir, "ledger"), worktreeRoot = join(dir, "wt");
  mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(join(ledgerDir, "docs", "tasks"), { recursive: true });
  writeFileSync(join(ledgerDir, "docs", "tasks", "ap-a.md"), "# specification\n模板:code\n");
  const registryPath = join(dir, "registry.json"), configPath = join(dir, "scheduler.json"), projectsPath = join(dir, "projects.json");
  const agents: Record<string, object> = Object.fromEntries(Array.from({ length: slots }, (_, n) => [`agent-slot-${n}`, { runtime: "codex", status: "active" }]));
  const saveRegistry = () => writeFileSync(registryPath, JSON.stringify({ agents })); saveRegistry();
  const remote: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: "o/r", poolTimeoutMin: 15 };
  const config = { enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: repo, localAuthorRuntime: runtime, remote } } };
  writeFileSync(configPath, JSON.stringify(config)); writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [repo] }] }));
  const options = { registryPath, configPath, projectsPath, lockPath: join(dir, "codex.lock"), codexQuota: async () => unknownQuota("test") };
  let now = 10_000, dead = false;
  const ctx = { actor: "owner", now };
  db.run("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  for (let n = 0; n < slots; n++) createTask(db, ctx, { id: `slot-${n}`, project: "other", title: "occupied", kind: "code", agent: `agent-slot-${n}` });
  setMeta(db, ctx, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, ctx, { project: "p", slug: "ap", title: "AP" });
  initDag(db, ctx, { id: "ab12-ap", rev: 1, nodes: [{ key: "a", oneLine: "author", fileGlobs: ["src/a.ts"] }] });
  const borrow: BorrowEntry[] = [{ peer: "Sekai", projects: ["p"], roles: ["write", "review"], priority: "first", maxOpen: 10 }];
  const hello = (paused: boolean) => recordHello(db, "Sekai", null, { v: 1, proto: 2, boot: "b", seq: paused ? 2 : 1,
    paused: paused ? { reason: "codex_quota", until: now + 600_000 } : null,
    slots: { codex: { total: 10, busy: 0 }, claude: { total: 0, busy: 0 } },
    grant: { until: now + 600_000, roles: ["write", "review"], repos: ["o/r"], ordersPerDay: 20, ordersLeftToday: 20 } }, now);
  hello(false);
  const cli = (actor: string, args: string[]) => runLedger(args, { db, actor, registryPath, projectIds: ["p"], now: () => ++now,
    autoProjects: () => ["p"], autoDispatch: () => true, loadRegistry: async () => ({ agents }) as never, saveRegistry: async () => {} });
  const pre = await preflightStart({ db, caller: "pm", ledgerDir, worktreeRoot, projectDirs: async () => [repo], agentNames: () => [],
    exists: existsSync, branchExists: async () => false, autoReady: () => null, template: () => null,
    placement: (db, q) => startPlacement(db, { policy: () => ({ remote, maxWorkers: 2 }), borrow: async () => borrow, originRepo: async () => "o/r", now: () => now }, q),
  }, { featureId: "ab12-ap", key: "a", ...(explicit ? { placement: "peer:Sekai" } : {}) });
  if (!pre.ok || "already" in pre) throw new Error(JSON.stringify(pre));
  expect(pre.plan.peer?.name).toBe("Sekai");
  const claim = explicit ? null : claimNode(db, { actor: "scheduler", now }, { featureId: "ab12-ap", key: "a", arm: "a".repeat(16), template: "code",
    peer: pre.plan.peer, svc: { autoDispatch: true, projects: ["p"], maxWorkers: () => 2, now: () => now, pool: () => ({ remote, borrow }) } }).claim;
  const io: StepIO = { db: () => db, attempt: "open", manager: async (args) => claim
    ? cli("scheduler", ["scheduler-autostart", "step", String(claim.seq), ...args.slice(1)]) : cli("pm", args.slice(1)),
    git: async () => { throw new Error("peer opening must not use git"); }, exists: existsSync, read: () => null,
    write: () => {}, remove: () => {}, symlink: () => {}, agentExists: () => false };
  expect(await runStart(io, pre.plan)).toMatchObject({ ok: true });
  if (claim) settleClaim(db, { actor: "scheduler", now }, { claim: claim.seq, outcome: "done" });
  // The opening CLI uses its canonical spec path; this fixture's spec lives in its private ledgerDir.
  db.query("UPDATE tasks SET spec = ? WHERE id = 'ap-a'").run(pre.plan.specPath);
  const gitCalls: string[][] = [], creates: string[][] = [], sent: SessionRef[] = [], notices: string[] = [];
  const env: LocalAuthorEnv = { db, registryPath, worktreeRoot, registryRow: (name) => readRegistryAgentsSync(registryPath).find((r) => r.name === name),
    active: () => { if (dead) throw new SchedulerStopped("stopped"); },
    git: async (args) => {
      gitCalls.push(args);
      if (args.includes("rev-parse")) {
        if (args.at(-1)?.startsWith("refs/heads/")) return { code: 1, out: "absent" };
        if (args.at(-1) === "--absolute-git-dir") return { code: 0, out: join(dir, "worktree-git") };
        if (["origin/main^{commit}", "HEAD"].includes(args.at(-1)!)) return { code: 0, out: "1".repeat(40) };
        return { code: 128, out: "invalid base" };
      }
      if (args.includes("add")) mkdirSync(args.at(-2)!, { recursive: true });
      return { code: 0, out: "" };
    },
    create: async (...args) => {
      creates.push(args);
      if (runtime === "codex") expect(codexSlotHeld()).toBe(true);
      agents[`agent-${args[1]}`] = { cwd: args[2], projectId: "p", task: "ap-a", sessionId: "s-author", runtime: runtime === "codex" ? "codex" : "claude-code",
        transport: runtime === "codex" ? "acp" : "tmux", status: "active" }; saveRegistry(); return { ok: true };
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
    ensure: (task, role, family) => task.agent ? normal.ensure(task, role, family) : ensureLocalAuthor(env, task, options),
    notifyPm: async (_task, text) => { notices.push(text); },
    worker: () => ({ route: runtime === "codex" ? "acp" : "channel", fallbackReason: null, ensure: async () => ({ kind: "unknown", reason: "unused" }),
      submit: async (ref, key) => { sent.push(ref); return { status: "sent", route: runtime === "codex" ? "acp" : "channel", messageKey: key, evidence: "mock" }; },
      observe: async () => ({ state: "running", busy: false }), cancel: async () => ({ ok: true, evidence: "mock" }), archive: async () => ({ ok: true, evidence: "mock" }) }) };
  const tick = async () => {
    const r = await schedulerAutoTick(db, readSchedulerConfig(configPath).projects, deps);
    expect(r.failed).toEqual([]); return r.cards[0];
  };
  return { db, dir, options, env, deps, config, configPath, tick, hello, agents, saveRegistry, gitCalls, creates, sent, notices,
    task: () => getTask(db, "ap-a")!, stop: () => { dead = true; } };
}

test("automatic peer selection does not pin the card; cooldown replans locally, creates Codex, binds agent and dispatches", async () => {
  const f = await fixture();
  expect(f.task()).toMatchObject({ agent: null, extra: { repo: "o/r" } });
  expect(f.task().extra).not.toHaveProperty("placement");
  f.hello(true);
  expect((await f.tick()).step).toBe("stage");
  expect((await f.tick()).step).toBe("session");
  expect(f.creates).toHaveLength(1);
  expect(f.creates[0].slice(-4)).toEqual(["--runtime", "codex", "--transport", "acp"]);
  expect(f.gitCalls.some((a) => a.includes("worktree") && a.includes("add"))).toBe(true);
  expect(f.task().agent).toBe("agent-task-ap-a");
  expect(getWorkflow(f.db, "ap-a")?.authorFamily).toBe("codex");
  expect(getSchedulerSession(f.db, "ap-a", "author")).toMatchObject({ family: "codex", transport: "acp", agent: "agent-task-ap-a" });
  expect((await f.tick()).step).toBe("sent");
  expect(f.sent[0]).toMatchObject({ family: "codex", agent: "agent-task-ap-a" });
  expect(f.notices).toEqual([]);
});

test("explicit start_node placement remains pinned when the peer cools down", async () => {
  const f = await fixture(0, "codex", true);
  expect(f.task().extra.placement).toBe("peer:Sekai");
  f.hello(true);
  await f.tick();
  expect((await f.tick()).detail).toContain("固定放在 peer:Sekai");
  expect(f.creates).toEqual([]); expect(f.task().agent).toBeNull();
});

test("six global Codex sessions queue without worktree/Claude/manual fallback, then start once after a slot frees", async () => {
  const f = await fixture(6); f.hello(true);
  await f.tick();
  expect((await f.tick()).step).toBe("waiting");
  expect((await f.tick()).step).toBe("waiting");
  expect(f.creates).toEqual([]); expect(f.gitCalls).toEqual([]);
  expect(getWorkflow(f.db, "ap-a")?.mode).toBe("auto"); expect(f.task().agent).toBeNull();
  expect(listEvents(f.db, { target: "ap-a" }).filter((e) => e.text.includes("本机执行者排队 queued"))).toHaveLength(1);
  delete f.agents["agent-slot-0"]; f.saveRegistry();
  await retryQueuedLocalStarts(); // A timer outside a scheduler pass cannot create with an expired maintenance lease.
  expect(f.creates).toEqual([]);
  expect((await f.tick()).step).toBe("session");
  expect(f.creates).toHaveLength(1); expect(f.task().agent).toBe("agent-task-ap-a");
  expect((await f.tick()).step).toBe("sent"); expect(f.notices).toEqual([]);
});

test("configured Claude local author uses the canonical create path without a Codex slot", async () => {
  const f = await fixture(6, "claude"); f.hello(true); await f.tick();
  expect((await f.tick()).step).toBe("session");
  expect(f.creates[0]).not.toContain("codex"); expect(getWorkflow(f.db, "ap-a")?.authorFamily).toBe("claude");
});

test("queued author resumes after LedgerReader reopens the database between scheduler passes", async () => {
  const f = await fixture(6); f.hello(true); await f.tick();
  const reader = new LedgerReader(f.db.filename);
  try {
    f.env.db = reader.get()!;
    expect((await f.tick()).step).toBe("waiting");
    reader.close(); f.env.db = reader.get()!;
    delete f.agents["agent-slot-0"]; f.saveRegistry();
    expect((await f.tick()).step).toBe("session");
    expect(f.creates).toHaveLength(1);
    expect(f.task().agent).toBe("agent-task-ap-a");
  } finally { reader.close(); }
});

test("an existing standalone auto card also creates its missing local author without inventing a DAG", async () => {
  const f = await fixture(); f.hello(true);
  f.db.query("UPDATE tasks SET stage = 'cancelled' WHERE id = 'ap-a'").run();
  const task = createTask(f.db, { actor: "owner" }, { id: "plain", project: "p", title: "plain", kind: "code",
    branch: "feat/plain", spec: f.task().spec!, extra: { fileGlobs: ["src/plain.ts"] } }).row;
  setWorkflow(f.db, { actor: "owner" }, { taskId: task.id, taskRev: task.rev, template: "code", templateVersion: 3,
    mode: "auto", authorFamily: "claude", fallback: "PM" });
  await f.tick();
  expect(getTask(f.db, "plain")?.agent).toBe("agent-task-plain");
  expect(getSchedulerSession(f.db, "plain", "author")?.family).toBe("codex");
  expect(f.db.query("SELECT * FROM dag_bindings WHERE taskId = 'plain'").all()).toEqual([]);
});

test("a thrown queued retry clears its receipt so a later scheduler pass can retry", async () => {
  const f = await fixture(); f.hello(true); await f.tick();
  const plan = await localAuthorPlan(f.db, f.task(), f.env.worktreeRoot, f.options);
  if (typeof plan === "string") throw new Error(plan);
  const queue = (run: () => ReturnType<typeof ensureLocalAuthor>) => queuedLocalAuthor(f.db, plan, f.options, async () => ({ ok: true }), run);
  expect((await queue(async () => ({ kind: "wait", reason: "full" }))).kind).toBe("wait");
  await expect(queue(async () => { throw new SchedulerStopped("lost queued lease"); })).rejects.toThrow("lost queued lease");
  expect(await queue(async () => ({ kind: "unknown", reason: "new attempt" }))).toEqual({ kind: "unknown", reason: "new attempt" });
});

test("lease loss after worktree preparation creates no worker and leaves task unassigned", async () => {
  const f = await fixture(); f.hello(true); await f.tick();
  const git = f.env.git;
  f.env.git = async (args) => { const r = await git(args); if (args.includes("add")) f.stop(); return r; };
  await expect(f.tick()).rejects.toThrow("stopped");
  expect(f.creates).toEqual([]); expect(f.task().agent).toBeNull();
});

test("queue is inert after PM freezes the project, pins a peer, or switches the workflow to manual", async () => {
  for (const change of ["freeze", "pin", "manual"]) {
    const f = await fixture(6); f.hello(true); await f.tick(); await f.tick();
    if (change === "freeze") setFrozen(f.db, { actor: "owner" }, { project: "p", frozen: true, reason: "hold" });
    if (change === "pin") f.db.query("UPDATE tasks SET extra = ? WHERE id = 'ap-a'").run(JSON.stringify({ ...f.task().extra, placement: "peer:Sekai" }));
    if (change === "manual") f.db.query("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'ap-a'").run();
    await retryQueuedLocalStarts(); await f.tick();
    expect(f.creates).toEqual([]); expect(f.task().agent).toBeNull(); expect(f.gitCalls).toEqual([]);
    if (change === "freeze") setFrozen(f.db, { actor: "owner" }, { project: "p", frozen: false, reason: "resume" });
    f.db.query("UPDATE tasks SET extra = ? WHERE id = 'ap-a'").run(JSON.stringify({ ...f.task().extra, placement: undefined }));
    f.db.query("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'ap-a'").run();
    expect((await f.tick()).step).toBe("waiting");
    expect(listEvents(f.db, { target: "ap-a" }).filter((e) => e.text.includes("本机执行者排队 queued"))).toHaveLength(2);
  }
});

test("assignment transaction rechecks PM edits and rolls back if its audit fails", async () => {
  const f = await fixture(); f.hello(true); await f.tick();
  const ledger = f.env.ledger;
  f.env.ledger = async (...args) => {
    if (args[4] === "local-author") f.db.run("CREATE TRIGGER reject_author_note BEFORE INSERT ON events WHEN NEW.kind = 'note' BEGIN SELECT RAISE(ABORT, 'audit'); END");
    return ledger(...args);
  };
  const result = await schedulerAutoTick(f.db, readSchedulerConfig(f.configPath).projects, f.deps);
  expect(result.failed[0]?.error).toContain("audit");
  expect(f.task().agent).toBeNull(); expect(getWorkflow(f.db, "ap-a")?.authorFamily).toBe("claude");
  const intentId = (f.db.query("SELECT id FROM scheduler_intents WHERE action = 'ensure_session'").get() as { id: string }).id;
  const intent = getIntent(f.db, intentId)!;
  f.db.query("UPDATE tasks SET agent = 'pm-choice', rev = rev + 1 WHERE id = 'ap-a'").run();
  expect(() => writeLocalAuthor(f.db, { actor: "scheduler" }, { claim: intent.eventSeq, sub: "local-author", pos: ["ap-a", intentId],
    flags: { agent: "agent-task-ap-a", rev: String(intent.taskRev) } }, f.options)).toThrow("当前已认领");
  expect(f.task().agent).toBe("pm-choice");
});

test("production ledger CLI accepts only the leased scheduler assignment and persists through a query-only service reader", async () => {
  const f = await fixture(); f.hello(true); await f.tick();
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  const reader = new LedgerReader(f.db.filename); f.env.db = reader.get()!;
  const ledger = f.env.ledger;
  f.env.ledger = async (...args) => {
    if (args[4] !== "local-author") return ledger(...args);
    const manager = new URL("../src/manager.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, manager, ...args], { stdout: "pipe", stderr: "pipe", env: testChildEnv({
      CLAUDESTRA_STATE_DIR: f.dir, CLAUDESTRA_SCHEDULER_SERVICE: "1",
      [SCHEDULER_LEASE_ENV]: encodeLease({ singleton: { path: singletonPath, token: singleton.token }, maintenance: { path: maintenancePath, token: maintenance.token } }),
    }) });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stderr, code }).toEqual({ stderr: "", code: 0 });
    return JSON.parse(stdout);
  };
  try {
    // env.ensure only reads this connection; all mutations run through the mocked scheduler CLI or the real child above.
    expect((await f.tick()).step).toBe("session");
    expect(f.task().agent).toBe("agent-task-ap-a");
    expect(getWorkflow(f.db, "ap-a")?.authorFamily).toBe("codex");
  } finally { reader.close(); singleton.release(); maintenance.release(); }
});

test("cancelled queue receipts are removed, so an eligible card starts afresh after unfreezing", async () => {
  const f = await fixture(6); f.hello(true); await f.tick(); await f.tick();
  setFrozen(f.db, { actor: "owner" }, { project: "p", frozen: true, reason: "hold" });
  await retryQueuedLocalStarts();
  setFrozen(f.db, { actor: "owner" }, { project: "p", frozen: false, reason: "resume" });
  const plan = await localAuthorPlan(f.db, f.task(), f.env.worktreeRoot, f.options);
  if (typeof plan === "string") throw new Error(plan);
  let runs = 0;
  // A new direct attempt happens even while an unrelated global queue driver is busy.
  const { queueLocalStart } = await import("../src/lib/scheduler-local-runtime-queue.js");
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  await queueLocalStart({ db: () => f.db, manager: async () => ({ ok: true }) } as unknown as StepIO,
    { ...plan, key: "other" } as never, { queuedReady: async () => { entered.resolve(); await gate.promise; return "cancel"; }, queuedNotice: async () => {} },
    "test", async () => { throw new Error("cancelled blocker must not launch"); });
  const driving = retryQueuedLocalStarts(); await entered.promise;
  try {
    expect(await queuedLocalAuthor(f.db, plan, f.options, async () => ({ ok: true }), async () => {
      runs++; return { kind: "unknown", reason: "fresh" };
    })).toEqual({ kind: "unknown", reason: "fresh" });
    expect(runs).toBe(1);
  } finally { gate.resolve(); await driving; }
});

test("an overlapping global queue driver never borrows another ensure call's launch callback", async () => {
  const f = await fixture(); f.hello(true); await f.tick();
  const plan = await localAuthorPlan(f.db, f.task(), f.env.worktreeRoot, f.options);
  if (typeof plan === "string") throw new Error(plan);
  const { queueLocalStart } = await import("../src/lib/scheduler-local-runtime-queue.js");
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  await queueLocalStart({ db: () => f.db, manager: async () => ({ ok: true }) } as unknown as StepIO,
    { ...plan, key: "blocker" } as never, { queuedReady: async () => { entered.resolve(); await gate.promise; return "cancel"; }, queuedNotice: async () => {} },
    "test", async () => { throw new Error("cancelled blocker must not launch"); });
  const queue = (run: () => ReturnType<typeof ensureLocalAuthor>) => queuedLocalAuthor(f.db, plan, f.options, async () => ({ ok: true }), run);
  await queue(async () => ({ kind: "wait", reason: "full" }));
  const driving = retryQueuedLocalStarts(); await entered.promise;
  let runs = 0;
  const run = async (): ReturnType<typeof ensureLocalAuthor> => { runs++; return { kind: "unknown", reason: "owned" }; };
  const ensuring = queue(run); gate.resolve();
  expect((await ensuring).kind).toBe("wait"); await driving;
  expect(runs).toBe(0);
  expect(await queue(run)).toEqual({ kind: "unknown", reason: "owned" }); expect(runs).toBe(1);
});

test("a wait during Claude preparation uses runtime-neutral queue notes", async () => {
  const f = await fixture(0, "claude"); f.hello(true); await f.tick();
  const plan = await localAuthorPlan(f.db, f.task(), f.env.worktreeRoot, f.options);
  if (typeof plan === "string") throw new Error(plan);
  const notes: string[] = [];
  const result = await queuedLocalAuthor(f.db, plan, f.options, async (args) => { notes.push(args[3]); return { ok: true }; },
    async () => ({ kind: "wait", reason: "intent changed" }));
  expect(result.kind).toBe("wait"); expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("本机执行者排队"); expect(notes[0]).not.toContain("Codex");
});

test("microtask overlap cannot run a leased author callback in a background queue context", async () => {
  const context = new AsyncLocalStorage<string>();
  for (let offset = 0; offset < 8; offset++) {
    const f = await fixture(); f.hello(true); await f.tick();
    const plan = await localAuthorPlan(f.db, f.task(), f.env.worktreeRoot, f.options);
    if (typeof plan === "string") throw new Error(plan);
    const queue = (run: () => ReturnType<typeof ensureLocalAuthor>) => queuedLocalAuthor(f.db, plan, f.options, async () => ({ ok: true }), run);
    await queue(async () => ({ kind: "wait", reason: "full" }));
    const seen: (string | undefined)[] = [];
    const run = async (): ReturnType<typeof ensureLocalAuthor> => { seen.push(context.getStore()); return { kind: "unknown", reason: "owned" }; };
    const background = context.run("background", retryQueuedLocalStarts);
    for (let n = 0; n < offset; n++) await Promise.resolve();
    const result = await context.run("ensure", () => queue(run));
    await background;
    expect(seen).not.toContain("background");
    if (result.kind === "wait") expect(await context.run("ensure", () => queue(run))).toEqual({ kind: "unknown", reason: "owned" });
    expect(seen).toEqual(["ensure"]);
  }
});

for (const pool of [false, true]) test(`production autoTickDeps defaults create and bind the selected author (pool=${pool})`, async () => {
  const f = await fixture(); f.hello(true); await f.tick();
  if (pool) Object.assign(f.config.projects.p, { localAuthorRuntime: "claude", agents: { claude: 0, codex: 1 } });
  writeFileSync(f.configPath, JSON.stringify(f.config));
  const singletonPath = join(f.dir, "singleton.lock"), maintenancePath = join(f.dir, "maintenance.lock");
  const singleton = (await acquireLock(singletonPath, 0))!, maintenance = (await acquireLock(maintenancePath, 0))!;
  const root = new URL("../", import.meta.url).pathname;
  const script = `
    import { mock } from "bun:test";
    import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
    const root = ${JSON.stringify(root)}, state = ${JSON.stringify(f.dir)}, pool = ${pool};
    const managerModule = await import(root + "src/lib/run-manager.ts");
    const actualRun = managerModule.runManagerProcess;
    const { codexSlotHeld } = await import(root + "src/lib/scheduler-local-runtime-slots.ts");
    let creates = 0;
    mock.module(root + "src/lib/run-manager.ts", () => ({ ...managerModule, runManagerProcess: async (args, opts) => {
      if (args[0] !== "create") {
        if (args[0] !== "ledger") throw new Error("unexpected manager command");
        return actualRun(args, opts);
      }
      if (!codexSlotHeld() || args.slice(-4).join(" ") !== "--runtime codex --transport acp") throw new Error("wrong runtime or missing lock");
      creates++;
      const registry = JSON.parse(readFileSync(state + "/registry.json", "utf8"));
      registry.agents["agent-" + args[1]] = { cwd: args[2], projectId: "p", sessionId: "production-author", runtime: "codex", transport: "acp", status: "active" };
      writeFileSync(state + "/registry.json", JSON.stringify(registry));
      if (pool) {
        const config = JSON.parse(readFileSync(state + "/scheduler.json", "utf8"));
        // Admission selected Codex, but a freed Claude seat changes the next dynamic selection before session binding.
        config.projects.p.agents.claude = 2;
        writeFileSync(state + "/scheduler.json", JSON.stringify(config));
      }
      return { ok: true };
    } }));
    const { autoTickDeps } = await import(root + "src/lib/scheduler-auto-deps.ts");
    const { LedgerReader } = await import(root + "src/lib/ledger-read.ts");
    const { getTask } = await import(root + "src/lib/ledger-store.ts");
    const reader = new LedgerReader(state + "/ledger.sqlite"), db = reader.get();
    const deps = autoTickDeps(db, { lease: JSON.parse(process.env[${JSON.stringify(SCHEDULER_LEASE_ENV)}]), git: async (args) => {
      if (args.includes("rev-parse")) {
        if (args.at(-1)?.startsWith("refs/heads/")) return { code: 1, out: "absent" };
        if (args.at(-1) === "--absolute-git-dir") return { code: 0, out: state + "/worktree-git" };
        if (["origin/main^{commit}", "HEAD"].includes(args.at(-1))) return { code: 0, out: "1".repeat(40) };
        return { code: 128, out: "invalid base" };
      }
      if (args.includes("add")) mkdirSync(args.at(-2), { recursive: true });
      return { code: 0, out: "" };
    } });
    if (pool) {
      const config = JSON.parse(readFileSync(state + "/scheduler.json", "utf8"));
      config.projects.p.agents.codex = 0;
      writeFileSync(state + "/scheduler.json", JSON.stringify(config));
      const waiting = await deps.ensure(getTask(db, "ap-a"), "author", "claude");
      if (waiting.kind !== "wait" || !waiting.reason.includes("codex") || creates) throw new Error("pool cap bypassed");
      config.projects.p.agents.codex = 1;
      writeFileSync(state + "/scheduler.json", JSON.stringify(config));
    }
    const result = await deps.ensure(getTask(db, "ap-a"), "author", "claude");
    console.log(JSON.stringify({ result, creates, task: getTask(db, "ap-a") })); reader.close();
  `;
  try {
    f.deps.ensure = async () => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { stdout: "pipe", stderr: "pipe", env: testChildEnv({
        HOME: f.dir, CODEX_HOME: join(f.dir, "codex-home"), CLAUDESTRA_STATE_DIR: f.dir,
        [SCHEDULER_LEASE_ENV]: encodeLease({ singleton: { path: singletonPath, token: singleton.token }, maintenance: { path: maintenancePath, token: maintenance.token } }),
      }) });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(JSON.parse(out)).toMatchObject({ creates: 1, result: { kind: "ready", ref: { family: "codex", transport: "acp" } }, task: { agent: "agent-task-ap-a" } });
      Object.assign(f.agents, JSON.parse(readFileSync(f.options.registryPath, "utf8")).agents);
      return JSON.parse(out).result;
    };
    expect((await f.tick()).step).toBe("session");
    expect(getWorkflow(f.db, "ap-a")?.authorFamily).toBe("codex");
  } finally { singleton.release(); maintenance.release(); }
});
