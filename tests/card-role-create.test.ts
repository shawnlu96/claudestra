/**
 * ROLE1: the card role definition really reaches the three formal create entries. Real createReviewer (autoTickDeps ensure), real
 * ensureLocalAuthor (scheduler tick) and real runLocalStart + runStart (start_node) over temp ledgers / registries. The `manager create`
 * child is a stand-in (no bridge / tmux / model): it parses the final argv with the real parser and builds the launch command with the
 * real Claude Code adapter the way cmdCreate does, so the assertions read the argv, the registry model and the command CC would get.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unknownQuota } from "../src/lib/ai-quota.js";
import { applyCardRole, CARD_DEFAULT_MODEL, CARD_ROLE_DIR, dutiesOf, loadCardRole, READ_ONLY_FLOOR, useCardRoleDir, type CardRole } from "../src/lib/card-role-definitions.js";
import { resolveDisallowed } from "../src/lib/claude-launch.js";
import { claudeCodeAdapter } from "../src/lib/runtimes/index.js";
import { preflightStart, type StartPlan } from "../src/lib/dag-tools-start.js";
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
import { ensureLocalAuthor, type LocalAuthorEnv } from "../src/lib/scheduler-local-author.js";
import { writeLocalAuthor } from "../src/lib/scheduler-local-author-write.js";
import { clearQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import { localAutostart, runLocalStart } from "../src/lib/scheduler-local-runtime-start.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { git } from "../src/lib/scheduler-review-worktree.js";
import { startPlacement } from "../src/lib/scheduler-placement-start.js";
import { runLedger } from "../src/manager/ledger.js";
import { parseCreateArgs } from "../src/manager/create-args.js";
import { autoFixture, toBuild } from "./scheduler-auto-helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => { useCardRoleDir(); clearQueuedLocalStarts(); for (const c of cleanups.splice(0)) c(); });

const CAPACITY = { ok: false, cleanedUp: true, error: "Selected model is at capacity.\n（已清理：窗口已关；频道已删；占位已删）" };

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The repo's definitions with one file broken (or removed): the production entries then read this dir. */
function brokenDefs(file: string, edit: (md: string) => string | null): void {
  const dir = tmp("role1-broken-");
  for (const role of ["author", "reviewer", "adversarial-reviewer", "pm-reviewer"]) {
    const md = readFileSync(join(CARD_ROLE_DIR, `card-${role}.md`), "utf8");
    const out = `card-${role}.md` === file ? edit(md) : md;
    if (out !== null) writeFileSync(join(dir, `card-${role}.md`), out);
  }
  useCardRoleDir(dir);
}

/** The command cmdCreate hands tmux for this parsed create (same LaunchSpec fields, real claude-code adapter). */
function launchOf(args: string[]): string {
  const c = parseCreateArgs(args.slice(1));
  if ("error" in c) throw new Error(c.error);
  return claudeCodeAdapter.buildLaunchCommand({ mode: "new", channelId: "c1", bridgeUrl: "ws://127.0.0.1:9", sessionId: "s", agentName: c.name, cwd: c.dir,
    purpose: c.purpose, model: c.model, effort: c.effort, permissionMode: c.mode ?? "bypassPermissions", extras: { disallowedPreset: c.perms.preset, disallowedRaw: c.perms.disallowedRaw } });
}

/** One shell word after `flag` in a launch command (POSIX single quotes undone). */
function launchArg(cmd: string, flag: string): string | undefined {
  const at = cmd.indexOf(` ${flag} `);
  if (at < 0) return undefined;
  let out = "", i = at + flag.length + 2;
  while (i < cmd.length && cmd[i] !== " ") {
    if (cmd[i] === "'") { const end = cmd.indexOf("'", i + 1); out += cmd.slice(i + 1, end); i = end + 1; } else if (cmd[i] === "\\") { out += cmd[i + 1]; i += 2; } else out += cmd[i++];
  }
  return out;
}

/** What `manager create` would do with this argv: parse it for real, return the registry row it would save and the CC launch command. */
function managerRow(args: string[], sessionId: string): Record<string, unknown> {
  const c = parseCreateArgs(args.slice(1));
  if ("error" in c) throw new Error(c.error);
  const codex = c.runtimeFlag === "codex";
  return { cwd: c.dir, projectId: c.projectFlag, sessionId, status: "active", runtime: codex ? "codex" : "claude-code", transport: codex ? "acp" : "tmux",
    ...(c.model ? { model: c.model } : {}), purpose: c.purpose, disallowed: c.perms.disallowedRaw ?? null, ...(codex ? {} : { launch: launchOf(args) }) };
}

