import { codexQuotaWait } from "../src/lib/scheduler-local-runtime-quota.js";
import { unknownQuota, type InventoryQuota } from "../src/lib/ai-quota.js";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSchedulerConfig } from "../src/lib/scheduler-config.js";
import { localAuthorRuntime, setLocalAuthorRuntime } from "../src/lib/scheduler-local-runtime.js";
import { runLocalStart, localAutostart, localEnsure, localCreateGuard, localCreatedFamily } from "../src/lib/scheduler-local-runtime-start.js";
import { withCodexSlot } from "../src/lib/scheduler-local-runtime-slots.js";
import type { StartPlan } from "../src/lib/dag-tools-start.js";
import type { StepIO, StartOutcome } from "../src/lib/dag-tools-steps.js";
import { runStart } from "../src/lib/dag-tools-steps.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { autoFixture, toBuild, H1 } from "./scheduler-auto-helpers.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(runtime?: string, n = 0) {
  const dir = mkdtempSync(join(tmpdir(), "lc1-")); dirs.push(dir);
  const configPath = join(dir, "scheduler.json"), registryPath = join(dir, "registry.json"), lockPath = join(dir, "codex.lock");
  const doc = { enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: dir,
    ...(runtime ? { localAuthorRuntime: runtime } : {}), untouched: { keep: true } } } };
  writeFileSync(configPath, JSON.stringify(doc));
  const agents = Object.fromEntries(Array.from({ length: n }, (_, i) => [`agent-${i}`, { runtime: "codex", status: "active", projectId: `p${i}` }]));
  writeFileSync(registryPath, JSON.stringify({ agents }));
  return { configPath, registryPath, lockPath, doc, dir, codexQuota: async () => unknownQuota("fixture") };
}
const p = { project: "p", taskId: "T", peer: null } as StartPlan;
const success: StartOutcome = { ok: true, taskId: "T", placement: "local", branch: "b", steps: [], reconciled: [] };

test("config default and strict runtime validation; locked writer preserves unrelated config", async () => {
  const f = fixture();
  expect(localAuthorRuntime("p", f.configPath)).toBe("claude");
  expect(Object.hasOwn(parseSchedulerConfig(f.doc).projects.p, "localAuthorRuntime")).toBe(false);
  await setLocalAuthorRuntime("p", "codex", f.configPath);
  expect(localAuthorRuntime("p", f.configPath)).toBe("codex");
  expect(JSON.parse(readFileSync(f.configPath, "utf8")).projects.p.untouched).toEqual({ keep: true });
  const before = readFileSync(f.configPath, "utf8");
  await expect(setLocalAuthorRuntime("p", "pi" as never, f.configPath)).rejects.toThrow("claude|codex");
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
  const io = {} as StepIO;
  const r = await runLocalStart(io, p, async () => { calls++; return success; }, f);
  expect(r).toMatchObject({ ok: false, error: expect.stringContaining("等待空槽"), rolledBack: [] });
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
    await setLocalAuthorRuntime("p", "claude", f.configPath);
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
