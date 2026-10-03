import { codexQuotaWait } from "../src/lib/scheduler-local-runtime-quota.js";
import { unknownQuota, type InventoryQuota } from "../src/lib/ai-quota.js";
import { clearQueuedLocalStarts, retryQueuedLocalStarts } from "../src/lib/scheduler-local-runtime-queue.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { localAuthorRuntime, setLocalAuthorRuntime } from "../src/lib/scheduler-local-runtime.js";
import { runLocalStart, localAutostart, localEnsure, localCreateGuard, localCreatedFamily, localAutostartNode } from "../src/lib/scheduler-local-runtime-start.js";
import { withCodexSlot } from "../src/lib/scheduler-local-runtime-slots.js";
import type { Candidate } from "../src/lib/scheduler-autostart.js";
import type { StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import type { StartPlacement } from "../src/lib/scheduler-placement-start.js";
import type { StartPlan } from "../src/lib/dag-tools-start.js";
import type { StepIO, StartOutcome } from "../src/lib/dag-tools-steps.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { preflightStart } from "../src/lib/dag-tools-start.js";
import { runLedger } from "../src/manager/ledger.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { runStart } from "../src/lib/dag-tools-steps.js";
import { closeLedger, openLedger, getEventByDedup, getTask } from "../src/lib/ledger-store.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { autoFixture, toBuild, H1 } from "./scheduler-auto-helpers.js";

const dirs: string[] = [];
const dbPaths: string[] = [];
afterEach(() => { clearQueuedLocalStarts(); for (const path of dbPaths.splice(0)) closeLedger(path); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(runtime?: string, n = 0) {
  const dir = mkdtempSync(join(tmpdir(), "lc1-")); dirs.push(dir);
  const ledgerPath = join(dir, "config-ledger.sqlite"), db = openLedger(ledgerPath); dbPaths.push(ledgerPath);
  const projectsPath = join(dir, "projects.json");
  writeFileSync(projectsPath, JSON.stringify({ projects: [{ id: "p", name: "p", dirs: [dir], createdAt: "" }] }));
  const configPath = join(dir, "scheduler.json"), registryPath = join(dir, "registry.json"), lockPath = join(dir, "codex.lock");
  const doc = { enabled: true, autoDispatch: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: dir,
    ...(runtime ? { localAuthorRuntime: runtime } : {}), untouched: { keep: true } } } };
  writeFileSync(configPath, JSON.stringify(doc));
  const agents = Object.fromEntries(Array.from({ length: n }, (_, i) => [`agent-${i}`, { runtime: "codex", status: "active", projectId: `p${i}` }]));
  writeFileSync(registryPath, JSON.stringify({ agents }));
  const setRuntime = (runtime: "claude" | "codex") => setLocalAuthorRuntime(db, { actor: "owner", now: Date.now() },
    { project: "p", runtime, reason: "配置测试选择作者运行时" }, { path: configPath });
  for (let i = 0; i < n; i++) db.query(`INSERT INTO tasks (id, project, title, kind, stage, agent, createdAt, updatedAt)
    VALUES (?, ?, 'busy', 'code', 'build', ?, 0, 0)`).run(`busy-${i}`, `p${i}`, `agent-${i}`);
  return { db, ledgerPath, setRuntime, configPath, projectsPath, registryPath, lockPath, doc, dir, codexQuota: async () => unknownQuota("fixture") };
}
const p = { project: "p", taskId: "T", peer: null, feature: { id: "F" }, key: "one" } as StartPlan;
const success: StartOutcome = { ok: true, taskId: "T", placement: "local", branch: "b", steps: [], reconciled: [] };

test("config default and strict runtime validation; locked writer preserves unrelated config", async () => {
  const f = fixture();
  expect(localAuthorRuntime("p", f.configPath)).toBe("claude");
  expect(Object.hasOwn(parseSchedulerConfig(f.doc).projects.p, "localAuthorRuntime")).toBe(false);
  await f.setRuntime("codex");
  expect(localAuthorRuntime("p", f.configPath)).toBe("codex");
  expect(JSON.parse(readFileSync(f.configPath, "utf8")).projects.p.untouched).toEqual({ keep: true });
  const before = readFileSync(f.configPath, "utf8");
  await expect(f.setRuntime("pi" as never)).rejects.toThrow("claude|codex");
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  expect(() => parseSchedulerConfig(fixture("pi").doc)).toThrow("claude|codex");
  expect(localAuthorRuntime("p", join(f.dir, "absent"))).toBe("claude");
});

test("start pipeline leaves default args identical and adds canonical ACP launch + Codex author family when configured", async () => {
  for (const runtime of [undefined, "claude", "codex"]) {
    const f = fixture(runtime), calls: string[][] = [];
    const io = { manager: async (args: string[]) => { calls.push(args); return { ok: true }; } } as StepIO;
    const run = async (adapted: StepIO) => {
      await adapted.manager(["create", "task", "/worktree"]);
      await adapted.manager(["ledger", "workflow-set", "T", "--author-family", "claude"]);
      return success;
    };
    expect(await runLocalStart(io, p, run, f)).toEqual(success);
    expect(calls[0]).toEqual(["create", "task", "/worktree", ...(runtime === "codex" ? ["--runtime", "codex", "--transport", "acp"] : [])]);
    expect(calls[1].at(-1)).toBe(runtime === "codex" ? "codex" : "claude");
  }
});

test("all projects and reviewer sessions count toward six; capacity wait performs no start or claim", async () => {
  const f = fixture("codex", 6); let calls = 0;
  const io = { db: () => f.db, manager: async () => ({ ok: true }), attempt: "queued-test" } as unknown as StepIO;
  const r = await runLocalStart(io, p, async () => { calls++; return success; }, f);
  expect(r).toMatchObject({ ok: false, code: "queued", queued: true, error: expect.stringContaining("等待空槽"), rolledBack: [] });
  await localAutostart("p", async () => { calls++; }, f);
  expect(await localEnsure("codex", false, async () => { calls++; return { kind: "unknown", reason: "created" }; }, f))
    .toMatchObject({ kind: "wait" });
  expect(calls).toBe(0);
  // An existing session is reused even when the machine is full.
  expect(await localEnsure("codex", true, async () => ({ kind: "unknown", reason: "existing" }), f)).toEqual({ kind: "unknown", reason: "existing" });
});

test("authors and reviews share the same lock; nested autostart→start is reentrant, competing request waits", async () => {
  const f = fixture("codex", 5); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), inside = new Promise<void>((r) => { entered = r; });
  const first = localAutostart("p", async () => {
    entered(); await gate;
    expect(await runLocalStart({} as StepIO, p, async () => success, f)).toEqual(success);
  }, f);
  await inside;
  expect(await localEnsure("codex", false, async () => ({ kind: "unknown", reason: "must not run" }), f)).toMatchObject({ kind: "wait" });
  release(); await first;
  expect(await withCodexSlot(async () => "free", f)).toBe("free");
});

