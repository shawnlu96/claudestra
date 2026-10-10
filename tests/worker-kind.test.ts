import { describe, expect, test } from "bun:test";
import { markWorkerKinds, setWorkerKind, visibleInDefaultSearch, workerKind } from "../src/lib/worker-kind.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { requireSessionIdentity } from "../src/lib/scheduler-session-identity.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { Database } from "bun:sqlite";
import { applyWorkerKindMigration, planWorkerKindMigration, runWorkerKindMigration, type WorkerKindMigrationAudit } from "../src/lib/worker-kind-migration.js";
import { cardWorkerIndex, cardWorkerMigrationEvidence } from "../src/lib/agent-lifecycle-store.js";
import { runStartupMigrations } from "../src/bridge/startup-migrations.js";

test("existing startup caller uses real PM CLI and retries a pending audit without retagging reused sessions", async () => {
  const state = mkdtempSync(join(tmpdir(), "life2-startup-cli-")), path = join(state, "ledger.sqlite");
  const db = openLedger(path), registryPath = join(state, "registry.json"), projectsPath = join(state, "projects.json");
  db.exec(`INSERT INTO worker_agents (agent, sessionId, taskId, role, createdBy, createdAt, state)
    VALUES ('agent-history', 'old', 'T1', 'author', 'fixture', 1, 'retired'),
      ('agent-fixture-pm', 'pm', 'T1', 'author', 'fixture', 2, 'retired'),
      ('master', 'master', 'T1', 'author', 'fixture', 3, 'retired')`);
  db.exec(`INSERT INTO meta VALUES ('fixture', 'pms', '["agent-fixture-pm"]')`);
  const agents = { "agent-history": { sessionId: "old", projectId: "fixture", status: "stopped", kind: undefined as "worker" | "main" | undefined },
    "agent-fixture-pm": { sessionId: "pm", projectId: "fixture", status: "active" },
    master: { sessionId: "master", projectId: "fixture", status: "active" },
    "agent-task-manual": { sessionId: "manual", projectId: "fixture", status: "stopped" } };
  writeFileSync(registryPath, JSON.stringify({ socket: "fixture", agents }));
  writeFileSync(projectsPath, JSON.stringify({ projects: [] }));
  const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state,
    CLAUDESTRA_RUNTIME_DIR: join(state, "run"), CLAUDESTRA_AGENT: "agent-fixture-pm" };
  delete env.DISCORD_CHANNEL_ID; delete env.CLAUDESTRA_LEND_WORKER;
  const calls: string[][] = [], exits: number[] = [];
  const caller = async (...args: string[]) => {
    calls.push(args);
    // Other startup migrations are outside LIFE2; only its unchanged worker call reaches the real isolated CLI.
    if (args[0] !== "worker-kind-migrate") return { ok: true };
    // Native buffers keep this CLI fixture independent of HTTP globals in the shared runner; empty output still fails.
    const p = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), ...args],
      { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, exit] = [p.stdout.toString(), p.stderr.toString(), p.exitCode];
    if (!out.trim()) throw new Error(err);
    exits.push(exit);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  };
  try {
    await runStartupMigrations(caller);
    expect(exits).toEqual([1]);
    let reg = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(reg.agents["agent-history"].kind).toBe("worker");
    expect(reg.agents["agent-fixture-pm"].kind).toBeUndefined();
    expect(reg.agents.master.kind).toBeUndefined();
    expect(reg.agents["agent-task-manual"].kind).toBeUndefined();
    const key = reg.workerKindMigrationAudit.key;
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
    reg.agents["agent-history"] = { ...reg.agents["agent-history"], sessionId: "new", kind: "main" };
    writeFileSync(registryPath, JSON.stringify(reg));
    writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "fixture", dirs: [state] }] }));
    await runStartupMigrations(caller);
    await runStartupMigrations(caller);
    expect(exits).toEqual([1, 0, 0]);
    const events = db.query("SELECT actor, dedupKey, data FROM events").all() as { actor: string; dedupKey: string; data: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("agent-fixture-pm");
    expect(events[0].dedupKey).toBe(`${key}:fixture`);
    expect(JSON.parse(events[0].data).changes[0]).toMatchObject({ sessionId: "old", currentSessionId: "new", currentKind: "main", drifted: true });
    reg = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(reg.workerKindMigrationAudit).toBeUndefined();
    expect(reg.agents["agent-history"].kind).toBe("main");
    for (let i = 0; i < calls.length; i += 3) expect(calls.slice(i, i + 3)).toEqual([
      ["project-migrate"], ["worker-kind-migrate"], ["migrate", "--startup"],
    ]);
  } finally { closeLedger(path); rmSync(state, { recursive: true, force: true }); }
}, 30_000);

