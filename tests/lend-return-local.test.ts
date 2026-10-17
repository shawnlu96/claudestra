/**
 * agent-list-recovery-LENDBACK1 (lend-return-local.ts): a lent write order that ends with nothing started comes back to this machine:
 * the pin on that peer goes, a restored local agent of another family (or never bound) is not restored, a pin already tried says
 * so in the wait reason, and the recovery key lendReturnLocal off keeps all of it as before.
 * Fixture: tests/lend-send-back-local-author.test.ts's pinned() (start_node pinned to peer:Sekai, live grant).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unknownQuota } from "../src/lib/ai-quota.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runStart, type StepIO } from "../src/lib/dag-tools-steps.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { claimLend, leaseLend, offerLendCore, sweepLend, WRITE_POOL_TTL_MS } from "../src/lib/ledger-lend.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { lendReturnRegistry, pinTriedNote, staleAuthorRow, staleTreeAside } from "../src/lib/lend-return-local.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { readRegistryAgentsSync } from "../src/lib/registry.js";
import { placeAgentPool } from "../src/lib/scheduler-agent-pool.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { readSchedulerConfig, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { ensureLocalAuthor, type LocalAuthorEnv } from "../src/lib/scheduler-local-author.js";
import { writeLocalAuthor } from "../src/lib/scheduler-local-author-write.js";
import { clearQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import type { PlacementFacts } from "../src/lib/scheduler-placement.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { runLedger } from "../src/manager/ledger.js";

const FP = "abcd-ef01-2345-6789", WORKER = `${FP}/agent-lend-0123456789`;
const cleanups: (() => void)[] = [];
const registryDefault = lendReturnRegistry.row;
afterEach(() => { clearQueuedLocalStarts(); rmSync(RECOVERY_POLICY_PATH, { force: true }); for (const close of cleanups.splice(0)) close(); });
const setMode = (mode: "on" | "observe" | "off") =>
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { lendReturnLocal: mode } } } }));

async function pinned() {
  const dir = mkdtempSync(join(tmpdir(), "sendback1-")), dbPath = join(dir, "ledger.sqlite"), db = openLedger(dbPath);
  cleanups.push(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });
  const repo = join(dir, "repo"), ledgerDir = join(dir, "ledger"), worktreeRoot = join(dir, "wt");
  mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(join(ledgerDir, "docs", "tasks"), { recursive: true });
  writeFileSync(join(ledgerDir, "docs", "tasks", "ap-a.md"), "# specification\n模板:code\n");
  const registryPath = join(dir, "registry.json"), configPath = join(dir, "scheduler.json"), projectsPath = join(dir, "projects.json");
  const agents: Record<string, object> = {}, saveRegistry = () => writeFileSync(registryPath, JSON.stringify({ agents }));
  saveRegistry();
  const remote: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: "o/r", poolTimeoutMin: 15 };
  writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: repo, localAuthorRuntime: "codex", remote } } }));
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [repo] }] }));
  const options = { registryPath, configPath, projectsPath, lockPath: join(dir, "codex.lock"), codexQuota: async () => unknownQuota("test") };
  const clock = { now: 10_000 }, tickNow = () => ++clock.now;
  db.run("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  setMeta(db, { actor: "owner", now: clock.now }, { project: "p", key: "pms", value: ["pm"] });
  createFeature(db, { actor: "owner", now: clock.now }, { project: "p", slug: "ap", title: "AP" });
  initDag(db, { actor: "owner", now: clock.now }, { id: "ab12-ap", rev: 1, nodes: [{ key: "a", oneLine: "author", fileGlobs: ["src/a.ts"] }] });
  const borrow: BorrowEntry[] = [{ peer: "Sekai", projects: ["p"], roles: ["write", "review"], priority: "first", maxOpen: 10 }];
  const hello = (paused: boolean) => recordHello(db, "Sekai", null, { v: 1, proto: 2, boot: "b", seq: paused ? 2 : 1,
    paused: paused ? { reason: "codex_quota", until: clock.now + 3_600_000 } : null, slots: { codex: { total: 10, busy: 0 }, claude: { total: 0, busy: 0 } },
    grant: { until: clock.now + 3_600_000, roles: ["write", "review"], repos: ["o/r"], ordersPerDay: 20, ordersLeftToday: 20 } }, clock.now);
  hello(false);
  const cli = (actor: string, args: string[]) => runLedger(args, { db, actor, registryPath, projectIds: ["p"], now: tickNow,
    autoProjects: () => ["p"], autoDispatch: () => true, loadRegistry: async () => ({ agents }) as never, saveRegistry: async () => {} });
  const pre = await preflightStart({ db, caller: "pm", ledgerDir, worktreeRoot, projectDirs: async () => [repo], agentNames: () => [],
    exists: existsSync, branchExists: async () => false, autoReady: () => null, template: () => null,
    placement: (db, q) => startPlacement(db, { policy: () => ({ remote, maxWorkers: 2 }), borrow: async () => borrow, originRepo: async () => "o/r",
      now: () => clock.now }, q),
  }, { featureId: "ab12-ap", key: "a", placement: "peer:Sekai" });
  if (!pre.ok || "already" in pre) throw new Error(JSON.stringify(pre));
  const io: StepIO = { db: () => db, attempt: "open", manager: async (args) => cli("pm", args.slice(1)),
    git: async () => { throw new Error("peer opening must not use git"); }, exists: existsSync, read: () => null,
    write: () => {}, remove: () => {}, symlink: () => {}, agentExists: () => false };
  expect(await runStart(io, pre.plan)).toMatchObject({ ok: true });
  db.query("UPDATE tasks SET spec = ? WHERE id = 'ap-a'").run(pre.plan.specPath);
  const env: LocalAuthorEnv = { db, registryPath, worktreeRoot, registryRow: (name) => readRegistryAgentsSync(registryPath).find((r) => r.name === name),
    active: () => {},
    git: async (args) => {
      if (args.includes("rev-parse")) {
        if (args.at(-1)?.startsWith("refs/heads/")) return { code: 1, out: "absent" };
        if (args.at(-1) === "--absolute-git-dir") return { code: 0, out: join(dir, "worktree-git") };
        return ["origin/main^{commit}", "HEAD"].includes(args.at(-1)!) ? { code: 0, out: "1".repeat(40) } : { code: 128, out: "invalid base" };
      }
      if (args.includes("add")) mkdirSync(args.at(-2)!, { recursive: true });
      return { code: 0, out: "" };
    },
    create: async (...args) => {
      agents[`agent-${args[1]}`] = { cwd: args[2], projectId: "p", task: "ap-a", sessionId: "s-author", runtime: "codex", transport: "acp", status: "active" };
      saveRegistry(); return { ok: true };
    },
    ledger: async (...args) => {
      if (args[1] !== "scheduler-autostart" || !args[4].startsWith("local-author")) return cli("scheduler", args.slice(1));
      const flags = Object.fromEntries(args.slice(7).map((x) => { const i = x.indexOf("="); return [x.slice(2, i), x.slice(i + 1)]; }));
      return db.transaction(() => writeLocalAuthor(db, { actor: "scheduler", now: tickNow(), dedupKey: flags.dedup },
        { claim: Number(args[3]), sub: args[4], pos: args.slice(5, 7), flags }, options)).immediate();
    } };
  const normal = autoTickDeps(db, { registryPath, worktreeRoot });
  const deps: AutoTickDeps = { ...normal, manager: env.ledger, borrow: async () => borrow, now: tickNow,
    ensure: (task, role, family) => task.agent ? normal.ensure(task, role, family) : ensureLocalAuthor(env, task, options),
    notifyPm: async () => {},
    worker: () => ({ route: "acp", fallbackReason: null, ensure: async () => ({ kind: "unknown", reason: "unused" }),
      submit: async (_ref, key) => ({ status: "sent", route: "acp", messageKey: key, evidence: "mock" }),
      observe: async () => ({ state: "running", busy: false }), cancel: async () => ({ ok: true, evidence: "mock" }), archive: async () => ({ ok: true, evidence: "mock" }) }) };
  const tick = async () => {
    const r = await schedulerAutoTick(db, readSchedulerConfig(configPath).projects, deps);
    expect(r.failed).toEqual([]); return r.cards[0];
  };
  const ctx = () => ({ actor: "owner", now: tickNow() });
  /** The write order Sekai would get: offered under the lease, and (as after an earlier peer deliver) the card names Sekai's worker. */
  const lend = (assignee: { kind: string | null; who: string | null } = { kind: "peer_agent", who: WORKER }) => {
    const o = offerLendCore(db, ctx(), { taskId: "ap-a", peer: "Sekai", family: "codex", repo: "o/r", pr: null, spec: getTask(db, "ap-a")!.spec!,
      borrow: borrow[0]!, write: { fp: FP, base: "main", baseSha: "1".repeat(40), report: null } });
    db.query("UPDATE tasks SET assigneeKind = ?, assignee = ?, rev = rev + 1 WHERE id = 'ap-a'").run(assignee.kind, assignee.who);
    return o.orderId;
  };
  const claim = (orderId: string) => claimLend(db, ctx(), "Sekai", { v: 1, orderId, worker: "agent-lend-0123456789" } as never, () => borrow[0]!);
  const notStarted = (orderId: string) =>
    leaseLend(db, ctx(), "Sekai", { v: 1, orderId, gen: 1, action: "release", reason: "not_started", detail: "没有推送权限" } as never);
  const sendBackNote = () => listEvents(db, { target: "ap-a" }).filter((e) => (e.data.lend as { op?: string } | undefined)?.op === "send_back");
  lendReturnRegistry.row = (name) => readRegistryAgentsSync(registryPath).find((r) => r.name === name);
  cleanups.push(() => { lendReturnRegistry.row = registryDefault; });
  return { db, clock, tick, hello, lend, claim, notStarted, sendBackNote, agents, saveRegistry, task: () => getTask(db, "ap-a")! };
}