test("cross-process lock contention and malformed registry fail closed; release happens on exceptions", async () => {
  const f = fixture("codex");
  const lock = await acquireLock(f.lockPath, 0); expect(lock).not.toBeNull();
  expect(await withCodexSlot(async () => "bad", f)).toMatchObject({ kind: "wait" });
  lock!.release();
  writeFileSync(f.registryPath, "broken");
  expect(await withCodexSlot(async () => "bad", f)).toMatchObject({ kind: "wait", reason: expect.stringContaining("无法核实") });
  writeFileSync(f.registryPath, '{"agents":{}}');
  await expect(withCodexSlot(async () => { throw new Error("probe"); }, f)).rejects.toThrow("probe");
  expect(await withCodexSlot(async () => "released", f)).toBe("released");
});

test("manager spawn without a held slot is refused; non-Codex creation stays unchanged", async () => {
  let calls = 0;
  const create = localCreateGuard(async (..._args: string[]) => { calls++; return { ok: true }; });
  expect(await create("create", "rv", "--runtime", "codex")).toMatchObject({ ok: false });
  expect(await create("create", "rv")).toEqual({ ok: true });
  expect(calls).toBe(1);
});

test("auto ensure wait cancels the uncreated intent and retries next tick without PM escalation", async () => {
  const f = autoFixture();
  try {
    const ready = f.tickDeps.ensure;
    f.tickDeps.ensure = async () => ({ kind: "wait", reason: "Codex full" });
    expect((await f.tick()).step).toBe("waiting");
    expect(f.intents().at(-1)?.status).toBe("cancelled");
    expect(f.notices).toEqual([]);
    f.tickDeps.ensure = ready;
    expect((await f.tick()).step).toBe("session");
  } finally { f.close(); }
});

