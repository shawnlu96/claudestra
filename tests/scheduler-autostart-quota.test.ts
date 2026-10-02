import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import type { StartTickEnv } from "../src/lib/scheduler-autostart-run.js";

// A separate clean process fixes module-level paths before imports and keeps mocks out of other scheduler tests.
if (!process.env.AQ1_CHILD) {
  test("autostart runtime quota acceptance in isolated state", async () => {
    const root = mkdtempSync(join(tmpdir(), "aq1-"));
    try {
      const child = Bun.spawn(["env", "-i", `PATH=${process.env.PATH}`, `HOME=${root}`, "AQ1_CHILD=1",
        `CLAUDESTRA_STATE_DIR=${join(root, "state")}`, `CLAUDESTRA_RUNTIME_DIR=${join(root, "runtime")}`,
        process.execPath, "test", import.meta.path], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code, stdout + stderr).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
} else {
  const quotaModule = await import("../src/lib/ai-quota.js");
  const { STATE_DIR } = await import("../src/lib/paths.js");
  const { autostartTick } = await import("../src/lib/scheduler-autostart-run.js");
  const { openLedger, closeLedger } = await import("../src/lib/ledger-store.js");
  const { setMeta } = await import("../src/lib/ledger-write.js");
  const { createFeature, initDag } = await import("../src/lib/ledger-feature-write.js");
  mkdirSync(STATE_DIR, { recursive: true });
  const snapshot = (usedPct: number): InventoryQuota => ({ status: "known", source: "live", observedAt: Date.now(),
    plan: null, reason: null, windows: [{ id: "7d", kind: "weekly", usedPct, resetsAtMs: 9e12, resetPassed: false }] });
  let cleanup: (() => void) | undefined;
  afterEach(() => { cleanup?.(); cleanup = undefined; });

  async function tick(runtime: "claude" | "codex" | undefined, claude: InventoryQuota, codex: InventoryQuota, rounds = 1, slots = 0) {
    const root = mkdtempSync(join(STATE_DIR, "case-")), path = join(root, "ledger.sqlite");
    const db = openLedger(path), notes: string[] = [], claims: string[][] = [];
    const mock = spyOn(quotaModule, "readInventoryQuota").mockResolvedValue({ claude, codex });
    cleanup = () => { mock.mockRestore(); closeLedger(path); rmSync(root, { recursive: true, force: true }); };
    writeFileSync(join(STATE_DIR, "scheduler.json"), JSON.stringify({ enabled: true, autoDispatch: true,
      projects: { p: { repoDir: root, requiredChecks: ["ci"], maxActiveWorkers: 3,
        ...(runtime ? { localAuthorRuntime: runtime } : {}) } } }));
    writeFileSync(join(STATE_DIR, "registry.json"), JSON.stringify({ agents: Object.fromEntries(
      Array.from({ length: slots }, (_, i) => [`agent-${i}`, { runtime: "codex", status: "active" }])) }));
    db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm"] });
    createFeature(db, { actor: "agent-pm", now: 2 }, { project: "p", slug: "aq1", title: "Quota regression" });
    initDag(db, { actor: "agent-pm", now: 3 }, { id: "ab12-aq1", rev: 1,
      nodes: [{ key: "a", oneLine: "Quota gate", fileGlobs: ["src/lib/example.ts"] }] });
    const spec = join(root, "docs", "tasks", "aq1-a.md");
    mkdirSync(join(root, "docs", "tasks"), { recursive: true });
    writeFileSync(spec, "# Quota gate\n\n## Goal\n");
    const env: StartTickEnv = {
      db, svc: { autoDispatch: true, projects: ["p"], maxWorkers: () => 3 },
      // Stop at the claim boundary: reaching it proves the quota gate allowed starting, without creating workers.
      ledger: async (...args) => { claims.push(args); return { ok: false, code: "conflict" }; },
      plain: async () => { throw new Error("must not spawn workers"); },
      startEnv: () => ({ ledgerDir: root, worktreeRoot: join(root, "wt"), projectDirs: async () => [root],
        agentNames: () => [], exists: (p) => p === spec || p === join(root, ".git"), branchExists: async () => false,
        autoReady: () => null, template: () => null }),
      stepIO: () => { throw new Error("must not write worktrees"); },
      readSpec: () => ({ text: "# Quota gate\n\n## Goal\n", mtimeMs: Date.now() - 120_000 }),
      quota: async () => claude, notifyPm: async (_project, text) => { notes.push(text); },
      memo: new Set(), now: Date.now, attempt: () => "aq1",
    };
    for (let i = 0; i < rounds; i++) expect(await autostartTick(env)).toEqual([]);
    return { claims, notes, quotaReads: mock.mock.calls.length };
  }

  test("1: Codex 40% proceeds despite Claude 95%", async () => {
    const result = await tick("codex", snapshot(95), snapshot(40));
    expect(result.claims).toHaveLength(1);
    expect(result.quotaReads).toBeGreaterThan(0);
    expect(result.notes).toEqual([]);
  });
  test("2: Codex 90% blocks and reports family, usage and 85% line", async () => {
    const result = await tick("codex", snapshot(20), snapshot(90), 2);
    expect(result.claims).toEqual([]);
    expect(result.quotaReads).toBeGreaterThan(0);
    expect(result.notes).toHaveLength(1);
    expect(result.notes.join("\n")).toContain("Codex");
    expect(result.notes.join("\n")).toContain("90%");
    expect(result.notes.join("\n")).toContain("85%");
  });
  for (const runtime of [undefined, "claude"] as const) {
    test(`3: ${runtime ?? "default"} Claude 71% blocks at 70%`, async () => {
      const result = await tick(runtime, snapshot(71), snapshot(40));
      expect(result.claims).toEqual([]);
      expect(result.notes).toEqual(["[自动开卡] Claude 周额度 7d 已用 71%，到了 70% 的线，暂停自动开卡（窗口 " +
        new Date(9e12).toISOString() + " 重置）。要调线用 autostart-set --line。"]);
    });
  }
  test("full slots remain silent even with Codex quota over the line", async () => {
    const result = await tick("codex", snapshot(20), snapshot(90), 2, 6);
    expect(result.claims).toEqual([]);
    expect(result.notes).toEqual([]);
  });
  test("4: unknown Codex quota proceeds despite Claude 95%", async () => {
    const result = await tick("codex", snapshot(95), quotaModule.unknownQuota("no snapshot"));
    expect(result.claims).toHaveLength(1);
    expect(result.quotaReads).toBeGreaterThan(0);
    expect(result.notes).toEqual([]);
  });
}
