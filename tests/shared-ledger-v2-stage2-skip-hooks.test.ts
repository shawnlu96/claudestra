/**
 * S2D2 · skip cards get zero side effects from the paths S2D's five hooks did not cover. Real step functions on a synthetic
 * temp ledger; `shared-ledger-modes.json` sits next to ledger.sqlite (where `schedulerV2Route` reads it). Each path has a
 * migrating card and an execution card (port null = off: skip), and an ordinary local card that still proceeds in the same run.
 * Old red: the same step acts on the skip card once the hook / mode is taken away.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE } from "../src/lib/agent-lifecycle-config.js";
import { ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { cardWorkerIndex, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle, type AgentFacts } from "../src/lib/agent-lifecycle.js";
import type { StepIO } from "../src/lib/dag-tools-steps.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { configureTakeoverSkip, lendTakeoverStep, TAKEOVER_AFTER_MS, type TakeoverGh } from "../src/lib/lend-pr-takeover.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { readLiveAgents, schedulerRetireTick, type RetireDeps } from "../src/lib/scheduler-retire.js";
import { configureSchedulerV2Pass } from "../src/lib/scheduler-v2-pass.js";
import { schedulerV2SkipAgent, schedulerV2SkipManager, schedulerV2SkipTask } from "../src/lib/scheduler-v2-skip.js";
import type { Registry } from "../src/manager/core.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import { runLedger } from "../src/manager/ledger.js";

type Reply = Record<string, unknown>;
const MIGRATING = { authorityMode: "planning", sharedPlanning: true, migrating: { batchId: "batch", kind: "execute" } };
const EXECUTION = { authorityMode: "execution", sharedPlanning: true };
const cleanups: (() => void)[] = [];
let info: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  configureSchedulerV2Pass(null);
  configureTakeoverSkip(schedulerV2SkipTask);
  info?.mockRestore(); info = null;
  while (cleanups.length) cleanups.pop()!();
});

/** A file ledger in a temp dir; `bindFeature` puts a card under a feature whose mode is written next to the ledger. */
function ledger(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix)), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanups.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  info = spyOn(console, "info").mockImplementation(() => {});
  const modes: Record<string, unknown> = {};
  const writeModes = () => writeFileSync(join(dir, "shared-ledger-modes.json"), JSON.stringify({ features: modes }));
  const feature = (id: string, project: string, mode: unknown) => {
    db.query("INSERT OR IGNORE INTO features (id,project,title,status,createdBy,createdAt,updatedAt) VALUES (?,?,?,'active','owner',1,1)").run(id, project, id);
    modes[id] = mode;
    writeModes();
  };
  const bindFeature = (taskId: string, featureId: string, project: string, mode: unknown) => {
    feature(featureId, project, mode);
    db.query("UPDATE tasks SET featureId = ? WHERE id = ?").run(featureId, taskId);
  };
  return { dir, path, db, modes, writeModes, feature, bindFeature };
}