test("real migration CLI dry-run writes nothing, apply audits saved history once and repeat stays idempotent", async () => {
  const state = mkdtempSync(join(tmpdir(), "life2-migrate-cli-")), path = join(state, "ledger.sqlite");
  const db = openLedger(path), registryPath = join(state, "registry.json");
  db.prepare(`INSERT INTO worker_agents (agent, sessionId, taskId, role, createdBy, createdAt, state, retiredAt, reason)
    VALUES ('agent-rv-history', 'original', 'T1', 'reviewer', 'fixture', 1, 'retired', 2, NULL)`).run();
  writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "fixture", dirs: [state] }] }));
  writeFileSync(registryPath, JSON.stringify({ socket: "fixture", agents: {
    "agent-rv-history": { sessionId: "original", projectId: "fixture", status: "stopped" },
    "agent-task-manual": { sessionId: "manual", projectId: "fixture", status: "stopped" },
  } }));
  const env: Record<string, string | undefined> = { ...process.env, CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") };
  delete env.DISCORD_CHANNEL_ID; delete env.CLAUDESTRA_AGENT; delete env.CLAUDESTRA_LEND_WORKER;
  const run = async (args: string[]) => {
    const proc = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "worker-kind-migrate", ...args],
      { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [proc.stdout.toString(), proc.stderr.toString(), proc.exitCode];
    if (code) throw new Error(`Migration CLI exit=${code}: ${out} ${err}`);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  };
  try {
    const registryBefore = readFileSync(registryPath), eventsBefore = db.query("SELECT COUNT(*) AS n FROM events").get();
    const dry = await run(["--dry-run"]);
    expect(dry.dryRun).toBe(true);
    expect(dry.changes[0].agent).toBe("agent-rv-history");
    expect(dry.uncoveredCount).toBe(0);
    expect(dry.missingSourceCount).toBe(1);
    expect(dry.wouldTag).toEqual(["agent-rv-history"]);
    expect(readFileSync(registryPath)).toEqual(registryBefore);
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual(eventsBefore);
    expect((await run([])).marked).toBe(1);
    const reg = JSON.parse(readFileSync(registryPath, "utf8"));
    expect(reg.agents["agent-rv-history"].kind).toBe("worker");
    expect(reg.agents["agent-task-manual"].kind).toBeUndefined();
    expect(reg.workerKindMigrationAudit).toBeUndefined();
    const events = db.query("SELECT data FROM events WHERE json_extract(data, '$.op') = 'worker_kind_migration'").all() as { data: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].data).changes[0]).toMatchObject({ sessionId: "original", sources: ["worker_agents"], drifted: false });
    expect((await run([])).marked).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
    rmSync(registryPath);
    await expect(run(["--dry-run"])).rejects.toThrow("registry 不存在");
    expect(existsSync(registryPath)).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  } finally { closeLedger(path); rmSync(state, { recursive: true, force: true }); }
}, 30_000);