type Fixture = Awaited<ReturnType<typeof pinned>>;
const notStartedPath = (f: Fixture, orderId: string) => { f.claim(orderId); f.notStarted(orderId); };
const timeoutPath = (f: Fixture) => { f.clock.now += WRITE_POOL_TTL_MS + 1; sweepLend(f.db, { actor: "owner", now: f.clock.now }); };
const PATHS: [string, (f: Fixture, orderId: string) => void][] = [
  ["the peer never started a worker", notStartedPath],
  ["nobody claimed it within the pool timeout", (f) => timeoutPath(f)],
];
const bindAuthor = (f: Fixture, agent: string, family: string) => (f.db.run("PRAGMA foreign_keys = OFF"), f.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family,
  transport, state, createIntentId, createdAt, updatedAt) VALUES ('ap-a', 'author', ?, 's-old', ?, 'tmux', 'retired', 'i-old', 1, 1)`).run(agent, family), f.db.run("PRAGMA foreign_keys = ON"));
// The family the planner asks next round: Sekai's codex claim wrote it into the workflow (lend-author-family.ts); no head was delivered.

for (const [why, sendBack] of PATHS) {
  test(`[验收线 1] sent back because ${why} under a live grant: pin dropped, next tick creates the local author`, async () => {
    const f = await pinned();
    expect((await f.tick()).step).toBe("stage");
    const orderId = f.lend();
    sendBack(f, orderId);
    expect(f.task().extra).not.toHaveProperty("placement");
    expect(f.sendBackNote()[0]!.data.lend).toMatchObject({ unpinned: "peer:Sekai" });
    const steps: string[] = [];
    for (let n = 0; n < 3 && steps.at(-1) !== "session"; n++) {
      const next = await f.tick();
      expect(JSON.stringify(next)).not.toContain("固定 Sekai");
      steps.push(next.step);
    }
    expect(steps.at(-1)).toBe("session");
    expect(f.task()).toMatchObject({ agent: "agent-task-ap-a", assigneeKind: "agent" });
  });
}

test("[验收线 4] off: the pin stays under a live grant, exactly as before", async () => {
  setMode("off");
  const f = await pinned();
  await f.tick();
  const extra = JSON.stringify(f.task().extra);
  const orderId = f.lend();
  notStartedPath(f, orderId);
  expect(JSON.stringify(f.task().extra)).toBe(extra);
  expect(f.sendBackNote()[0]!.data.lend).toMatchObject({ restored: { assigneeKind: null, assignee: null }, unpinned: null });
});

test("observe: nothing changes, one sample per order", async () => {
  setMode("observe");
  const f = await pinned();
  await f.tick();
  const extra = JSON.stringify(f.task().extra);
  const orderId = f.lend();
  notStartedPath(f, orderId);
  expect(JSON.stringify(f.task().extra)).toBe(extra);
  const samples = listEvents(f.db, { project: "p" }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "lendReturnLocal");
  expect(samples).toHaveLength(1);
  expect(samples[0]!.data).toMatchObject({ unpinned: "peer:Sekai" });
});

test("[验收线 2] a restored local agent never bound to this card, or bound in another family, is cleared", async () => {
  for (const bound of [null, "claude"]) {
    const f = await pinned();
    await f.tick();
    f.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
    if (bound) bindAuthor(f, "agent-dev", bound);
    const orderId = f.lend();
    notStartedPath(f, orderId);
    expect(f.task()).toMatchObject({ agent: null, assigneeKind: null, assignee: null });
    expect(f.sendBackNote()[0]!.data.lend).toMatchObject({ restored: { assigneeKind: null, assignee: null }, unpinned: "peer:Sekai" });
  }
});

for (const [why, sendBack] of PATHS) {
  test(`[验收线 2] first lend, ${why}: the lease's never-bound local agent still on the card is cleared and the next ticks create the author`, async () => {
    const f = await pinned();
    await f.tick();
    f.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
    const orderId = f.lend({ kind: "agent", who: "agent-dev" }); // offer / claim never swap the assignee
    sendBack(f, orderId);
    expect(f.task()).toMatchObject({ agent: null, assigneeKind: null, assignee: null });
    expect(f.sendBackNote()[0]!.data.lend).toMatchObject({ restored: { assigneeKind: null, assignee: null }, unpinned: "peer:Sekai" });
    const steps: string[] = [];
    for (let n = 0; n < 3 && steps.at(-1) !== "session"; n++) steps.push((await f.tick()).step);
    expect(steps.at(-1)).toBe("session");
    expect(f.task()).toMatchObject({ agent: "agent-task-ap-a", assigneeKind: "agent" });
  });
}