/** The launched session's model, hard tool list and system prompt carry the role definition in full. */
function expectLaunched(row: Record<string, unknown> | undefined, role: CardRole): void {
  const def = loadCardRole(role);
  if ("error" in def) throw new Error(def.error);
  const cmd = String(row?.launch);
  expect(launchArg(cmd, "--model")).toBe(CARD_DEFAULT_MODEL);
  expect(launchArg(cmd, "--append-system-prompt")).toContain(dutiesOf(def));
  const tools = launchArg(cmd, "--disallowedTools")!.split(" ");
  if (def.readOnly) expect(tools).toEqual(expect.arrayContaining([...READ_ONLY_FLOOR]));
  else expect(tools).not.toContain("Bash");
}

const flagOf = (args: string[], flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };

async function gitRepo(dir: string): Promise<string> {
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const run = async (...args: string[]) => {
    const r = await git(["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    if (r.code !== 0) throw new Error(r.out);
    return r.out;
  };
  await run("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "one\n");
  await run("add", ".");
  await run("commit", "-q", "-m", "one");
  await run("remote", "add", "origin", repo);
  await run("fetch", "-q", "origin");
  return repo;
}

// ── scheduler-auto-deps createReviewer ─────────────────────────────────────────────────────────────────────────────

async function reviewerFixture(authorFamily: "claude" | "codex", results: Record<string, unknown>[] = []) {
  const f = autoFixture();
  const root = tmp("role1-rv-");
  cleanups.push(() => f.close());
  const repo = await gitRepo(root);
  const head = (await git(["-C", repo, "rev-parse", "HEAD"])).out.trim();
  await toBuild(f);
  await f.tick();
  expect((await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", head)).ok).toBe(true);
  f.db.query("UPDATE task_workflows SET authorFamily = ? WHERE taskId = 'T1'").run(authorFamily);
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-task-one"].cwd = repo;
  if (authorFamily === "codex") reg.agents["agent-task-one"].runtime = "codex";
  delete reg.agents["agent-rv-t1"];
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const creates: string[][] = [];
  const d = autoTickDeps(f.db, { registryPath: f.registryPath, worktreeRoot: join(root, "wt"), create: async (...args) => {
    creates.push(args);
    const scripted = results[creates.length - 1];
    if (scripted) return scripted;
    const r = JSON.parse(readFileSync(f.registryPath, "utf8"));
    r.agents[args[1]] = managerRow(args, `s-rv${creates.length}`);
    writeFileSync(f.registryPath, JSON.stringify(r));
    return { ok: true, agent: args[1] };
  } });
  f.tickDeps.ensure = d.ensure;
  const row = () => readRegistryAgentsSync(f.registryPath).find((a) => a.name === "agent-rv-t1") as Record<string, unknown> | undefined;
  const ensureIntent = () => f.db.query("SELECT action, status, receipt FROM scheduler_intents WHERE action = 'ensure_session' ORDER BY eventSeq DESC LIMIT 1").get();
  return { f, creates, row, ensureIntent };
}

describe("createReviewer (scheduler-auto-deps)", () => {
  test("a Claude reviewer for a Codex author: argv carries the definition's model, hard read-only list and duties; registry model matches", async () => {
    const { f, creates, row } = await reviewerFixture("codex");
    await f.tick();
    expect(creates).toHaveLength(1);
    const args = creates[0];
    expect(flagOf(args, "--card-role")).toBe("reviewer");
    expect(flagOf(args, "--model")).toBe(CARD_DEFAULT_MODEL);
    expect(args).not.toContain("--runtime");
    expect(resolveDisallowed({ raw: flagOf(args, "--disallowed") })).toEqual(expect.arrayContaining([...READ_ONLY_FLOOR]));
    expect(flagOf(args, "--purpose")).toContain("【卡片角色 card-reviewer】");
    expect(row()).toMatchObject({ model: CARD_DEFAULT_MODEL, runtime: "claude-code" });
    expectLaunched(JSON.parse(readFileSync(f.registryPath, "utf8")).agents["agent-rv-t1"], "reviewer");
  });

  test("a Codex reviewer for a Claude author: argv exactly as before (no Claude model, no Claude tool list)", async () => {
    const { f, creates, row } = await reviewerFixture("claude");
    await f.tick();
    expect(creates).toHaveLength(1);
    expect(creates[0].slice(-4)).toEqual(["--runtime", "codex", "--transport", "acp"]);
    expect(creates[0]).not.toContain("--model");
    expect(creates[0]).not.toContain("--disallowed");
    expect(flagOf(creates[0], "--purpose")).toBe("T1 跨模型对抗式审查（调度引擎建）");
    expect(row()?.model).toBeUndefined();
  });

  test("a clean create failure and its retry both carry the model (repeated create)", async () => {
    const { f, creates, row } = await reviewerFixture("codex", [CAPACITY]);
    expect((await f.tick()).step).toBe("waiting");
    f.advance(10 * 60_000);
    await f.tick();
    expect(creates).toHaveLength(2);
    for (const c of creates) expect(flagOf(c, "--model")).toBe(CARD_DEFAULT_MODEL);
    expect(row()?.model).toBe(CARD_DEFAULT_MODEL);
  });

  test("a registration failure reported by manager create passes back unchanged and is not retried as a new create", async () => {
    const { f, creates, ensureIntent } = await reviewerFixture("codex", [{ ok: false, error: "台账已预留登记，但 registry 里已不是本次建的会话（留给 PM）" }]);
    await f.tick();
    expect(creates).toHaveLength(1);
    expect(flagOf(creates[0], "--model")).toBe(CARD_DEFAULT_MODEL);
    expect(ensureIntent()).toMatchObject({ action: "ensure_session", status: "unknown", receipt: expect.stringContaining("台账已预留登记") });
  });

  test("lease lost inside manager create stops the service (no PM escalation), with the model already on the argv", async () => {
    const { f, creates } = await reviewerFixture("codex", [{ ok: false, code: "lease-lost", error: "lease gone" }]);
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps).catch((e: Error) => e);
    expect(r).toBeInstanceOf(SchedulerStopped);
    expect((r as Error).message).toBe("manager create: lease gone");
    expect(creates).toHaveLength(1);
    expect(flagOf(creates[0], "--model")).toBe(CARD_DEFAULT_MODEL);
    expect(f.notices).toEqual([]);
  });

  for (const [what, edit] of [["missing", () => null], ["corrupt model", (md: string) => md.replace("model: claude-opus-5-5", "model: fable")]] as const) {
    test(`reviewer definition ${what}: no create, the intent is held with the diagnosis`, async () => {
      const { f, creates, row, ensureIntent } = await reviewerFixture("codex");
      brokenDefs("card-reviewer.md", edit);
      await f.tick();
      expect(creates).toEqual([]);
      expect(row()).toBeUndefined();
      expect(ensureIntent()).toMatchObject({ action: "ensure_session", status: "unknown", receipt: expect.stringContaining("没有建会话") });
    });
  }
});

// ── scheduler-local-author ensureLocalAuthor ───────────────────────────────────────────────────────────────────────

async function authorFixture(runtime: "claude" | "codex") {
  const dir = tmp("role1-author-"), dbPath = join(dir, "ledger.sqlite"), db = openLedger(dbPath);
  cleanups.push(() => closeLedger(dbPath));
  const repo = await gitRepo(dir);
  const ledgerDir = join(dir, "ledger"), worktreeRoot = join(dir, "wt");
  mkdirSync(join(ledgerDir, "docs", "tasks"), { recursive: true });
  writeFileSync(join(ledgerDir, "docs", "tasks", "ap-a.md"), "# specification\n模板:code\n");
  const registryPath = join(dir, "registry.json"), configPath = join(dir, "scheduler.json"), projectsPath = join(dir, "projects.json");
  const agents: Record<string, object> = {};
  const saveRegistry = () => writeFileSync(registryPath, JSON.stringify({ agents })); saveRegistry();
  const remote: RemotePolicy = { mode: "balance", roles: ["write", "review"], repo: "o/r", poolTimeoutMin: 15 };
  writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: repo, localAuthorRuntime: runtime, remote } } }));
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
  const creates: string[][] = [];
  let scripted: Record<string, unknown> | null = null;
  const env: LocalAuthorEnv = { db, registryPath, worktreeRoot, registryRow: (name) => readRegistryAgentsSync(registryPath).find((r) => r.name === name),
    active: () => {}, git,
    create: async (...args) => {
      creates.push(args);
      if (scripted) return scripted;
      agents[`agent-${args[1]}`] = { ...managerRow(args, "s-author"), task: "ap-a" };
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
    ensure: (task, role, family) => task.agent ? normal.ensure(task, role, family) : ensureLocalAuthor(env, task, options),
    notifyPm: async () => {} };
  const tick = async () => (await schedulerAutoTick(db, readSchedulerConfig(configPath).projects, deps));
  const intents = () => db.query("SELECT status, receipt FROM scheduler_intents WHERE action = 'ensure_session' ORDER BY eventSeq")
    .all() as { status: string; receipt: string | null }[];
  return { tick, hello, creates, intents, task: () => getTask(db, "ap-a")!, row: () => agents["agent-task-ap-a"] as Record<string, unknown> | undefined,
    script: (r: Record<string, unknown> | null) => { scripted = r; } };
}

