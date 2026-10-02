/** Real scheduler-local parsing and command dispatch, with the config and ledger kept in an isolated fixture. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeLedger, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { LedgerCli } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { schedulerRemoteCmds } from "../src/manager/ledger-scheduler-remote-cmds.js";
import { runLedger } from "../src/manager/ledger.js";
import type { Registry } from "../src/manager/core.js";

let dir: string, configPath: string, dbPath: string, db: ReturnType<typeof openLedger>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lc1-runtime-cli-"));
  configPath = join(dir, "scheduler.json"); dbPath = join(dir, "ledger.sqlite"); db = openLedger(dbPath);
  writeFileSync(configPath, JSON.stringify({ enabled: true, projects: {
    p: { maxActiveWorkers: 2, repoDir: dir, requiredChecks: ["check"], retained: "keep" },
  } }));
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm", "agent-dispatcher"] });
  setMeta(db, { actor: "owner" }, { project: "p", key: "team", value: { dispatcher: "agent-dispatcher", audit: true } });
});
afterEach(() => { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); });

const deps = (actor: string) => ({ db, actor, projectIds: ["p"], now: Date.now,
  loadRegistry: async () => ({ socket: "", agents: {} }) as Registry, saveRegistry: async () => {} });
async function cli(actor: string, ...args: string[]) {
  const spec = schedulerRemoteCmds(configPath)["scheduler-local"];
  const parsed = parseLedgerArgs(["scheduler-local", ...args], spec.valued, spec.bools);
  if ("error" in parsed) return { ok: false, code: "invalid", error: parsed.error };
  try { return await spec.run(new LedgerCli(deps(actor), parsed)); }
  catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
}
const decisions = () => listEvents(db, { project: "p" }).filter((e) => e.kind === "decision");

// Uses the actual valued-flag table and LedgerCli, rather than directly invoking the config setter.
test("scheduler-local --author-runtime codex changes config and records authorized original/new values", async () => {
  expect(await cli("agent-pm", "p", "--author-runtime", "codex", "--reason", "本机改由 Codex 写代码", "--dedup", "runtime-cli"))
    .toMatchObject({ ok: true, changed: true, from: { localAuthorRuntime: "claude" }, to: { localAuthorRuntime: "codex" } });
  expect(JSON.parse(readFileSync(configPath, "utf8")).projects.p).toMatchObject({ localAuthorRuntime: "codex", retained: "keep", maxActiveWorkers: 2 });
  expect(decisions()).toHaveLength(1);
  expect(decisions()[0]).toMatchObject({ actor: "agent-pm", text: "本机改由 Codex 写代码",
    data: { op: "scheduler_local", from: { localAuthorRuntime: "claude" }, to: { localAuthorRuntime: "codex" } } });
  expect(await cli("agent-pm", "p", "--author-runtime", "codex", "--reason", "本机改由 Codex 写代码", "--dedup", "runtime-cli"))
    .toMatchObject({ ok: true, duplicate: true });
  expect(decisions()).toHaveLength(1);
});

test("worker, dispatcher and scheduler cannot use the runtime entry", async () => {
  const original = readFileSync(configPath, "utf8");
  for (const actor of ["agent-worker", "agent-dispatcher", "unknown"]) {
    expect(await cli(actor, "p", "--author-runtime", "codex", "--reason", "not authorized"))
      .toMatchObject({ ok: false, code: "forbidden" });
  }
  expect(await runLedger(["scheduler-local", "p", "--author-runtime", "codex", "--reason", "not authorized"], deps("scheduler")))
    .toMatchObject({ ok: false, code: "forbidden" });
  expect(await runLedger(["note", "-", "queue failure", "--project=p"], deps("scheduler")))
    .toMatchObject({ ok: false, code: "forbidden" });
  expect(readFileSync(configPath, "utf8")).toBe(original);
  expect(decisions()).toEqual([]);
});

test("runtime flag rejects unsupported/missing values or reason; existing local options still combine and audit atomically", async () => {
  const original = readFileSync(configPath, "utf8");
  for (const args of [
    ["p", "--author-runtime", "pi", "--reason", "r"], ["p", "--author-runtime"], ["p", "--author-runtime", "codex"],
  ]) expect(await cli("owner", ...args)).toMatchObject({ ok: false, code: "invalid" });
  expect(readFileSync(configPath, "utf8")).toBe(original);
  expect(await cli("owner", "p", "--author-runtime=codex", "--max-workers=3", "--priority=low", "--reason=统一配置"))
    .toMatchObject({ ok: true, to: { localAuthorRuntime: "codex", maxActiveWorkers: 3, localPriority: "low" } });
  expect(await cli("master", "p", "--author-runtime", "claude", "--reason", "恢复原家族"))
    .toMatchObject({ ok: true, from: { localAuthorRuntime: "codex" }, to: { localAuthorRuntime: "claude" } });
});