test("[验收线 2] first lend: a same-family bound local agent stays; an agent PM put on the card later is never touched", async () => {
  const kept = await pinned();
  await kept.tick();
  kept.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
  bindAuthor(kept, "agent-dev", "codex");
  notStartedPath(kept, kept.lend({ kind: "agent", who: "agent-dev" }));
  expect(kept.task()).toMatchObject({ agent: "agent-dev", assigneeKind: "agent", assignee: "agent-dev" });
  const pm = await pinned();
  await pm.tick();
  pm.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
  const orderId = pm.lend({ kind: "agent", who: "agent-pm" });
  notStartedPath(pm, orderId);
  expect(pm.task()).toMatchObject({ assigneeKind: "agent", assignee: "agent-pm" });
});

test("[验收线 2] bound here in the card's family once, but its registry row now runs another family: cleared, and the next tick does not send it to PM over the family", async () => {
  const f = await pinned();
  await f.tick();
  f.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
  bindAuthor(f, "agent-dev", "codex"); // retired codex binding of this card
  f.agents["agent-dev"] = { cwd: "/elsewhere", projectId: "p", sessionId: "s-new", runtime: "claude-code", transport: "tmux", status: "active" };
  f.saveRegistry();
  notStartedPath(f, f.lend({ kind: "agent", who: "agent-dev" }));
  expect(f.task()).toMatchObject({ agent: null, assigneeKind: null, assignee: null });
  // the next tick no longer sends it to PM over the family (the old retired binding's own rebind rule is unchanged)
  const next = await f.tick();
  expect(next.step).not.toBe("manual");
  expect(next.detail ?? "").not.toContain("家族");
});

