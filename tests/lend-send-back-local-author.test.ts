/**
 * SENDBACK1: a write order sent back to local work (peer never started a worker / nobody claimed it in time) restores the card's
 * assignee from the lease and drops the auto-start pin on that peer, so the scheduler's local author is written back instead of
 * ending as an unknown intent. The pin goes only when the ledger's grant for that peer is gone (revoked / expired / no longer
 * write or this repo); under a live grant, not_started and the pool timeout both keep it so the order is re-offered there (ADV-1/1c).
 * Fixture: the scheduler-local-author.test.ts shape with start_node pinned to peer:Sekai.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unknownQuota } from "../src/lib/ai-quota.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runStart, type StepIO } from "../src/lib/dag-tools-steps.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { claimLend, leaseLend, listLendOrders, offerLendCore, reclaimLend, sweepLend, WRITE_POOL_TTL_MS } from "../src/lib/ledger-lend.js";
import { getWriteLease } from "../src/lib/ledger-lend-lease.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { readRegistryAgentsSync } from "../src/lib/registry.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { readSchedulerConfig, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { ensureLocalAuthor, type LocalAuthorEnv } from "../src/lib/scheduler-local-author.js";
import { writeLocalAuthor } from "../src/lib/scheduler-local-author-write.js";
import { clearQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { runLedger } from "../src/manager/ledger.js";

const FP = "abcd-ef01-2345-6789", WORKER = `${FP}/agent-lend-0123456789`;
const cleanups: (() => void)[] = [];
afterEach(() => { clearQueuedLocalStarts(); for (const close of cleanups.splice(0)) close(); });

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
  return { db, clock, tick, hello, lend, claim, notStarted, sendBackNote, task: () => getTask(db, "ap-a")! };
}

type Fixture = Awaited<ReturnType<typeof pinned>>;
const notStartedPath = (f: Fixture, orderId: string) => { f.claim(orderId); f.notStarted(orderId); };
const timeoutPath = (f: Fixture) => { f.clock.now += WRITE_POOL_TTL_MS + 1; sweepLend(f.db, { actor: "owner", now: f.clock.now }); };
const PATHS: [string, (f: Fixture, orderId: string) => void][] = [
  ["the peer never started a worker", notStartedPath],
  ["nobody claimed it within the pool timeout", (f) => timeoutPath(f)],
];
/** The ledger fact sendBack reads (lend_peers.grant): revoked = set to NULL as markRevoked does; expired = until already passed. */
const GRANT_GONE: [string, (f: Fixture) => void][] = [
  ["revoked", (f) => f.db.run("UPDATE lend_peers SET grant = NULL WHERE peer = 'Sekai'")],
  ["expired", (f) => f.db.run("UPDATE lend_peers SET grant = json_set(grant, '$.until', ?) WHERE peer = 'Sekai'", [f.clock.now])],
];

for (const [why, sendBack] of PATHS) for (const [gone, dropGrant] of GRANT_GONE) {
  test(`sent back because ${why}, grant ${gone}: assignee restored, pin dropped, the local author is written back`, async () => {
    const f = await pinned();
    expect((await f.tick()).step).toBe("stage");
    const extraBefore = { ...f.task().extra };
    expect(extraBefore.placement).toBe("peer:Sekai");
    const orderId = f.lend();
    if (why.includes("never started")) f.claim(orderId);
    dropGrant(f);
    if (why.includes("never started")) f.notStarted(orderId); else sendBack(f, orderId);
    expect(listLendOrders(f.db, "ap-a")[0]!.orderId).toBe(orderId);
    expect(getWriteLease(f.db, "ap-a")).toMatchObject({ state: "ended" });
    expect(f.task()).toMatchObject({ assigneeKind: null, assignee: null, agent: null });
    const { placement: _gone, ...kept } = extraBefore;
    expect(JSON.stringify(f.task().extra)).toBe(JSON.stringify(kept));
    const notes = f.sendBackNote();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("写租约结束，退回本机");
    expect(notes[0]!.data.lend).toMatchObject({ restored: { assigneeKind: null, assignee: null }, unpinned: "peer:Sekai" });
    f.hello(true);
    expect((await f.tick()).step).toBe("session");
    expect(f.task()).toMatchObject({ agent: "agent-task-ap-a", assigneeKind: "agent", assignee: "agent-task-ap-a" });
    expect(f.db.query("SELECT count(*) AS n FROM scheduler_intents WHERE status = 'unknown'").get()).toEqual({ n: 0 });
  });
}