describe("ensureLocalAuthor (scheduler-local-author)", () => {
  test("a Claude local author: argv carries --model claude-opus-5-5 and author duties, no read-only list; registry model matches; card bound", async () => {
    const f = await authorFixture("claude");
    f.hello(true);
    await f.tick();
    expect((await f.tick()).cards[0].step).toBe("session");
    expect(f.creates).toHaveLength(1);
    const args = f.creates[0];
    expect(flagOf(args, "--card-role")).toBe("author");
    expect(flagOf(args, "--model")).toBe(CARD_DEFAULT_MODEL);
    expect(flagOf(args, "--effort")).toBe("high");
    expect(args).not.toContain("--disallowed");
    expect(flagOf(args, "--purpose")).toContain("【卡片角色 card-author】");
    expect(f.row()).toMatchObject({ model: CARD_DEFAULT_MODEL, runtime: "claude-code" });
    expectLaunched(f.row(), "author");
    expect(f.task().agent).toBe("agent-task-ap-a");
  });

  test("a Codex local author keeps its own argv (no Claude model)", async () => {
    const f = await authorFixture("codex");
    f.hello(true);
    await f.tick();
    await f.tick();
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0].slice(-4)).toEqual(["--runtime", "codex", "--transport", "acp"]);
    expect(f.creates[0]).not.toContain("--model");
    expect(f.row()?.model).toBeUndefined();
  });

  test("lease lost inside manager create: nothing bound, the argv still carried the model", async () => {
    const f = await authorFixture("claude");
    f.hello(true);
    await f.tick();
    f.script({ ok: false, code: "lease-lost", error: "lease gone" });
    const r = await f.tick().catch((e: Error) => e);
    expect(r).toBeInstanceOf(SchedulerStopped);
    expect((r as Error).message).toBe("lease gone");
    expect(f.creates).toHaveLength(1);
    expect(flagOf(f.creates[0], "--model")).toBe(CARD_DEFAULT_MODEL);
    expect(f.task().agent).toBeNull();
  });

  for (const [what, edit] of [["missing", () => null], ["model removed", (md: string) => md.replace("model: claude-opus-5-5\n", "")],
    ["card-role mismatch", (md: string) => md.replace("card-role: author", "card-role: reviewer")]] as const) {
    test(`author definition ${what}: no create, card not bound, the diagnosis is on the intent`, async () => {
      const f = await authorFixture("claude");
      brokenDefs("card-author.md", edit);
      f.hello(true);
      await f.tick();
      await f.tick();
      expect(f.creates).toEqual([]);
      expect(f.task().agent).toBeNull();
      expect(f.intents().at(-1)).toMatchObject({ status: "unknown", receipt: expect.stringContaining("没有建会话") });
    });
  }
});