test("migration audit survives save/event/clear failures, drift and dry-run without duplicate facts", async () => {
  type Reg = { agents: Record<string, { sessionId: string; projectId: string; kind?: "worker" | "main" }>; workerKindMigrationAudit?: WorkerKindMigrationAudit };
  const fresh = (): Reg => ({ agents: { fixture: { sessionId: "old", projectId: "project" } } });
  const plan = { changes: [{ agent: "fixture", kind: "worker" as const, sources: ["worker_agents"] }],
    unresolved: [], uncovered: [], missingSources: [] };
  const empty = { ...plan, changes: [] };
  let disk = fresh(), saveCalls = 0, failSave = 1, failEvent = false;
  const events = new Map<string, Record<string, unknown>>();
  const deps = {
    now: () => 123,
    save: async (r: Reg) => { if (++saveCalls === failSave) throw new Error("save failed"); disk = structuredClone(r); },
    event: async (_project: string, key: string, fact: Record<string, unknown>) => {
      if (failEvent) throw new Error("event failed");
      if (!events.has(key)) events.set(key, structuredClone(fact));
    },
  };
  await expect(runWorkerKindMigration(fresh(), plan, false, deps)).rejects.toThrow("save failed");
  expect(events.size).toBe(0);
  expect(disk.agents.fixture.kind).toBeUndefined();
  failSave = 0; failEvent = true;
  await expect(runWorkerKindMigration(fresh(), plan, false, deps)).rejects.toThrow("event failed");
  expect(disk.agents.fixture.kind).toBe("worker");
  const pendingKey = disk.workerKindMigrationAudit!.key;
  const beforeDry = structuredClone(disk), beforeCalls = saveCalls;
  await runWorkerKindMigration(structuredClone(disk), empty, true, deps);
  expect(disk).toEqual(beforeDry);
  expect(saveCalls).toBe(beforeCalls);
  expect(events.size).toBe(0);
  const broken = structuredClone(disk);
  broken.workerKindMigrationAudit!.key = "bad";
  await expect(runWorkerKindMigration(broken, plan, false, deps)).rejects.toThrow("Invalid pending");
  const nullPending = Object.assign(fresh(), { workerKindMigrationAudit: null }) as unknown as Reg;
  await expect(runWorkerKindMigration(nullPending, plan, false, deps)).rejects.toThrow("Invalid pending");
  expect(saveCalls).toBe(beforeCalls);
  disk.agents.fixture = { sessionId: "new", projectId: "project", kind: "main" };
  failEvent = false; failSave = saveCalls + 1;
  await expect(runWorkerKindMigration(structuredClone(disk), plan, false, deps)).rejects.toThrow("save failed");
  expect(events.size).toBe(1);
  expect(disk.workerKindMigrationAudit!.key).toBe(pendingKey);
  expect([...events.values()][0].changes).toEqual([{ ...plan.changes[0], sessionId: "old", project: "project",
    currentSessionId: "new", currentKind: "main", drifted: true }]);
  failSave = 0;
  const result = await runWorkerKindMigration(structuredClone(disk), plan, false, deps);
  expect(result.marked).toBe(0);
  expect(result.changes).toEqual([]);
  expect(result.remainingChanges).toEqual(plan.changes);
  expect(events.size).toBe(1);
  expect(disk.workerKindMigrationAudit).toBeUndefined();
  expect(disk.agents.fixture).toEqual({ sessionId: "new", projectId: "project", kind: "main" });
  expect((await runWorkerKindMigration(structuredClone(disk), empty, false, deps)).marked).toBe(0);
  expect(events.size).toBe(1);
});