test("[验收线 2] bound here in the card's family and its registry row still runs that family: kept", async () => {
  const f = await pinned();
  await f.tick();
  f.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
  bindAuthor(f, "agent-dev", "codex");
  f.agents["agent-dev"] = { cwd: "/elsewhere", projectId: "p", sessionId: "s-old", runtime: "codex", transport: "tmux", status: "stopped" };
  f.saveRegistry();
  notStartedPath(f, f.lend({ kind: "agent", who: "agent-dev" }));
  expect(f.task()).toMatchObject({ agent: "agent-dev", assigneeKind: "agent", assignee: "agent-dev" });
});

test("[验收线 4] off: first lend keeps the never-bound local agent on the card as before", async () => {
  setMode("off");
  const f = await pinned();
  await f.tick();
  f.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
  notStartedPath(f, f.lend({ kind: "agent", who: "agent-dev" }));
  expect(f.task()).toMatchObject({ agent: "agent-dev", assigneeKind: "agent", assignee: "agent-dev" });
});

test("[验收线 2] a restored local agent bound to this card in its author family comes back as before", async () => {
  const f = await pinned();
  await f.tick();
  f.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
  bindAuthor(f, "agent-dev", "codex");
  const orderId = f.lend();
  notStartedPath(f, orderId);
  expect(f.task()).toMatchObject({ agent: "agent-dev", assigneeKind: "agent", assignee: "agent-dev" });
  expect(f.sendBackNote()[0]!.data.lend).toMatchObject({ restored: { assigneeKind: "agent", assignee: "agent-dev" } });
});

