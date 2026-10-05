/** Production lend create -> manager create -> registry -> list/sidebar, with only external effects stubbed. */
import { expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testChildEnv } from "./test-env.js";
import type { AgentSession } from "../web/features/chat/type.js";

const CHILD = "LIFE2_CREATE_CHILD", PRELOAD = "LIFE2_CREATE_PRELOAD";
if (process.env[PRELOAD]) {
  await stubCreateEffects();
} else if (!process.env[CHILD]) {
  test("lend create writes its worker tag before listing (isolated real manager entry)", async () => {
    const root = mkdtempSync(join(tmpdir(), "life2-create-"));
    try {
      const child = Bun.spawn([process.execPath, "--no-env-file", "test", import.meta.path], {
        stdout: "pipe", stderr: "pipe", env: testChildEnv({
          HOME: root, CODEX_HOME: join(root, ".codex"), CLAUDESTRA_STATE_DIR: join(root, "state"),
          CLAUDESTRA_RUNTIME_DIR: join(root, "runtime"), CLAUDESTRA_TEST_DEFAULT_LEND_JOURNAL: "1", [CHILD]: "1",
        }),
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code) throw new Error(`${out}\n${err}`);
      expect(err).toContain("0 fail");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
} else {
  test("actual lend create, explicit roles, PM/main protection and stopped-worker zero tail reads", async () => {
    const core = await import("../src/manager/core.js");
    const hints = await import("../src/lib/update-hints.js");
    mock.module("../src/lib/update-hints.js", () => ({ ...hints, attachUpdateHints: async () => {} }));
    const runManager = await import("../src/lib/run-manager.js");
    mock.module("../src/lib/run-manager.js", () => ({ ...runManager,
      runManagerProcess: async (args: string[], options: { env: Record<string, string> }) => {
        expect(args[0]).toBe("create");
        const proc = Bun.spawn([process.execPath, "--no-env-file", "--preload", import.meta.path,
          join(import.meta.dir, "../src/manager.ts"), ...args], {
          stdout: "pipe", stderr: "pipe", env: testChildEnv({ ...options.env, [PRELOAD]: "1" }),
        });
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (code) throw new Error(`manager create failed: ${err} ${out}`);
        return JSON.parse(out);
      },
    }));
    const { writeProjects } = await import("../src/lib/projects.js");
    const { LEND_PATH } = await import("../src/lib/lend-config.js");
    const { openLendJournal, recordAsked, advance, patchOrder } = await import("../src/lib/lend-journal.js");
    const { LedgerReader } = await import("../src/lib/ledger-read.js");
    const { lendDeps } = await import("../src/lib/lend-deps.js");
    const dir = join(process.env.HOME!, "work"), name = "agent-lend-created", orderId = "lend:fixture:s3:r2:a1";
    mkdirSync(dir, { recursive: true });
    await writeProjects({ projects: [{ id: "lend", name: "lend", dirs: [dir], createdAt: new Date().toISOString() }] });
    writeFileSync(LEND_PATH, JSON.stringify({ version: 2, enabled: true, borrow: [], lend: [{ peer: "fixture", fp: "abcd-ef01-2345-6789",
      families: { codex: 1 }, roles: ["review"], repos: ["fixture/repo"], ordersPerDay: 5,
      grantedAt: new Date().toISOString(), until: new Date(Date.now() + 86_400_000).toISOString() }] }));
    const journal = openLendJournal(), ledger = new LedgerReader();
    recordAsked(journal, { orderId, peer: "fixture", fp: "abcd-ef01-2345-6789", family: "codex", preview: { repo: "fixture/repo", step: "review" } });
    advance(journal, orderId, "asked", "claimed", { leaseUntil: Date.now() + 60_000, leaseGen: 1 });
    advance(journal, orderId, "claimed", "cloned", { dir });
    patchOrder(journal, orderId, ["cloned"], { agent: name });
    const { acquireLock } = await import("../src/lib/file-lock.js");
    const singleton = join(dir, "scheduler.pid"), maintenance = join(dir, "maintenance.lock");
    const a = (await acquireLock(singleton, 0))!, b = (await acquireLock(maintenance, 0))!;
    const lease = { singleton: { path: singleton, token: a.token }, maintenance: { path: maintenance, token: b.token } };
    try {
      expect(await lendDeps(journal, ledger, () => {}, lease).worker.create(name, dir, "fixture", async () => null, orderId)).toEqual({ ok: true });
      const reg = await core.loadRegistry();
      expect(reg.agents[name]).toMatchObject({ kind: "worker", status: "active" });
      reg.agents[name].status = "stopped";
      await core.saveRegistry(reg);
      const { handleAgentsList } = await import("../src/bridge/agents-list-route.js");
      const { newTokenPrincipal } = await import("../src/lib/principals.js");
      let tailCalls = 0;
      const response = await handleAgentsList(new URL("http://fixture/agents?include=stopped"), newTokenPrincipal("owner", ["*"]), {
        runManager: async () => ({ agents: [] }), clients: new Map(), controlChannelId: "",
        tails: { resolve: () => (tailCalls++, "fixture"), read: async () => (tailCalls++, null), now: Date.now, warn: () => {} },
      });
      const body = await response.json() as { agents: AgentSession[] };
      expect(response.status).toBe(200);
      expect(body.agents).toContainEqual(expect.objectContaining({ name, kind: "worker", lastActivityTs: null }));
      expect(tailCalls).toBe(0);
      const { filterAndRankWorkers } = await import("../web/features/chat/sidebar-entries.js");
      expect(filterAndRankWorkers(body.agents, "", new Set())).toEqual([]);
      expect(filterAndRankWorkers(body.agents, name, new Set())).toHaveLength(1);
    } finally { journal.close(); ledger.close(); a.release(); b.release(); }
  }, 20_000);

  test("creation declarations protect PM/main and refuse invalid or unreadable evidence", async () => {
    const { teamFieldsForCreate } = await import("../src/manager/team.js");
    const { loadRegistry, saveRegistry } = await import("../src/manager/core.js");
    const { openLedger, closeLedger, LEDGER_PATH, LEDGER_SCHEMA_VERSION } = await import("../src/lib/ledger-store.js");
    const { openLendJournal, patchOrder, LEND_JOURNAL_PATH } = await import("../src/lib/lend-journal.js");
    const db = openLedger(), reg = await loadRegistry();
    db.query("INSERT INTO meta(project, key, value) VALUES (?, 'pms', ?)").run("lend", JSON.stringify(["project-pm"]));
    reg.agents["agent-override"] = { ...reg.agents["agent-lend-created"], kind: "main" };
    reg.agents["agent-prior-pm"] = { ...reg.agents["agent-lend-created"], kind: undefined, role: "pm" };
    await saveRegistry(reg);
    try {
      for (const role of ["executor", "dispatcher"]) {
        expect(await teamFieldsForCreate("agent-ordinary", { role })).toMatchObject({ kind: "worker" });
        for (const name of ["master", "agent-codex", "agent-project-pm", "agent-prior-pm"]) {
          expect(await teamFieldsForCreate(name, { role })).not.toHaveProperty("kind");
        }
        expect(await teamFieldsForCreate("agent-override", { role })).toMatchObject({ kind: "main" });
      }
      expect(await teamFieldsForCreate("agent-task-manual", {})).toEqual({});
      expect(await teamFieldsForCreate("agent-review-manual", { task: "fixture" })).toEqual({ task: "fixture" });
      expect(await teamFieldsForCreate("agent-pm", { role: "pm" })).toEqual({ role: "pm" });
      for (const order of ["", "bad order", "unknown-order"]) {
        process.env.CLAUDESTRA_LEND_ORDER = order;
        expect(await teamFieldsForCreate("agent-lend-created", {})).toBeNull();
      }
      process.env.CLAUDESTRA_LEND_ORDER = "lend:fixture:s3:r2:a1";
      const journal = openLendJournal();
      patchOrder(journal, process.env.CLAUDESTRA_LEND_ORDER, ["cloned"], { agent: "agent-unusual" });
      journal.close();
      expect(await teamFieldsForCreate("agent-unusual", {})).toEqual({ kind: "worker" });
      writeFileSync(LEND_JOURNAL_PATH, "unreadable journal fixture");
      expect(await teamFieldsForCreate("agent-unusual", {})).toBeNull();
      delete process.env.CLAUDESTRA_LEND_ORDER;
      db.exec("PRAGMA user_version = 0");
      expect(await teamFieldsForCreate("agent-ordinary", { role: "executor" })).toBeNull();
      db.exec(`PRAGMA user_version = ${LEDGER_SCHEMA_VERSION}`);
      db.query("UPDATE meta SET value = 'malformed' WHERE key = 'pms'").run();
      expect(await teamFieldsForCreate("agent-ordinary", { role: "executor" })).toBeNull();
    } finally { delete process.env.CLAUDESTRA_LEND_ORDER; closeLedger(LEDGER_PATH); }
  });
}

/** Only platform/runtime effects are substituted; CLI parsing, creation and registry writes stay real. */
async function stubCreateEffects(): Promise<void> {
    const tmux = await import("../src/lib/tmux-helper.js");
    mock.module("../src/lib/tmux-helper.js", () => ({ ...tmux, tmuxRaw: async () => "", tmuxRawStrict: async () => "@1" }));
    const windows = await import("../src/lib/agent-windows.js");
    mock.module("../src/lib/agent-windows.js", () => ({ ...windows, agentWindowsOrNull: async () => [] }));
    const bridge = await import("../src/lib/bridge-client.js");
    mock.module("../src/lib/bridge-client.js", () => ({ ...bridge, bridgeRequest: async () => ({ channelId: "fixture-channel" }) }));
    const ops = await import("../src/manager/ops-deps.js");
    mock.module("../src/manager/ops-deps.js", () => ({ ...ops, triggerSkillsRescan: async () => {} }));
    const owner = await import("../src/lib/owner-guard.js");
    mock.module("../src/lib/owner-guard.js", () => ({ ...owner, machineUuid: () => "fixture-machine" }));
    const lifecycle = await import("../src/manager/acp-lifecycle.js");
    const adapter = { id: "codex", available: async () => ({ ok: true }), control: { modelEnforcement: "launch" }, registryFields: () => ({ runtime: "codex" }) };
    mock.module("../src/manager/acp-lifecycle.js", () => ({ ...lifecycle,
      prepareCreateRuntime: async (_name: string, dir: string) => ({ ok: true, dir, adapter }),
      launchWithPiFallback: async () => ({ adapter, result: { ready: true } }),
    }));
}