test("actual start_node steps create ACP Codex and persist the Codex workflow flag", async () => {
  const f = fixture("codex"), ledgerPath = join(f.dir, "ledger.sqlite"), db = openLedger(ledgerPath);
  const calls: string[][] = [];
  try {
    const plan = { ...p, feature: { id: "F" }, key: "one", title: "test", item: null, pm: "pm", base: "main", branch: "feat/test",
      repo: f.dir, worktree: join(f.dir, "worktree"), agentName: "task-t", agent: "agent-task-t", fileGlobs: ["src/x.ts"],
      specPath: join(f.dir, "spec.md"), specText: null, promptPath: join(f.dir, "prompt.md"), promptText: "work", purpose: "T" } as StartPlan;
    const io: StepIO = {
      db: () => db, manager: async (args) => { calls.push(args); return { ok: true }; },
      git: async (_cwd, args) => ({ ok: true, out: args[0] === "rev-parse" && args.includes("main^{commit}") ? "a".repeat(40) : "" }),
      exists: () => false, read: () => null, write: () => {}, remove: () => {}, symlink: () => {}, agentExists: () => false, attempt: "probe",
    };
    expect((await runLocalStart(io, plan, runStart, f)).ok).toBe(true);
    const create = calls.find((c) => c[0] === "create")!;
    expect(create.slice(-4)).toEqual(["--runtime", "codex", "--transport", "acp"]);
    const workflow = calls.find((c) => c[1] === "workflow-set")!;
    expect(workflow).toContain("--author-family=codex");
  } finally { closeLedger(ledgerPath); }
});

test("autostart pins runtime before claim even if config changes during the run", async () => {
  const f = fixture("codex"); let args: string[] = [];
  await localAutostart("p", async () => {
    await f.setRuntime("claude");
    const io = { manager: async (a: string[]) => { args = a; return { ok: true }; } } as StepIO;
    await runLocalStart(io, p, async (adapted) => { await adapted.manager(["create", "task"]); return success; }, f);
  }, f);
  expect(args).toContain("codex");
});

test("Codex author enters the existing cross-family review path with a Claude reviewer", async () => {
  const f = autoFixture({ reviewerRuntime: "claude-code" });
  try {
    f.db.query("UPDATE task_workflows SET authorFamily = 'codex' WHERE taskId = 'T1'").run();
    const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
    reg.agents["agent-task-one"].runtime = "codex";
    reg.agents["agent-task-one"].transport = "acp";
    writeFileSync(f.registryPath, JSON.stringify(reg));
    await toBuild(f);
    await f.tick();
    expect(await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1)).toMatchObject({ ok: true });
    expect((await f.tick()).step).toBe("session");
    expect(f.ensured.at(-1)).toEqual({ role: "reviewer", family: "claude" });
  } finally { f.close(); }
});

test("a second process cannot enter a held machine slot", async () => {
  const f = fixture("codex"), lock = await acquireLock(f.lockPath, 0);
  const modulePath = new URL("../src/lib/scheduler-local-runtime-slots.ts", import.meta.url).pathname;
  const script = `import { withCodexSlot } from ${JSON.stringify(modulePath)};
    console.log(JSON.stringify(await withCodexSlot(async () => "created", ${JSON.stringify(f)})));`;
  try {
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(error).toBe("");
    expect(JSON.parse(output)).toMatchObject({ kind: "wait" });
  } finally { lock!.release(); }
});