test("[验收线 4] off: a never-bound local agent is restored as before", async () => {
  setMode("off");
  const f = await pinned();
  await f.tick();
  f.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
  const orderId = f.lend();
  notStartedPath(f, orderId);
  expect(f.task()).toMatchObject({ agent: "agent-dev", assigneeKind: "agent", assignee: "agent-dev" });
});

test("a release with work (stopped) parks the order as unknown and keeps the pin", async () => {
  const f = await pinned();
  await f.tick();
  const extra = JSON.stringify(f.task().extra);
  const orderId = f.lend();
  f.claim(orderId);
  leaseLend(f.db, { actor: "owner", now: ++f.clock.now }, "Sekai", { v: 1, orderId, gen: 1, action: "release", reason: "stopped", detail: "半路停了" } as never);
  expect(JSON.stringify(f.task().extra)).toBe(extra);
  expect(f.sendBackNote()).toHaveLength(0);
});

const poolFacts = (mode: string): PlacementFacts & { writeLocal: { card: { project: string; task: string; window: string }; mode: () => never } } => ({
  remote: { mode: "balance", roles: [], poolTimeoutMin: 15, agents: { claude: 0, codex: 0 } } as never,
  peers: [{ peer: "X", roles: [], priority: "off", open: 9, v2: { why: null, roles: [], repos: ["o/r"], slots: { claude: 1, codex: 1 } } } as never],
  local: { room: false, running: 0, pool: { totals: { claude: 0, codex: 0 }, running: { claude: 0, codex: 0 } } },
  repo: "o/r", pin: "peer:X", tried: ["X"], lastPeer: null, writeLeasePeer: null, locksFree: true,
  writeLocal: { card: { project: "p", task: "ap-a", window: "fix:r1" }, mode: () => mode as never },
});

test("[验收线 1] a pin already tried says so instead of a fake seat wait; [验收线 4] off keeps 固定 X", () => {
  expect(placeAgentPool(poolFacts("off"), "fix", "claude")).toEqual({ kind: "wait", reason: "等 claude 空位（钉位 X 本轮已试过）" });
  setMode("off");
  expect(placeAgentPool(poolFacts("off"), "fix", "claude")).toEqual({ kind: "wait", reason: "等 claude 空位（固定 X）" });
  expect(pinTriedNote("p", "X", [])).toBeNull();
});

test("staleAuthorRow: only a stopped row bound to none of this card's sessions, other family or never started", async () => {
  const f = await pinned();
  const row = { name: "agent-task-ap-a", status: "stopped", runtime: "codex", sessionId: "s-old" };
  expect(staleAuthorRow(f.db, "ap-a", row, "claude")).toBe(true);
  expect(staleAuthorRow(f.db, "ap-a", row, "codex")).toBe(false);
  expect(staleAuthorRow(f.db, "ap-a", { ...row, sessionId: undefined }, "codex")).toBe(true);
  expect(staleAuthorRow(f.db, "ap-a", { ...row, status: "active" }, "claude")).toBe(false);
  bindAuthor(f, "agent-task-ap-a", "codex");
  expect(staleAuthorRow(f.db, "ap-a", row, "claude")).toBe(false);
});