test("historical migration preserves live index semantics and reports remote or sessionless evidence", () => {
  const db = new Database(":memory:"), journal = new Database(":memory:");
  db.exec("CREATE TABLE tasks(agent TEXT, id TEXT, stage TEXT); CREATE TABLE meta(project TEXT, key TEXT, value TEXT)");
  db.exec("CREATE TABLE worker_agents(agent TEXT, sessionId TEXT, taskId TEXT, role TEXT, state TEXT, reason TEXT, createdAt INTEGER)");
  db.exec("CREATE TABLE scheduler_sessions(agent TEXT, taskId TEXT, role TEXT, sessionId TEXT, state TEXT, transport TEXT)");
  db.exec("CREATE TABLE lend_orders(worker TEXT, taskId TEXT, status TEXT, orderId TEXT)");
  journal.exec("CREATE TABLE lend_orders(agent TEXT, sessionId TEXT, state TEXT, orderId TEXT)");
  const insert = db.prepare("INSERT INTO worker_agents VALUES (?, ?, 'T1', 'author', ?, ?, 1)");
  for (const name of ["retired", "debt", "master", "agent-project-pm", "override", "reused", "missing-sid"]) {
    insert.run(name, name === "missing-sid" ? null : "old", name === "debt" ? "active" : "retired",
      name === "debt" ? 'cleanup_pending:[{"checkout":"fixture","tmp":null}]' : null);
  }
  insert.run("reserved", "old", "retired", "registering");
  insert.run("failed", "old", "retired", "register_failed: fixture");
  db.exec(`INSERT INTO worker_agents VALUES ('debt-unknown', 'old', NULL, 'other', 'active', 'cleanup_pending:[]', 1)`);
  db.exec("INSERT INTO scheduler_sessions VALUES ('bound-retired', 'T1', 'reviewer', 'old', 'retired', 'acp')");
  db.exec("INSERT INTO scheduler_sessions VALUES ('peer-namesake', 'T1', 'reviewer', 'old', 'retired', 'peer')");
  db.exec("INSERT INTO tasks VALUES ('task-only', 'T1', 'done')");
  db.exec("INSERT INTO lend_orders VALUES ('remote', 'T1', 'done', 'A-order')");
  journal.exec("INSERT INTO lend_orders VALUES ('foreign-local', 'old', 'acked', 'B-order')");
  db.exec(`INSERT INTO meta VALUES ('fixture', 'pms', '["project-pm"]')`);
  const agents: Record<string, { sessionId?: string; kind?: "worker" | "main" }> = {};
  for (const name of ["retired", "debt", "master", "agent-project-pm", "override", "reused", "missing-sid", "reserved", "failed",
    "bound-retired", "task-only", "remote", "foreign-local"]) agents[name] = { sessionId: "old" };
  agents.override.kind = "main";
  agents.reused.sessionId = "new";
  agents.remote.kind = "worker";
  agents["debt-unknown"] = { sessionId: "old", kind: "worker" };
  agents["peer-namesake"] = { sessionId: "old" };
  try {
    const liveBefore = [...cardWorkerIndex(db).keys()];
    expect(liveBefore).toEqual(["task-only"]);
    const history = cardWorkerMigrationEvidence(db, journal);
    expect(history.missingSources).toEqual([]);
    expect(history.evidence.some((e) => e.agent === "reserved" || e.agent === "failed")).toBe(false);
    const plan = planWorkerKindMigration(db, agents, journal);
    expect(plan.error).toBeUndefined();
    expect(plan.changes.map((c) => c.agent).sort()).toEqual(["bound-retired", "debt", "foreign-local", "retired"]);
    expect(plan.uncovered.map((r) => r.agent).sort()).toEqual(["debt-unknown", "missing-sid", "peer-namesake", "remote", "reused", "task-only"]);
    applyWorkerKindMigration(agents, plan);
    expect(agents.master.kind).toBeUndefined();
    expect(agents["agent-project-pm"].kind).toBeUndefined();
    expect(agents.override.kind).toBe("main");
    expect(agents.remote.kind).toBe("worker");
    expect(agents["debt-unknown"].kind).toBe("worker");
    expect(agents["peer-namesake"].kind).toBeUndefined();
    expect(planWorkerKindMigration(db, agents, journal).changes).toEqual([]);
    expect([...cardWorkerIndex(db).keys()]).toEqual(liveBefore);
    journal.exec("DROP TABLE lend_orders; CREATE TABLE lend_orders(agent TEXT)");
    const oldSchema = planWorkerKindMigration(db, agents, journal);
    expect(oldSchema.error).toBeUndefined();
    expect(oldSchema.missingSources).toEqual(["lend_journal:old_schema"]);
    expect(agents["foreign-local"].kind).toBe("worker");
  } finally { journal.close(); db.close(); }
});