test("autostart ledger author family comes from the created runtime, not a supplied workflow flag", () => {
  const f = fixture("codex", 1);
  expect(localCreatedFamily("agent-0", f.registryPath)).toBe("codex");
  expect(localCreatedFamily("absent", f.registryPath)).toBe("claude");
});

test("Codex weekly 85% gate waits before start/claim, never using Claude quota", async () => {
  const f = fixture("codex"); let calls = 0;
  const now = Date.now();
  const q: InventoryQuota = { ...unknownQuota("test"), status: "known", windows: [
    { id: "7d", kind: "weekly", usedPct: 85, resetsAtMs: now + 60_000, resetPassed: false },
  ] };
  const opts = { ...f, codexQuota: async () => q, checkQuota: true };
  expect(await withCodexSlot(async () => { calls++; }, opts)).toMatchObject({ kind: "wait", reason: expect.stringContaining("85%") });
  await localAutostart("p", async () => { calls++; }, opts);
  expect(calls).toBe(0);
  q.windows[0].usedPct = 84.9;
  expect(await withCodexSlot(async () => "created", opts)).toBe("created");
  q.windows[0].usedPct = 99;
  q.windows[0].resetsAtMs = now - 1;
  expect(await codexQuotaWait(opts.codexQuota, now)).toBeNull();
  q.windows[0].resetsAtMs = now + 60_000;
  q.windows[0].resetPassed = true;
  expect(await codexQuotaWait(opts.codexQuota, now)).toBeNull();
  q.windows[0].resetPassed = false;
  q.windows[0].kind = "session";
  expect(await codexQuotaWait(opts.codexQuota, now)).toBeNull();
  expect(await codexQuotaWait(async () => unknownQuota("no snapshot"), now)).toBeNull();
});

test("five active Codex plus unknown-runtime creating reservation consume all six slots", async () => {
  const f = fixture("codex", 5);
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-creating"] = { status: "creating" };
  writeFileSync(f.registryPath, JSON.stringify(reg));
  expect(await withCodexSlot(async () => "ADMITTED", f)).toMatchObject({ kind: "wait" });
  reg.agents["agent-creating"].runtime = "codex";
  writeFileSync(f.registryPath, JSON.stringify(reg));
  expect(await withCodexSlot(async () => "ADMITTED", f)).toMatchObject({ kind: "wait" });
  reg.agents["agent-creating"].runtime = "unknown-runtime";
  writeFileSync(f.registryPath, JSON.stringify(reg));
  expect(await withCodexSlot(async () => "ADMITTED", f)).toMatchObject({ kind: "wait" });
  reg.agents["agent-creating"].runtime = "claude-code";
  writeFileSync(f.registryPath, JSON.stringify(reg));
  expect(await withCodexSlot(async () => "ADMITTED", f)).toBe("ADMITTED");
});

test("runtime config uses authorization, required reason, audit/dedup, and rolls back on audit failure", async () => {
  const f = fixture(), before = readFileSync(f.configPath, "utf8");
  const input = { project: "p", runtime: "codex" as const, reason: "本机作者切换到 Codex" }, opts = { path: f.configPath };
  await expect(setLocalAuthorRuntime(f.db, { actor: "agent-worker" }, input, opts)).rejects.toMatchObject({ code: "forbidden" });
  await expect(setLocalAuthorRuntime(f.db, { actor: "owner" }, { ...input, reason: "" }, opts)).rejects.toMatchObject({ code: "invalid" });
  expect(readFileSync(f.configPath, "utf8")).toBe(before);
  const ctx = { actor: "owner", dedupKey: "runtime-edit", now: Date.now() };
  expect(await setLocalAuthorRuntime(f.db, ctx, input, opts)).toMatchObject({ changed: true });
  expect(getEventByDedup(f.db, ctx.dedupKey)?.data).toMatchObject({ op: "scheduler_local", from: { localAuthorRuntime: "claude" }, to: { localAuthorRuntime: "codex" } });
  expect(await setLocalAuthorRuntime(f.db, ctx, input, opts)).toMatchObject({ duplicate: true });
  const codex = readFileSync(f.configPath, "utf8");
  f.db.run("CREATE TRIGGER reject_runtime_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'audit probe'); END");
  await expect(setLocalAuthorRuntime(f.db, { actor: "owner" }, { ...input, runtime: "claude" }, opts)).rejects.toThrow("audit probe");
  expect(readFileSync(f.configPath, "utf8")).toBe(codex);
});