describe("unified gate: schedulerV2SkipManager", () => {
  function gateFixture() {
    const l = ledger("s2d2-gate-");
    let now = 1000;
    for (const id of ["TM", "TE", "TL"]) createTask(l.db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code" });
    l.bindFeature("TM", "fM", "p", MIGRATING);
    l.bindFeature("TE", "fE", "p", EXECUTION);
    for (const id of ["TM", "TE", "TL"]) {
      l.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
        VALUES (?, ?, 'p', 'n', 'merge', 0, 1, 1, 2, 'submitted', 'test', 0, 0)`).run(`i-${id}`, id);
    }
    const calls: string[][] = [];
    const inner = async (...args: string[]): Promise<Reply> => { calls.push(args); return { ok: true }; };
    return { ...l, calls, gate: schedulerV2SkipManager(l.db, inner), inner };
  }

  test("non-ledger calls pass; db null returns the same manager", async () => {
    const f = gateFixture();
    expect(await f.gate("create", "TM")).toEqual({ ok: true });
    expect(f.calls).toEqual([["create", "TM"]]);
    expect(schedulerV2SkipManager(null, f.inner)).toBe(f.inner);
  });

  test("intent id of a migrating / execution card is held with v2_held; the local card's passes", async () => {
    const f = gateFixture();
    for (const id of ["TM", "TE"]) {
      const r = await f.gate("ledger", "scheduler-settle", `i-${id}`, "--from", "submitted", "--to", "done");
      expect(r).toMatchObject({ ok: false, code: "v2_held", held: true });
    }
    expect(f.calls).toEqual([]);
    expect(await f.gate("ledger", "scheduler-settle", "i-TL", "--from", "submitted", "--to", "done")).toEqual({ ok: true });
    expect(await f.gate("ledger", "scheduler-lock-yield", "TL", "--data", "{}")).toEqual({ ok: true });
    expect(f.calls).toHaveLength(2);
  });

  test("task id positional, --x=value and JSON --wire taskId are resolved", async () => {
    const f = gateFixture();
    expect(await f.gate("ledger", "scheduler-lock-yield", "TM", "--data", "{}")).toMatchObject({ code: "v2_held" });
    expect(await f.gate("ledger", "scheduler-autostart", "step", "x", `--intent=i-TE`)).toMatchObject({ code: "v2_held" });
    expect(await f.gate("ledger", "scheduler-worker-retire", "--wire", JSON.stringify({ agent: "a", taskId: "TE" }))).toMatchObject({ code: "v2_held" });
    expect(await f.gate("ledger", "scheduler-worker-retire", "--wire", JSON.stringify({ agent: "a", taskId: "TL" }))).toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
  });

  test("autostart claim on a migrating / execution feature is held; settle <claimSeq> resolves to the claim's feature", async () => {
    const f = gateFixture();
    f.feature("fL", "p", { authorityMode: "planning", sharedPlanning: true });
    for (const fid of ["fM", "fE"]) expect(await f.gate("ledger", "scheduler-autostart", "claim", fid, "a")).toMatchObject({ code: "v2_held" });
    expect(await f.gate("ledger", "scheduler-autostart", "claim", "fL", "a")).toEqual({ ok: true });
    const claim = (fid: string) => (f.db.query(`INSERT INTO events (ts,actor,project,target,kind,text,data) VALUES (1,'scheduler','p',?,'decision','',
      '{"op":"autostart_claim"}') RETURNING seq`).get(fid) as { seq: number }).seq;
    expect(await f.gate("ledger", "scheduler-autostart", "settle", String(claim("fM")), "--outcome", "done")).toMatchObject({ code: "v2_held" });
    expect(await f.gate("ledger", "scheduler-autostart", "settle", String(claim("fL")), "--outcome", "done")).toEqual({ ok: true });
    expect(f.calls).toHaveLength(2);
  });

  test("lend-takeover <orderId> resolves through lend_orders", async () => {
    const f = gateFixture();
    order(f.db, "o-TM", "TM", 0);
    order(f.db, "o-TL", "TL", 0);
    expect(await f.gate("ledger", "lend-takeover", "o-TM", "--head", "x", "--pr", "1")).toMatchObject({ code: "v2_held" });
    expect(await f.gate("ledger", "lend-takeover", "o-TL", "--head", "x", "--pr", "1")).toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
  });

  test("revocation is seen on the next call: execution rewritten to source passes", async () => {
    const f = gateFixture();
    expect(await f.gate("ledger", "scheduler-lock-yield", "TE")).toMatchObject({ code: "v2_held" });
    f.modes.fE = { authorityMode: "source", sharedPlanning: false };
    f.writeModes();
    expect(await f.gate("ledger", "scheduler-lock-yield", "TE")).toEqual({ ok: true });
    f.modes.fE = EXECUTION;
    f.writeModes();
    expect(await f.gate("ledger", "scheduler-lock-yield", "TE")).toMatchObject({ code: "v2_held" });
    expect(f.calls).toHaveLength(1);
  });
});

/** A write order of `taskId` lent out and stuck in publishing long enough to be taken over. */
function order(db: Database, orderId: string, taskId: string, now: number, branch = `lend/${taskId}`) {
  db.query(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, pr, wire, text, sha256, status, leaseMs,
    leaseUntil, createdBy, createdAt, updatedAt, branch, base, beat) VALUES (?, ?, 'p', 'mate', 'codex', 'write', 1, 0, ?, 'o/r', NULL, '{}', 't', 's',
    'claimed', 60000, ?, 'pm', 0, 0, ?, 'main', ?)`)
    .run(orderId, taskId, "b".repeat(40), now + 3_600_000, branch, JSON.stringify({ phase: "publishing", since: now - TAKEOVER_AFTER_MS - 1 }));
}

describe("lendTakeover: no gh read, PR or write for a skip card", () => {
  function fixture() {
    const l = ledger("s2d2-takeover-");
    for (const id of ["TM", "TE", "TL"]) createTask(l.db, { actor: "owner", now: 10 }, { project: "p", id, title: id, kind: "code" });
    l.bindFeature("TM", "fM", "p", MIGRATING);
    l.bindFeature("TE", "fE", "p", EXECUTION);
    const now = 10_000_000;
    for (const id of ["TM", "TE", "TL"]) order(l.db, `o-${id}`, id, now);
    const gh: string[] = [], writes: string[][] = [];
    const fake: TakeoverGh = {
      head: async (_r, branch) => (gh.push(`head ${branch}`), { ok: true, head: "c".repeat(40) }),
      compare: async () => (gh.push("compare"), { ok: true, value: "ahead" }),
      openPr: async () => (gh.push("openPr"), { ok: true, value: null }),
      createPr: async (p) => (gh.push(`create ${p.branch}`), { ok: true, value: 7 }),
    };
    const step = () => lendTakeoverStep(l.db, { gh: fake, now: () => now, seen: new Map(),
      manager: async (...a: string[]) => (writes.push(a), { ok: true }) });
    return { ...l, gh, writes, step };
  }

  test("migrating and execution cards: 0 gh, 0 manager; the local card's order still reads its branch", async () => {
    const f = fixture();
    expect((await f.step()).failed).toEqual([]);
    expect(f.gh).toEqual(["head lend/TL"]);
    expect(f.writes).toEqual([]);
  });

  test("old red: without the S2D2 hook the skip cards' branches are read", async () => {
    const f = fixture();
    configureTakeoverSkip(null);
    await f.step();
    expect(f.gh.sort()).toEqual(["head lend/TE", "head lend/TL", "head lend/TM"]);
  });
});

describe("lifecycle: a skip card counts as frozen", () => {
  test("ledgerFacts marks migrating / execution cards frozen; the planner retires only the local card's worker", () => {
    const l = ledger("s2d2-life-");
    l.db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]')").run();
    for (const id of ["TM", "TE", "TL"]) {
      createTask(l.db, { actor: "owner", now: 10 }, { project: "p", id, title: id, kind: "code" });
      l.db.query("UPDATE tasks SET stage = 'verified' WHERE id = ?").run(id);
      registerWorker(l.db, { agent: `a-${id}`, sessionId: `s-${id}`, taskId: id, role: "author", createdBy: "agent-pm", now: 1 });
    }
    const agents: AgentFacts[] = ["TM", "TE", "TL"].map((id) => ({ name: `a-${id}`, status: "active", sessionId: `s-${id}`, running: true,
      idleMs: 2 * 3_600_000, turnActive: false }));
    const plan = () => planLifecycle({ now: 100 * 3_600_000, policy: { ...DEFAULT_LIFECYCLE }, agents, index: cardWorkerIndex(l.db), ...ledgerFacts(l.db),
      foreign: new Set(), master: new Set(["master"]), swapPct: 10 });
    // old red: before the cards join their features every worker is collected
    expect(plan().actions.map((a) => a.agent).sort()).toEqual(["a-TE", "a-TL", "a-TM"]);
    l.bindFeature("TM", "fM", "p", MIGRATING);
    l.bindFeature("TE", "fE", "p", EXECUTION);
    expect(ledgerFacts(l.db).cards.map((c) => [c.id, c.frozen]).sort()).toEqual([["TE", true], ["TL", false], ["TM", true]]);
    const p = plan();
    expect(p.actions.map((a) => a.agent)).toEqual(["a-TL"]);
    expect(p.frozen.map((x) => x.taskId).sort()).toEqual(["TE", "TM"]);
  });
});

describe("supervise: agents of skip cards leave the registry the supervisor reads", () => {
  test("task agent and unretired scheduler session both count; local and retired do not", () => {
    const l = ledger("s2d2-sup-");
    createTask(l.db, { actor: "owner", now: 10 }, { project: "p", id: "TM", title: "TM", kind: "code", agent: "agent-m" });
    createTask(l.db, { actor: "owner", now: 10 }, { project: "p", id: "TE", title: "TE", kind: "code" });
    createTask(l.db, { actor: "owner", now: 10 }, { project: "p", id: "TL", title: "TL", kind: "code", agent: "agent-l" });
    const session = (taskId: string, agent: string, state: string) => {
      l.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
        VALUES (?, ?, 'p', 'restate', 'ensure_session', 0, 1, 1, 2, 'done', 'test', 0, 0)`).run(`ens-${agent}`, taskId);
      l.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
        VALUES (?, 'reviewer', ?, ?, 'codex', 'acp', ?, ?, 0, 0)`).run(taskId, agent, `s-${agent}`, state, `ens-${agent}`);
    };
    session("TE", "agent-rv-e", "active");
    session("TL", "agent-rv-l", "active");
    const names = ["agent-m", "agent-rv-e", "agent-l", "agent-rv-l", "agent-free"];
    expect(names.filter((n) => schedulerV2SkipAgent(l.db, n))).toEqual([]);
    l.bindFeature("TM", "fM", "p", MIGRATING);
    l.bindFeature("TE", "fE", "p", EXECUTION);
    expect(names.filter((n) => schedulerV2SkipAgent(l.db, n))).toEqual(["agent-m", "agent-rv-e"]);
    l.db.query("UPDATE scheduler_sessions SET state = 'retired' WHERE agent = 'agent-rv-e'").run();
    expect(schedulerV2SkipAgent(l.db, "agent-rv-e")).toBe(false);
  });
});

describe("retire: scheduler-retire is held before any effect", () => {
  test("skip cards end the tick `held` with 0 agent / git / tmp calls; the local card is retired", async () => {
    const l = ledger("s2d2-retire-");
    const registryPath = join(l.dir, "registry.json"), root = join(l.dir, "worktrees");
    mkdirSync(root);
    const reg: { socket: string; agents: Record<string, unknown> } = { socket: "", agents: {} };
    l.db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]')").run();
    let now = 1000;
    const windows = new Set<string>();
    for (const id of ["TM", "TE", "TL"]) {
      const agent = `agent-${id.toLowerCase()}`;
      createTask(l.db, { actor: "owner", now: (now += 10) }, { project: "p", id, title: id, kind: "code", agent });
      l.db.query("UPDATE tasks SET stage = 'verified' WHERE id = ?").run(id);
      l.db.query(`INSERT INTO scheduler_intents (id, taskId, project, node, action, causalSeq, taskRev, specRev, templateVersion, status, reason, createdAt, updatedAt)
        VALUES (?, ?, 'p', 'restate', 'ensure_session', 0, 1, 1, 2, 'done', 'test', 0, 0)`).run(`ens-${id}`, id);
      l.db.query(`INSERT INTO scheduler_sessions (taskId, role, agent, sessionId, family, transport, state, createIntentId, createdAt, updatedAt)
        VALUES (?, 'author', ?, ?, 'claude', 'tmux', 'active', ?, 0, 0)`).run(id, agent, `s-${id}`, `ens-${id}`);
      reg.agents[agent] = { status: "active", sessionId: `s-${id}`, cwd: join(root, id) };
      windows.add(agent);
    }
    writeFileSync(registryPath, JSON.stringify(reg));
    l.bindFeature("TM", "fM", "p", MIGRATING);
    l.bindFeature("TE", "fE", "p", EXECUTION);
    const deps = (actor: string): LedgerDeps => ({ db: l.db, actor, registryPath, projectIds: ["p"], now: () => (now += 10),
      loadRegistry: async () => JSON.parse(readFileSync(registryPath, "utf8")) as Registry, saveRegistry: async () => {} });
    const inner: string[][] = [], effects: string[][] = [];
    const ledgerCli = async (...args: string[]): Promise<Reply> => { inner.push(args); return runLedger(args.slice(1), deps("scheduler")); };
    const retireDeps: RetireDeps = {
      ledger: schedulerV2SkipManager(l.db, ledgerCli),
      agent: async (...args) => {
        effects.push(args);
        if (args[0] === "kill") {
          const r = JSON.parse(readFileSync(registryPath, "utf8"));
          r.agents[args[1]].status = "stopped";
          writeFileSync(registryPath, JSON.stringify(r));
          windows.delete(args[1]);
        }
        return args[0] === "archive" ? { ok: true, archived: [] } : { ok: true, message: "stopped" };
      },
      git: async (args) => { effects.push(["git", ...args]); return { ok: true, out: "" } as never; },
      tmp: { root: join(l.dir, "tmp"), rm: async (p) => { effects.push(["rm", p]); } },
      exists: existsSync, worktreeRoot: root, notifyPm: async () => {},
      agents: () => readLiveAgents(registryPath, async () => [...windows]),
    };
    const out = await schedulerRetireTick(l.db, ["p"], retireDeps);
    const step = Object.fromEntries(out.cards.map((c) => [c.taskId, c.step]));
    expect(step.TM).toBe("held");
    expect(step.TE).toBe("held");
    expect(step.TL).not.toBe("held");
    expect(inner.every((a) => !["TM", "TE"].some((id) => a.includes(id)))).toBe(true);
    expect(effects.some((e) => e.includes("agent-tl"))).toBe(true);
    expect(effects.some((e) => e.some((x) => /agent-t[me]\b|\/T[ME]\b/.test(x)))).toBe(false);
    expect(listEvents(l.db, { target: "TM" }).filter((e) => e.kind === "scheduler")).toEqual([]);
  });
});