test("migration uses registered session evidence, preserves unknown stock tags and never mutates during planning", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks(agent TEXT, id TEXT, stage TEXT); CREATE TABLE meta(project TEXT, key TEXT, value TEXT)");
  db.exec("CREATE TABLE scheduler_sessions(agent TEXT, taskId TEXT, role TEXT, sessionId TEXT, state TEXT, transport TEXT)");
  db.prepare("INSERT INTO scheduler_sessions VALUES (?, 'T1', 'author', 'original', 'active', 'tmux')").run("agent-rv-recorded");
  db.prepare("INSERT INTO scheduler_sessions VALUES (?, 'T1', 'author', 'old', 'active', 'acp')").run("agent-reused");
  const agents: Record<string, { sessionId?: string; kind?: "worker" | "main" }> = {
    "agent-rv-recorded": { sessionId: "original" }, "agent-reused": { sessionId: "new" },
    "agent-task-manual": {}, "agent-foreign-stock": { kind: "worker" },
  };
  try {
    const plan = planWorkerKindMigration(db, agents);
    expect(plan.error).toBeUndefined();
    expect(plan.changes).toMatchObject([{ agent: "agent-rv-recorded", kind: "worker", sources: ["scheduler_sessions"],
      references: [{ taskId: "T1", sessionId: "original", source: "scheduler_sessions", state: "active", local: true }] }]);
    expect(agents["agent-rv-recorded"].kind).toBeUndefined();
    expect(applyWorkerKindMigration(agents, plan)).toBe(1);
    expect(agents["agent-reused"].kind).toBeUndefined();
    expect(agents["agent-task-manual"].kind).toBeUndefined();
    expect(agents["agent-foreign-stock"].kind).toBe("worker");
    expect(planWorkerKindMigration(db, agents).changes).toEqual([]);
    db.exec("ALTER TABLE scheduler_sessions DROP COLUMN transport");
    delete agents["agent-rv-recorded"].kind;
    const unknownTransport = planWorkerKindMigration(db, agents);
    expect(unknownTransport.error).toBeUndefined();
    expect(unknownTransport.missingSources).toContain("scheduler_sessions:transport_unknown");
    expect(unknownTransport.changes).toEqual([]);
    expect(agents["agent-foreign-stock"].kind).toBe("worker");
    db.exec("DROP TABLE meta");
    const failed = planWorkerKindMigration(db, agents);
    expect(failed.error).toBeDefined();
    expect(applyWorkerKindMigration(agents, failed)).toBe(0);
    expect(agents["agent-foreign-stock"].kind).toBe("worker");
  } finally { db.close(); }
});