// ── scheduler-local-runtime-start runLocalStart (start_node: real runStart steps) ─────────────────────────────────

function startFixture(runtime?: "claude" | "codex") {
  const dir = tmp("role1-start-"), ledgerPath = join(dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  cleanups.push(() => closeLedger(ledgerPath));
  const configPath = join(dir, "scheduler.json"), registryPath = join(dir, "registry.json");
  writeFileSync(configPath, JSON.stringify({ enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: dir,
    ...(runtime ? { localAuthorRuntime: runtime } : {}) } } }));
  writeFileSync(registryPath, JSON.stringify({ agents: {} }));
  const opts = { configPath, registryPath, lockPath: join(dir, "codex.lock"), ledgerPath, codexQuota: async () => unknownQuota("test") };
  const plan = { project: "p", taskId: "T", peer: null, feature: { id: "F" }, key: "one", title: "test", item: null, pm: "pm", base: "main", branch: "feat/test",
    repo: dir, worktree: join(dir, "worktree"), agentName: "task-t", agent: "agent-task-t", fileGlobs: ["src/x.ts"],
    specPath: join(dir, "spec.md"), specText: null, promptPath: join(dir, "prompt.md"), promptText: "work", purpose: "T 作者" } as unknown as StartPlan;
  const calls: string[][] = [];
  let createResult: ((args: string[]) => Record<string, unknown>) | null = null;
  const io: StepIO = {
    db: () => db,
    manager: async (args) => {
      calls.push(args);
      if (args[0] !== "create") return { ok: true };
      if (createResult) return createResult(args);
      const reg = JSON.parse(readFileSync(registryPath, "utf8"));
      reg.agents[`agent-${args[1]}`] = managerRow(args, "s-start");
      writeFileSync(registryPath, JSON.stringify(reg));
      return { ok: true, agent: `agent-${args[1]}` };
    },
    git: async (_cwd, args) => ({ ok: true, out: args[0] === "rev-parse" && args.includes("main^{commit}") ? "a".repeat(40) : "" }),
    exists: () => false, read: () => null, write: () => {}, remove: () => {}, symlink: () => {}, agentExists: () => false, attempt: "probe",
  };
  const row = () => JSON.parse(readFileSync(registryPath, "utf8")).agents["agent-task-t"] as Record<string, unknown> | undefined;
  return { io, plan, opts, calls, row, onCreate: (fn: (args: string[]) => Record<string, unknown>) => { createResult = fn; } };
}