test("manual start queues at six, and the next retry pass automatically opens after one session ends", async () => {
  const f = fixture("codex", 6), notices: string[] = [];
  let starts = 0;
  const opts = { ...f, queuedReady: async () => null, queuedNotice: async (text: string) => { notices.push(text); } };
  const io = { db: () => f.db, manager: async () => ({ ok: true }), attempt: "queued-test" } as unknown as StepIO;
  const result = await runLocalStart(io, p, async () => { starts++; return success; }, opts);
  expect(result).toMatchObject({ ok: false, code: "queued", queued: true, taskId: "T" });
  await retryQueuedLocalStarts();
  expect(starts).toBe(0);
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
  reg.agents["agent-0"].status = "archived";
  writeFileSync(f.registryPath, JSON.stringify(reg));
  await retryQueuedLocalStarts();
  expect(starts).toBe(1);
  expect(notices).toEqual(["T 已获得 Codex 空槽并自动开工"]);
  await retryQueuedLocalStarts();
  expect(starts).toBe(1);
});

async function realQueuedFixture() {
  const f = fixture("codex", 6), ctx = { actor: "owner", now: Date.now() };
  f.db.run("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')");
  setMeta(f.db, ctx, { project: "p", key: "pms", value: ["agent-pm"] });
  createFeature(f.db, ctx, { project: "p", slug: "queued", title: "queued" });
  initDag(f.db, ctx, { id: "ab12-queued", rev: 1, nodes: [{ key: "one", oneLine: "one", fileGlobs: ["src/x.ts"] }] });
  const files = new Map<string, string>(), calls: string[][] = [], notices: string[] = [];
  const exists = (path: string) => path === join(f.dir, ".git") || files.has(path);
  const git: StepIO["git"] = async (_cwd, args) => ({ ok: args[0] !== "rev-parse" || args.includes("main^{commit}"),
    out: args.includes("main^{commit}") ? "a".repeat(40) : "" });
  const pre = await preflightStart({ db: f.db, caller: "agent-pm", ledgerDir: f.dir, worktreeRoot: join(f.dir, "worktrees"),
    projectDirs: async () => [f.dir], agentNames: () => [], exists, branchExists: async () => false, autoReady: () => null, template: () => null,
  }, { featureId: "ab12-queued", key: "one", taskId: "T-queued", base: "main", spec: "original spec", placement: "local" });
  expect(pre.ok).toBe(true);
  if (!pre.ok || "already" in pre) throw new Error("preflight");
  const io: StepIO = { db: () => f.db, git, exists, read: (path) => files.get(path) ?? null, write: (path, text) => { files.set(path, text); },
    remove: (path) => { files.delete(path); }, symlink: () => {}, agentExists: () => false, attempt: "queued-attempt",
    manager: async (args) => {
      calls.push(args);
      if (args[0] === "ledger") return runLedger(args.slice(1), { db: f.db, actor: "agent-pm", now: Date.now, projectIds: ["p"],
        autoProjects: () => ["p"], autoDispatch: () => true, loadRegistry: async () => JSON.parse(readFileSync(f.registryPath, "utf8")), saveRegistry: async () => {} });
      if (args[0] === "create") {
        const reg = JSON.parse(readFileSync(f.registryPath, "utf8"));
        reg.agents[`agent-${args[1]}`] = { runtime: "codex", transport: "acp", status: "active", sessionId: "new" };
        writeFileSync(f.registryPath, JSON.stringify(reg));
      }
      return { ok: true };
    } };
  const opts = { ...f, queuedNotice: async (text: string) => { notices.push(text); } };
  return { f, io, opts, plan: pre.plan, calls, notices };
}