describe("worker registry kind", () => {
  test("session identity rejects a meta-only PM before a worker binding can be written", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-pm-")), path = join(root, "ledger.sqlite"), db = openLedger(path);
    const registryPath = join(root, "registry.json"), name = "agent-project-pm";
    writeFileSync(registryPath, JSON.stringify({ agents: { [name]: { runtime: "codex" } } }));
    const input = { taskId: "fixture", role: "reviewer" as const, intentId: "fixture", agent: name,
      sessionId: "fixture", family: "codex" as const, transport: "acp" as const, registryPath };
    try {
      expect(() => requireSessionIdentity(db, {} as LedgerTask, input, name)).not.toThrow();
      db.query("INSERT INTO meta(project, key, value) VALUES (?, 'pms', ?)").run("fixture", JSON.stringify(["project-pm"]));
      expect(() => requireSessionIdentity(db, {} as LedgerTask, input, name)).toThrow(/PM/);
    } finally { closeLedger(path); rmSync(root, { recursive: true, force: true }); }
  });
  test("task labels alone leave long-lived agents visible; explicit worker evidence tags only workers", () => {
    expect(workerKind("agent-build", { task: "T68" })).toBeNull();
    expect(workerKind("agent-build", { task: "T68", parent: "agent-pm" })).toBeNull();
    for (const name of ["agent-task-t68", "agent-rv-x", "agent-review-x", "agent-cv-x", "agent-lend-x", "agent-build-once", "agent-build-local"]) {
      expect(workerKind(name, {})).toBeNull();
      expect(workerKind(name, { kind: "worker" })).toBe("worker");
    }
    expect(workerKind("agent-review", { role: "dispatcher" })).toBeNull();
    expect(workerKind("agent-review", { role: "executor" })).toBeNull();
    expect(workerKind("agent-codex", { task: "T68", parent: "agent-pm" })).toBeNull();
    expect(workerKind("agent-pm", { role: "pm", kind: "worker" })).toBeNull();
    expect(workerKind("master", { kind: "worker" })).toBeNull();
  });

  test("registry normalization never invents a worker binding from names or roles", () => {
    const agents = {
      "agent-task-a": {},
      "agent-review": { role: "executor" },
      "agent-pm": { role: "pm" },
      "agent-codex": { task: "T68", parent: "agent-pm" },
    };
    expect(markWorkerKinds(agents)).toBe(0);
    expect(markWorkerKinds(agents)).toBe(0);
    expect(agents["agent-task-a"]).toEqual({});
    expect(agents["agent-pm"]).toEqual({ role: "pm" });
  });

  test("owner main override survives every registry save and explicit scheduler tag uses one setter", () => {
    const agents = { "agent-task-a": { task: "T1" } as { task: string; kind?: "worker" | "main" },
      "agent-review-t68": {} as { kind?: "worker" | "main" } };
    expect(markWorkerKinds(agents)).toBe(0);
    expect(setWorkerKind(agents, "agent-task-a", "main")).toBe(true);
    expect(markWorkerKinds(agents)).toBe(0);
    expect(agents["agent-task-a"].kind).toBe("main");
    expect(setWorkerKind(agents, "agent-task-a", "worker")).toBe(true);
    expect(agents["agent-task-a"].kind).toBe("main");
    expect(visibleInDefaultSearch("agent-task-a", agents["agent-task-a"])).toBe(true);
    expect(setWorkerKind(agents, "agent-review-t68", "worker")).toBe(true);
    expect(markWorkerKinds(agents)).toBe(0);
    expect(agents["agent-review-t68"].kind).toBe("worker");
  });

  test("default history search uses current or archived labels, never names", () => {
    expect(visibleInDefaultSearch("agent-review", { kind: "worker" })).toBe(false);
    expect(visibleInDefaultSearch("agent-review", undefined, true)).toBe(false);
    expect(visibleInDefaultSearch("agent-task-old")).toBe(true);
    expect(visibleInDefaultSearch("agent-rv-old")).toBe(true);
    expect(visibleInDefaultSearch("agent-pm")).toBe(true);
  });

  test("master, PM roles and supplied meta PM identities defeat stale worker tags", () => {
    const pms = ["project-pm"];
    for (const name of ["master", "agent-master", "codex", "agent-codex", "agent-project-pm"]) {
      const agents = { [name]: { kind: "worker" as "worker" | "main" | undefined } };
      expect(workerKind(name, agents[name], pms)).toBeNull();
      expect(setWorkerKind(agents, name, "worker", pms)).toBe(false);
      expect(markWorkerKinds(agents, pms)).toBe(1);
      expect(markWorkerKinds(agents, pms)).toBe(0);
      expect(agents[name].kind).toBeUndefined();
    }
    const agents = { "agent-pm": { role: "pm", kind: "worker" as const } };
    expect(setWorkerKind(agents, "agent-pm", "worker")).toBe(false);
    expect(markWorkerKinds(agents)).toBe(1);
    expect(workerKind("agent-project-pm", { kind: "main" }, pms)).toBe("main");
  });
});