describe("runLocalStart + runStart (scheduler-local-runtime-start, start_node)", () => {
  for (const runtime of [undefined, "claude"] as const) {
    test(`Claude author (${runtime ?? "default"} config, no slot path): final create argv has the model; registry model matches`, async () => {
      const f = startFixture(runtime);
      expect((await runLocalStart(f.io, f.plan, runStart, f.opts)).ok).toBe(true);
      const creates = f.calls.filter((c) => c[0] === "create");
      expect(creates).toHaveLength(1);
      expect(flagOf(creates[0], "--card-role")).toBe("author");
      expect(flagOf(creates[0], "--model")).toBe(CARD_DEFAULT_MODEL);
      expect(flagOf(creates[0], "--purpose")).toStartWith("T 作者\n\n【卡片角色 card-author】");
      expect(f.row()).toMatchObject({ model: CARD_DEFAULT_MODEL });
      expectLaunched(f.row(), "author");
      expect(f.calls.filter((c) => c[0] !== "create").every((c) => !c.includes("--model"))).toBe(true); // ledger steps untouched
    });
  }

  for (const runtime of ["codex", "claude"] as const) test(`autostart (localAutostart pins ${runtime}) → runStart: model only for Claude`, async () => {
    const f = startFixture(runtime);
    let out: Awaited<ReturnType<typeof runStart>> | undefined;
    await localAutostart("p", async () => { out = await runStart(f.io, f.plan); }, f.opts);
    expect(out?.ok).toBe(true);
    if (runtime === "claude") { expect(flagOf(f.calls.find((c) => c[0] === "create")!, "--model")).toBe(CARD_DEFAULT_MODEL); return; }
    const create = f.calls.find((c) => c[0] === "create")!;
    expect(create.slice(-4)).toEqual(["--runtime", "codex", "--transport", "acp"]);
    expect(create).not.toContain("--model");
  });

  test("an explicit model on the create is kept", async () => {
    const f = startFixture("claude");
    const run: typeof runStart = async (io, p) => { await io.manager(["create", "task-t", "/w", "--card", "T", "--card-role", "author", "--model", "claude-sonnet-5"]); return runStart(io, p); };
    await runLocalStart(f.io, f.plan, run, f.opts);
    expect(flagOf(f.calls[0], "--model")).toBe("claude-sonnet-5");
    expect(f.calls[0].filter((a) => a === "--model")).toHaveLength(1);
  });

  test("author definition corrupt: the create never reaches manager and start_node rolls back as a failed agent step", async () => {
    const f = startFixture("claude");
    brokenDefs("card-author.md", (md) => md.replace(/^---\n/, ""));
    const r = await runLocalStart(f.io, f.plan, runStart, f.opts);
    expect(r).toMatchObject({ ok: false, failedStep: "agent" });
    expect(String((r as { error: string }).error)).toContain("没有建会话");
    expect(f.calls.filter((c) => c[0] === "create")).toEqual([]);
    expect(f.row()).toBeUndefined();
  });

  test("a registration failure from manager create is handed back as is (same argv once, no second create)", async () => {
    const f = startFixture("claude");
    f.onCreate(() => ({ ok: false, error: "台账已预留登记，但 worker 标签没打（留给 PM）" }));
    const r = await runLocalStart(f.io, f.plan, runStart, f.opts);
    expect(r).toMatchObject({ ok: false });
    const creates = f.calls.filter((c) => c[0] === "create");
    expect(creates).toHaveLength(1);
    expect(flagOf(creates[0], "--model")).toBe(CARD_DEFAULT_MODEL);
  });
});