/** A real repo with an origin (itself), as tests/scheduler-create-retry-worktree.test.ts's gitRepo. */
async function gitRepo(dir: string) {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const run = async (cwd: string, ...args: string[]) => {
    const r = await git(["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    if (r.code !== 0) throw new Error(r.out);
    return r.out;
  };
  await run(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "one\n");
  await run(repo, "add", "."); await run(repo, "commit", "-q", "-m", "one");
  await run(repo, "remote", "add", "origin", repo); await run(repo, "fetch", "-q", "origin");
  return { repo, run };
}

describe("[验收线 5] a replaced executor's checkout at the card's path (staleTreeAside)", () => {
  async function oldTree() {
    const dir = mkdtempSync(join(tmpdir(), "lendback1-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { repo, run } = await gitRepo(dir);
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    await run(repo, "add", ".gitignore"); await run(repo, "commit", "-q", "-m", "ignore"); await run(repo, "fetch", "-q", "origin");
    const worktree = join(dir, "wt", "ap-a");
    await run(repo, "worktree", "add", "-q", "-b", "feat/ap-a", worktree, "origin/main");
    const plan = { worktree, branch: "lend/ap-a-9109" }, owner = { name: "agent-task-ap-a", cwd: worktree, status: "stopped" };
    return { repo, run, worktree, plan, owner, aside: () => staleTreeAside(git, plan, owner, "-r2") };
  }

  test("[验收线 5] off-branch, clean (ignored files do not count), nothing of its own: a new path with the same suffix; the old tree stays", async () => {
    const t = await oldTree();
    writeFileSync(join(t.worktree, "build.log"), "ignored\n");
    expect(await t.aside()).toBe(`${t.worktree}-r2`);
    expect(existsSync(join(t.worktree, "a.ts"))).toBe(true);
    expect(await t.run(t.worktree, "symbolic-ref", "--short", "HEAD")).toBe("feat/ap-a");
  });

  test("[验收线 5] edits, an untracked file or its own commit: kept and waits as today", async () => {
    const edits = await oldTree();
    writeFileSync(join(edits.worktree, "a.ts"), "edited\n");
    expect(await edits.aside()).toBeNull();
    const untracked = await oldTree();
    writeFileSync(join(untracked.worktree, "new.ts"), "x\n");
    expect(await untracked.aside()).toBeNull();
    const own = await oldTree();
    writeFileSync(join(own.worktree, "a.ts"), "mine\n");
    await own.run(own.worktree, "commit", "-q", "-am", "mine");
    expect(await own.aside()).toBeNull();
  });

  test("on the card's branch or another owner's tree: unchanged; the new path already made by an earlier try is kept", async () => {
    const t = await oldTree();
    expect(await staleTreeAside(git, { ...t.plan, branch: "feat/ap-a" }, t.owner, "-r2")).toBeNull();
    expect(await staleTreeAside(git, t.plan, { ...t.owner, cwd: join(t.worktree, "..", "other") }, "-r2")).toBeNull();
    mkdirSync(`${t.worktree}-r2`); // the old tree still proven; checkout's strict reuse check (reusableAuthorWorktree) decides about the new path
    expect(await t.aside()).toBe(`${t.worktree}-r2`);
  });

  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    test(`[验收线 5] a tracked edit hidden by ${flag} keeps the old tree and waits as today`, async () => {
      const t = await oldTree();
      await t.run(t.worktree, "update-index", flag, "a.ts");
      writeFileSync(join(t.worktree, "a.ts"), "hidden edit\n");
      expect(await t.run(t.worktree, "status", "--porcelain")).toBe("");
      expect(await t.aside()).toBeNull();
    });
  }

  test("[验收线 5] a tracked edit the index stat cache hides (status empty, every entry plain H) keeps the old tree and waits as today", async () => {
    const t = await oldTree();
    await t.run(t.worktree, "config", "core.trustctime", "false"); await t.run(t.worktree, "config", "core.checkStat", "minimal");
    const file = join(t.worktree, "a.ts"), past = new Date(Date.now() - 3_600_000); // older than the index: no racy-git recheck
    utimesSync(file, past, past);
    await t.run(t.worktree, "update-index", "--refresh");
    writeFileSync(file, readFileSync(file, "utf8").replace(/./, (c) => c === "x" ? "y" : "x")); // same length
    utimesSync(file, past, past);
    expect(await t.run(t.worktree, "status", "--porcelain")).toBe("");
    expect((await t.run(t.worktree, "ls-files", "-v")).split("\n").every((l) => l.startsWith("H "))).toBe(true);
    expect(await t.aside()).toBeNull();
  });

  test("[验收线 5] a new path left by an earlier try never stands in for the old tree's proof: an edit or a commit of its own there waits as today", async () => {
    const edits = await oldTree();
    mkdirSync(`${edits.worktree}-r2`);
    writeFileSync(join(edits.worktree, "a.ts"), "edited\n");
    expect(await edits.aside()).toBeNull();
    const own = await oldTree();
    mkdirSync(`${own.worktree}-r2`);
    writeFileSync(join(own.worktree, "a.ts"), "mine\n");
    await own.run(own.worktree, "commit", "-q", "-am", "mine");
    expect(await own.aside()).toBeNull();
  });

  test("[验收线 5] an unreadable branch (symbolic-ref fails) or a detached HEAD is not proof of another branch", async () => {
    const t = await oldTree();
    expect(await staleTreeAside(async (args) => args.includes("symbolic-ref") ? { code: 128, out: "fatal" } : git(args), t.plan, t.owner, "-r2")).toBeNull();
    await t.run(t.worktree, "checkout", "-q", "--detach");
    expect(await t.aside()).toBeNull();
  });
});