for (const [why, sendBack] of PATHS) {
  test(`sent back because ${why} under a live grant: assignee restored, the pin stays for the re-offer`, async () => {
    const f = await pinned();
    await f.tick();
    const extra = JSON.stringify(f.task().extra);
    const orderId = f.lend();
    sendBack(f, orderId);
    expect(getWriteLease(f.db, "ap-a")).toMatchObject({ state: "ended" });
    expect(f.task()).toMatchObject({ assigneeKind: null, assignee: null });
    expect(JSON.stringify(f.task().extra)).toBe(extra);
    expect(f.sendBackNote()[0]!.data.lend).toMatchObject({ restored: { assigneeKind: null, assignee: null }, unpinned: null });
  });
}

test("a grant that no longer covers write or this repo counts as gone", async () => {
  for (const patch of [`json_set(grant, '$.roles', json('["review"]'))`, `json_set(grant, '$.repos', json('["o/other"]'))`]) {
    const f = await pinned();
    await f.tick();
    const orderId = f.lend();
    f.claim(orderId);
    f.db.run(`UPDATE lend_peers SET grant = ${patch} WHERE peer = 'Sekai'`);
    f.notStarted(orderId);
    expect(f.task().extra).not.toHaveProperty("placement");
    expect(f.sendBackNote()[0]!.data.lend).toMatchObject({ unpinned: "peer:Sekai" });
  }
});

test("a local agent recorded before lending comes back as that agent", async () => {
  const f = await pinned();
  await f.tick();
  f.db.query("UPDATE tasks SET agent = 'agent-dev', assigneeKind = 'agent', assignee = 'agent-dev' WHERE id = 'ap-a'").run();
  const orderId = f.lend();
  f.claim(orderId); f.notStarted(orderId);
  expect(f.task()).toMatchObject({ agent: "agent-dev", assigneeKind: "agent", assignee: "agent-dev" });
  expect(f.sendBackNote()[0]!.data.lend).toMatchObject({ restored: { assigneeKind: "agent", assignee: "agent-dev" } });
});

test("assignee changed in between (PM picked someone) stays; pins on another peer or local stay", async () => {
  const f = await pinned();
  await f.tick();
  const orderId = f.lend({ kind: "agent", who: "pm-choice" });
  f.db.query("UPDATE tasks SET agent = 'pm-choice', extra = json_set(extra, '$.placement', 'peer:Other') WHERE id = 'ap-a'").run();
  const extra = JSON.stringify(f.task().extra);
  f.claim(orderId); f.notStarted(orderId);
  expect(f.task()).toMatchObject({ agent: "pm-choice", assigneeKind: "agent", assignee: "pm-choice" });
  expect(JSON.stringify(f.task().extra)).toBe(extra);
  expect(f.sendBackNote()[0]!.data.lend).not.toHaveProperty("restored");

  const g = await pinned();
  await g.tick();
  g.db.query("UPDATE tasks SET extra = json_set(extra, '$.placement', 'local') WHERE id = 'ap-a'").run();
  const localExtra = JSON.stringify(g.task().extra), rev = g.task().rev;
  const second = g.lend({ kind: null, who: null });
  g.claim(second); g.notStarted(second);
  expect(JSON.stringify(g.task().extra)).toBe(localExtra);
  expect(g.task().rev).toBe(rev + 1); // only the fixture's own assignee write; send-back patched nothing
});

test("PM reclaim still restores the assignee and leaves the pin (unchanged behaviour)", async () => {
  const f = await pinned();
  await f.tick();
  f.claim(f.lend());
  const r = reclaimLend(f.db, { actor: "pm", now: ++f.clock.now }, { taskId: "ap-a", reason: "对方太慢" });
  expect(r.cancelled).toBeTruthy();
  expect(f.task()).toMatchObject({ assigneeKind: null, assignee: null, extra: { placement: "peer:Sekai" } });
});