test("real manual start pipeline queues without a card, then the next pass creates the Codex card automatically", async () => {
  const { f, io, opts, plan, calls, notices } = await realQueuedFixture();
  expect(await runLocalStart(io, plan, runStart, opts)).toMatchObject({ code: "queued", queued: true, error: expect.stringContaining("bridge 重启会清空排队") });
  expect(getTask(f.db, "T-queued")).toBeNull();
  expect(calls.filter((c) => c[1] !== "note")).toEqual([]);
  await retryQueuedLocalStarts();
  expect(getTask(f.db, "T-queued")).toBeNull();
  expect(notices).toEqual([]);
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8")); delete reg.agents["agent-0"];
  writeFileSync(f.registryPath, JSON.stringify(reg));
  await retryQueuedLocalStarts();
  expect(getTask(f.db, "T-queued")?.agent).toBe("agent-task-t-queued");
  expect(getWorkflow(f.db, "T-queued")?.authorFamily).toBe("codex");
  expect(notices).toEqual(["T-queued 已获得 Codex 空槽并自动开工"]);
  const notes = f.db.query("SELECT text FROM events WHERE kind = 'note' ORDER BY seq").all() as { text: string }[];
  expect(notes.map((n) => n.text.match(/Codex 排队 (\w+)/)?.[1])).toEqual(["queued", "started"]);
  expect(notes.every((n) => n.text.includes("卡号 T-queued") && n.text.includes("ab12-queued/one")
    && n.text.includes("原调用 PM agent-pm") && n.text.includes("排队时间"))).toBe(true);
});

test("duplicate manual queue is not replayed twice and PM authority is rechecked before delayed effects", async () => {
  const { f, io, opts, plan, calls, notices } = await realQueuedFixture();
  const first = await runLocalStart(io, plan, runStart, opts);
  expect(await runLocalStart(io, plan, runStart, opts)).toBe(first);
  setMeta(f.db, { actor: "owner" }, { project: "p", key: "pms", value: ["new-pm"] });
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8")); delete reg.agents["agent-0"];
  writeFileSync(f.registryPath, JSON.stringify(reg));
  await retryQueuedLocalStarts();
  expect(getTask(f.db, "T-queued")).toBeNull();
  expect(calls.filter((c) => c[1] !== "note")).toEqual([]);
  expect(notices).toEqual(["T-queued 排队开卡取消：原调用者已不再有项目开卡权限，排队取消"]);
});

test("queue failures leave a ledger note; no queued receipt is returned if entry audit is rejected", async () => {
  const { f, io, opts, plan, notices } = await realQueuedFixture();
  await runLocalStart(io, plan, runStart, opts);
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8")); delete reg.agents["agent-0"];
  writeFileSync(f.registryPath, JSON.stringify(reg));
  const manager = io.manager;
  io.manager = async (args, timeout) => args[1] === "task-new" ? { ok: false, error: "queue create probe" } : manager(args, timeout);
  await retryQueuedLocalStarts();
  const notes = f.db.query("SELECT text FROM events WHERE kind = 'note' ORDER BY seq").all() as { text: string }[];
  expect(notes.map((n) => n.text.match(/Codex 排队 (\w+)/)?.[1])).toEqual(["queued", "started", "failed"]);
  expect(notes.at(-1)?.text).toContain("queue create probe");
  expect(notices.at(-1)).toContain("排队开卡失败");
  reg.agents["agent-0"] = { runtime: "codex", status: "active" };
  writeFileSync(f.registryPath, JSON.stringify(reg));
  io.manager = async () => ({ ok: false, error: "note denied" });
  await expect(runLocalStart(io, plan, runStart, opts)).rejects.toThrow("note denied");
});

