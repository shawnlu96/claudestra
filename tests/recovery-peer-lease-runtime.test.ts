/**
 * dispatch-recovery-PEERLEASE1 · the handover's frozen runtime reaches the real local author creation (scheduler-local-author.ts launch,
 * `rebuild?.family ?? handoverRuntime(env.db, task) ?? (pool / local choice)`). The agents pool here would pick Claude (a free Claude
 * seat); the handover froze Codex. on: Codex is created, waits for a Codex seat, and the registry receipt is checked against Codex;
 * off / observe, or a delivery since the handover: the pool's own choice, byte-for-byte the old line. [验收线 3] [验收线 5] [验收线 7]
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unknownQuota } from "../src/lib/ai-quota.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runStart, type StepIO } from "../src/lib/dag-tools-steps.js";
import { claimNode, settleClaim } from "../src/lib/ledger-autostart.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { setPeerLeasePorts } from "../src/lib/recovery-peer-lease.js";
import { PEER_HANDOVER_OP } from "../src/lib/recovery-peer-lease-family.js";
import { handoverRuntime } from "../src/lib/recovery-peer-lease-runtime.js";
import { readRegistryAgentsSync } from "../src/lib/registry.js";
import { autoTickDeps } from "../src/lib/scheduler-auto-deps.js";
import { schedulerAutoTick, type AutoTickDeps } from "../src/lib/scheduler-auto-tick.js";
import { readSchedulerConfig, type RemotePolicy } from "../src/lib/scheduler-config.js";
import { ensureLocalAuthor, type LocalAuthorEnv } from "../src/lib/scheduler-local-author.js";
import { writeLocalAuthor } from "../src/lib/scheduler-local-author-write.js";
import { clearQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import { getSchedulerSession } from "../src/lib/scheduler-sessions.js";
import { runLedger } from "../src/manager/ledger.js";

const H = "1".repeat(40);
const cleanups: (() => void)[] = [];
afterEach(() => { clearQueuedLocalStarts(); for (const close of cleanups.splice(0)) close(); });

type Opts = { mode: RecoveryMode; frozen?: "claude" | "codex"; seats?: { claude: number; codex: number }; registryRuntime?: "claude-code" | "codex" };

/** The local author fixture of tests/scheduler-local-author.test.ts with an agents pool; the card is presented to launch as a fix on H. */
async function fixture(o: Opts) {
  const dir = mkdtempSync(join(tmpdir(), "plr-")), dbPath = join(dir, "ledger.sqlite"), db = openLedger(dbPath);
  cleanups.push(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });
  const repo = join(dir, "repo"), ledgerDir = join(dir, "ledger"), worktreeRoot = join(dir, "wt");
  mkdirSync(join(repo, ".git"), { recursive: true }); mkdirSync(join(ledgerDir, "docs", "tasks"), { recursive: true });
  writeFileSync(join(ledgerDir, "docs", "tasks", "ap-a.md"), "# specification\n模板:code\n");
  const registryPath = join(dir, "registry.json"), configPath = join(dir, "scheduler.json"), projectsPath = join(dir, "projects.json");
  const agents: Record<string, object> = {};
  const saveRegistry = () => writeFileSync(registryPath, JSON.stringify({ agents })); saveRegistry();
  const remote: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: "o/r", poolTimeoutMin: 15 };
  const config = { enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: repo, localAuthorRuntime: "codex",
    remote, agents: o.seats ?? { claude: 2, codex: 1 } } } }; // the card's own planned seat takes one Claude: the pool still picks Claude
  writeFileSync(configPath, JSON.stringify(config)); writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", dirs: [repo] }] }));
  const options = { registryPath, configPath, projectsPath, lockPath: join(dir, "codex.lock"), codexQuota: async () => unknownQuota("test") };
  let now = 10_000;
  const ctx = { actor: "owner", now };
  db.run("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
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
  const { startPlacement } = await import("../src/lib/scheduler-placement-start.js");
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
  setPeerLeasePorts(db, { policy: () => ({ mode: o.mode, manualAfterMs: null, source: "config" }) });
  const creates: string[][] = [];
  const env: LocalAuthorEnv = { db, registryPath, worktreeRoot, registryRow: (name) => readRegistryAgentsSync(registryPath).find((r) => r.name === name),
    active: () => {},
    git: async (args) => {
      if (args.includes("rev-parse")) {
        if (args.at(-1)?.startsWith("refs/heads/")) return { code: 1, out: "absent" };
        if (args.at(-1) === "--absolute-git-dir") return { code: 0, out: join(dir, "worktree-git") };
        if ([`${H}^{commit}`, "origin/main^{commit}", "HEAD"].includes(args.at(-1)!)) return { code: 0, out: H };
        return { code: 128, out: "invalid base" };
      }
      if (args.includes("add")) mkdirSync(args.at(-2)!, { recursive: true });
      return { code: 0, out: "" };
    },
    create: async (...args) => {
      creates.push(args);
      const codex = args[args.indexOf("--runtime") + 1] === "codex" && args.includes("--runtime");
      agents[`agent-${args[1]}`] = { cwd: args[2], projectId: "p", task: "ap-a", sessionId: "s-author", runtime: o.registryRuntime ?? (codex ? "codex" : "claude-code"),
        transport: codex ? "acp" : "tmux", status: "active" }; saveRegistry(); return { ok: true };
    },
    ledger: async (...args) => {
      if (args[1] === "scheduler-autostart" && args[4].startsWith("local-author")) {
        const flags = Object.fromEntries(args.slice(7).map((x) => { const i = x.indexOf("="); return [x.slice(2, i), x.slice(i + 1)]; }));
        return db.transaction(() => writeLocalAuthor(db, { actor: "scheduler", now: ++now, dedupKey: flags.dedup },
          { claim: Number(args[3]), sub: args[4], pos: args.slice(5, 7), flags }, options)).immediate();
      }
      return cli("scheduler", args.slice(1));
    } };
  // The card as launch sees it at the takeover: a fix on H, with the handover recorded for its spec, round and head.
  const asFix = () => ({ ...getTask(db, "ap-a")!, stage: "fix" as const, headSHA: H });
  const handover = (runtime: "claude" | "codex") => db.transaction(() => insertEvent(db, { actor: "scheduler", now: ++now, dedupKey: `scheduler:peer-lease-handover:ap-a:sess-mate` }, {
    project: "p", target: "ap-a", kind: "scheduler", text: "peer 作者交接（测试）",
    data: { op: PEER_HANDOVER_OP, specRev: asFix().specRev, round: asFix().round, head: H, sessionId: "sess-mate", runtime } }, true)).immediate();
  if (o.frozen) handover(o.frozen);
  const results: unknown[] = [];
  const normal = autoTickDeps(db, { registryPath, worktreeRoot });
  const deps: AutoTickDeps = { ...normal, manager: env.ledger, borrow: async () => borrow, now: () => ++now,
    ensure: async (task, role, family) => {
      if (task.agent) return normal.ensure(task, role, family);
      const r = await ensureLocalAuthor(env, asFix(), options);
      results.push(r);
      return r;
    },
    notifyPm: async () => {},
    worker: () => ({ route: "acp", fallbackReason: null, ensure: async () => ({ kind: "unknown", reason: "unused" }),
      submit: async (_ref, key) => ({ status: "sent", route: "acp", messageKey: key, evidence: "mock" }),
      observe: async () => ({ state: "running", busy: false }), cancel: async () => ({ ok: true, evidence: "mock" }), archive: async () => ({ ok: true, evidence: "mock" }) }) };
  const tick = async () => {
    const r = await schedulerAutoTick(db, readSchedulerConfig(configPath).projects, deps);
    expect(r.failed).toEqual([]); return r.cards[0];
  };
  hello(true); // Sekai cools down: the author is placed here
  const seats = (agents: { claude: number; codex: number }) => { config.projects.p.agents = agents; writeFileSync(configPath, JSON.stringify(config)); };
  return { db, tick, creates, results, asFix, handover, seats, deliver: () => db.transaction(() => insertEvent(db, { actor: "owner", now: ++now }, {
    project: "p", target: "ap-a", kind: "deliver", text: "本机交付（测试）", data: { head: "2".repeat(40) } }, true)).immediate() };
}
type F = Awaited<ReturnType<typeof fixture>>;