// ── the launched command for every role ─────────────────────────────────────────────────────────────────────────────

describe("final launch command (real parser + real Claude Code adapter)", () => {
  const base = (cardRole: string, purpose: string) => ["create", "agent-x", "/wt/x", "--purpose", purpose, "--project", "p", "--card", "T1", "--card-role", cardRole];
  const shapes: [CardRole, string][] = [["author", "author"], ["reviewer", "reviewer"], ["adversarial-reviewer", "reviewer"], ["pm-reviewer", "other"]];
  const longTitle = `T1 执行者（自动卡）：${"很长的标题".repeat(40)}。先读 /Users/someone/.claude-orchestrator/ledger/reviews/T1-exec-prompt.md`;
  for (const [role, cardRole] of shapes) {
    for (const [what, purpose] of [["short purpose", "T1 审查"], ["500-char purpose", "x".repeat(500)], ["start_node purpose with a long title", longTitle]] as const) {
      test(`${role}, ${what}: model, read-only boundary and the whole duties reach the launch`, () => {
        const r = applyCardRole(base(cardRole, purpose), { role });
        if ("error" in r) throw new Error(r.error);
        expectLaunched({ launch: launchOf(r.args) }, role);
        expect(launchArg(launchOf(r.args), "--append-system-prompt")).toContain(purpose.slice(0, 40));
      });
    }
  }

  // 复现 purpose-pointer-truncation：生产 purpose 公式（dag-tools-start / scheduler-local-author-plan）+ 合法长标题，执行说明路径不能被职责预算裁掉
  test("a long title is shortened but the exec-prompt pointer after 先读 reaches the launch whole, for every role", () => {
    const promptPath = "/Users/someone/.claude-orchestrator/ledger/reviews/agent-list-recovery-ROLE1-exec-prompt.md";
    for (const title of ["title".repeat(22), "很长的标题".repeat(60)]) {
      const purpose = `agent-list-recovery-ROLE1 执行者（自动卡）：${title}。先读 ${promptPath}`;
      for (const [role, cardRole] of shapes) {
        const r = applyCardRole(base(cardRole, purpose), { role });
        if ("error" in r) throw new Error(r.error);
        const registered = flagOf(r.args, "--purpose") ?? "";
        expect(registered).toStartWith(`agent-list-recovery-ROLE1 执行者（自动卡）：${title.slice(0, 5)}`);
        if (title.length > 200) expect(registered).toContain("…。先读");
        expect(registered).toContain(`。先读 ${promptPath}\n\n【卡片角色 card-${role}】`);
        expect(launchArg(launchOf(r.args), "--append-system-prompt")).toContain(`先读 ${promptPath}`);
        expectLaunched({ launch: launchOf(r.args) }, role);
      }
    }
  });

  test("a trailing pointer that cannot fit next to the duties is a diagnosis and no create, not a silent cut", () => {
    const purpose = `T1 执行者（自动卡）：标题。先读 /${"p".repeat(300)}/exec-prompt.md`;
    expect(applyCardRole(base("author", purpose), {})).toEqual({ error: expect.stringContaining("截了就丢指针") });
  });

  test("the registered purpose keeps the caller's head; a blank explicit model never reaches the launcher", () => {
    const r = applyCardRole(base("reviewer", "T1 审查"), {});
    if ("error" in r) throw new Error(r.error);
    expect(flagOf(r.args, "--purpose")).toStartWith("T1 审查\n\n【卡片角色 card-reviewer】");
    expect(applyCardRole([...base("reviewer", "T1"), "--model", " "], {})).toEqual({ error: expect.stringContaining("无效的 --model") });
  });
});