describe("auto.start: no local card for a migrating or execution feature", () => {
  const P = "proj", PM = "agent-pm";
  function fixture() {
    const l = ledger("s2d2-autostart-");
    let now = 1000;
    const calls: string[][] = [];
    const agents: Record<string, { channelId: string; projectId?: string }> = { [PM]: { channelId: "ch-pm", projectId: P } };
    const branches = new Set(["main"]);
    const repo = join(l.dir, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    l.db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    setMeta(l.db, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
    const specDir = join(l.dir, "ledger", "docs", "tasks");
    mkdirSync(specDir, { recursive: true });
    for (const slug of ["i28", "j29"]) {
      createFeature(l.db, { actor: PM, now: now++ }, { project: P, slug, title: slug });
      initDag(l.db, { actor: PM, now: now++ }, { id: `ab12-${slug}`, rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: [`src/lib/${slug}*.ts`] }] });
      writeFileSync(join(specDir, `${slug}-a.md`), "# 规格\n\n## 目标\n");
      const t = new Date(Date.now() - 120_000);
      utimesSync(join(specDir, `${slug}-a.md`), t, t);
    }
    const ledgerDeps = (actor: string) => ({ db: l.db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents }) as never,
      saveRegistry: async () => {}, now: () => now++, autoDispatch: () => true, autoProjects: () => [P] });
    const git = async (_cwd: string, args: string[]) => {
      calls.push(["git", ...args]);
      const [cmd, sub] = args;
      if (cmd === "worktree" && sub === "add") { mkdirSync(args.at(-2) as string, { recursive: true }); branches.add(args[args.indexOf("-b") + 1]); }
      else if (cmd === "rev-parse") { const ok = args[3].endsWith("^{commit}") || branches.has(args[3].replace("refs/heads/", "")); return { ok, out: ok ? "base0" : "" }; }
      return { ok: true, out: "" };
    };
    const stepIO = (): Omit<StepIO, "db" | "manager" | "attempt"> => ({
      git, exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: (p, t) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, t); },
      remove: (p) => rmSync(p, { force: true }), symlink: (t, p) => writeFileSync(p, `-> ${t}`), agentExists: (a) => !!agents[a],
    });
    const env: StartTickEnv = {
      db: l.db, svc: { autoDispatch: true, projects: [P], maxWorkers: () => 3 },
      ledger: async (...args) => { calls.push(args); return runLedger(args.slice(1), ledgerDeps("scheduler")); },
      plain: async (args) => {
        calls.push(args);
        if (args[0] === "create") agents[`agent-${args[1]}`] = { channelId: `ch-${args[1]}`, projectId: P };
        return { ok: true };
      },
      startEnv: () => ({ ledgerDir: join(l.dir, "ledger"), worktreeRoot: join(l.dir, "wt"), projectDirs: async () => [repo],
        agentNames: () => Object.keys(agents), exists: existsSync, branchExists: async (_r: string, b: string) => branches.has(b),
        autoReady: () => null, template: () => null }) as never,
      stepIO,
      readSpec: (id) => { const p = join(specDir, `${id}.md`); return existsSync(p) ? { mtimeMs: statSync(p).mtimeMs, text: readFileSync(p, "utf8") } : null; },
      quota: async () => ({ status: "known", source: "live", observedAt: 1, plan: null, reason: null,
        windows: [{ id: "7d", kind: "weekly", usedPct: 20, resetsAtMs: 9e12, resetPassed: false }] }) as never,
      notifyPm: async () => {}, memo: new Set(), now: Date.now, attempt: () => "abcd1234",
    };
    const claimsOf = (fid: string) => listEvents(l.db, { target: fid }).filter((e) => e.data.op === "autostart_claim");
    return { ...l, env, calls, claimsOf };
  }

  for (const [label, mode] of [["migrating", MIGRATING], ["execution", EXECUTION]] as const) {
    test(`${label} feature: no claim, git or ledger call for it; the next feature's node is opened`, async () => {
      const f = fixture();
      f.feature("ab12-i28", P, mode);
      expect(await autostartTick(f.env)).toEqual([]);
      expect(f.claimsOf("ab12-i28")).toEqual([]);
      expect(getTask(f.db, "i28-a")).toBeNull();
      expect(f.calls.some((c) => c.some((x) => x.includes("i28")))).toBe(false);
      expect(f.claimsOf("ab12-j29")).toHaveLength(1);
      expect(getTask(f.db, "j29-a")).not.toBeNull();
    });
  }

  test("execution with the switch on and a port is still not opened locally", async () => {
    const f = fixture();
    configureSchedulerV2Pass({ mode: () => "on", wrapManager: (m) => m });
    f.feature("ab12-i28", P, EXECUTION);
    await autostartTick(f.env);
    expect(f.claimsOf("ab12-i28")).toEqual([]);
    expect(f.claimsOf("ab12-j29")).toHaveLength(1);
  });

  test("old red: the same feature without the mode is the one claimed", async () => {
    const f = fixture();
    await autostartTick(f.env);
    expect(f.claimsOf("ab12-i28")).toHaveLength(1);
    expect(getTask(f.db, "i28-a")).not.toBeNull();
  });
});