const runUntilCreate = async (f: F) => { for (let i = 0; i < 3 && !f.results.length; i++) await f.tick(); };
const createdFamily = (f: F) => f.creates.map((a) => a.includes("--runtime") && a[a.indexOf("--runtime") + 1] === "codex" ? "codex" : "claude");

describe("peerLeaseRecovery · frozen runtime at local author creation", () => {
  test("[验收线 5] on, handover froze Codex while the pool would pick Claude: Codex is created and bound", async () => {
    const f = await fixture({ mode: "on", frozen: "codex" });
    expect(handoverRuntime(f.db, f.asFix())).toBe("codex");
    await runUntilCreate(f);
    expect(createdFamily(f)).toEqual(["codex"]);
    expect(f.creates[0].slice(-4)).toEqual(["--runtime", "codex", "--transport", "acp"]);
    expect(f.results[0]).toMatchObject({ kind: "ready", ref: { family: "codex" } });
    expect(getWorkflow(f.db, "ap-a")?.authorFamily).toBe("codex");
    expect(getSchedulerSession(f.db, "ap-a", "author")).toMatchObject({ family: "codex", transport: "acp" });
  });

  for (const mode of ["off", "observe"] as const) test(`[验收线 3] ${mode}: a recorded handover changes nothing — the pool's own Claude choice`, async () => {
    const f = await fixture({ mode, frozen: "codex" });
    expect(handoverRuntime(f.db, f.asFix())).toBeNull();
    await runUntilCreate(f);
    expect(createdFamily(f)).toEqual(["claude"]);
    expect(f.results[0]).toMatchObject({ kind: "ready", ref: { family: "claude" } });
  });

  test("[验收线 5] [验收线 7] on, no Codex seat: waits for Codex — never creates the other family", async () => {
    const f = await fixture({ mode: "on", frozen: "codex", seats: { claude: 2, codex: 0 } });
    await f.tick();
    await f.tick();
    await f.tick();
    expect(f.creates).toEqual([]);
    expect(f.results.length).toBeGreaterThan(0);
    expect(f.results.every((r) => (r as { kind: string }).kind === "wait")).toBe(true);
    expect(getSchedulerSession(f.db, "ap-a", "author")).toBeNull();
    // Claude seats stayed free all along; a Codex seat opening is what lets the frozen Codex author through.
    f.seats({ claude: 2, codex: 1 });
    for (let i = 0; i < 3 && !f.creates.length; i++) await f.tick();
    expect(createdFamily(f)).toEqual(["codex"]);
  });

  test("[验收线 5] on: the registry receipt is checked against the frozen runtime — a Claude session is not bound", async () => {
    const f = await fixture({ mode: "on", frozen: "codex", registryRuntime: "claude-code" });
    await runUntilCreate(f);
    expect(createdFamily(f)).toEqual(["codex"]);
    expect(f.results[0]).toMatchObject({ kind: "unknown", reason: expect.stringContaining("运行时不符") });
    expect(getSchedulerSession(f.db, "ap-a", "author")).toBeNull();
  });

  test("[验收线 6] on, a delivery since the handover: back to the original expression", async () => {
    const f = await fixture({ mode: "on", frozen: "codex" });
    f.deliver();
    expect(handoverRuntime(f.db, f.asFix())).toBeNull();
    await runUntilCreate(f);
    expect(createdFamily(f)).toEqual(["claude"]);
  });

  test("on: a handover of another head or round is not this card's", async () => {
    const f = await fixture({ mode: "on", frozen: "codex" });
    expect(handoverRuntime(f.db, { ...f.asFix(), headSHA: "9".repeat(40) })).toBeNull();
    expect(handoverRuntime(f.db, { ...f.asFix(), round: f.asFix().round + 1 })).toBeNull();
    expect(handoverRuntime(f.db, { ...f.asFix(), stage: "build" })).toBeNull();
  });
});