test("LS1 peer destination bypasses full local Codex slots and remains pinned before claim", async () => {
  const { f, io, plan } = await realQueuedFixture();
  io.write(join(f.dir, "docs", "tasks", "queued-one.md"), "peer spec");
  let destination: StartPlacement = { where: "peer", peer: "he", repo: "owner/repo", reason: "peer available" }, opened = 0;
  const env = { db: f.db, startEnv: () => ({ ledgerDir: f.dir, worktreeRoot: join(f.dir, "worktrees"),
    projectDirs: async () => [f.dir], agentNames: () => [], exists: io.exists, branchExists: async () => false,
    autoReady: () => null, template: () => null, placement: async () => destination,
  }) } as unknown as StartTickEnv;
  const cand = { f: plan.feature, key: plan.key, head: { template: { ok: true, template: "code" } } } as Candidate;
  await localAutostartNode(env, cand, async (next) => {
    opened++;
    destination = { where: "local", reason: "placement changed while awaiting" };
    const pinned = await preflightStart({ ...next.startEnv(), db: f.db, caller: "agent-pm" }, { featureId: plan.feature.id, key: plan.key });
    expect(pinned.ok && "plan" in pinned ? pinned.plan.peer?.name : null).toBe("he");
  }, f);
  expect(opened).toBe(1);
  await localAutostartNode(env, cand, async () => { opened++; }, f);
  expect(opened).toBe(1);
});

test("queued repo removed from current projects.json cancels without worktree, worker or card and records failure", async () => {
  const { f, io, opts, plan, calls, notices } = await realQueuedFixture();
  let gitEffects = 0;
  const git = io.git;
  io.git = async (...args) => { gitEffects++; return git(...args); };
  await runLocalStart(io, plan, runStart, opts);
  const projects = JSON.parse(readFileSync(f.projectsPath, "utf8"));
  projects.projects[0].dirs = [];
  writeFileSync(f.projectsPath, JSON.stringify(projects));
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8")); delete reg.agents["agent-0"];
  writeFileSync(f.registryPath, JSON.stringify(reg));
  await retryQueuedLocalStarts();
  expect(getTask(f.db, plan.taskId)).toBeNull();
  expect(calls.filter((c) => c[1] !== "note")).toEqual([]);
  expect(gitEffects).toBe(0);
  expect(io.exists(plan.worktree)).toBe(false);
  const notes = f.db.query("SELECT text FROM events WHERE kind = 'note' ORDER BY seq").all() as { text: string }[];
  expect(notes.map((n) => n.text.match(/Codex 排队 (\w+)/)?.[1])).toEqual(["queued", "failed"]);
  expect(notes.at(-1)?.text).toContain("不是项目 p 的 git 目录");
  expect(notes.at(-1)?.text).toContain("原调用 PM agent-pm");
  expect(notices.at(-1)).toContain("排队开卡取消");
});

test("queued repo validation reads fresh directories on every retry, refusing unreadable snapshots", async () => {
  const { f, io, opts, plan } = await realQueuedFixture();
  await runLocalStart(io, plan, runStart, opts);
  await retryQueuedLocalStarts(); // A good file is read while all slots remain occupied.
  writeFileSync(f.projectsPath, "invalid JSON");
  const reg = JSON.parse(readFileSync(f.registryPath, "utf8")); delete reg.agents["agent-0"];
  writeFileSync(f.registryPath, JSON.stringify(reg));
  await retryQueuedLocalStarts();
  expect(getTask(f.db, plan.taskId)).toBeNull();
  const last = f.db.query("SELECT text FROM events WHERE kind = 'note' ORDER BY seq DESC LIMIT 1").get() as { text: string };
  expect(last.text).toContain("Codex 排队 failed");
  expect(last.text).toContain("无法确认当前项目目录");
});
