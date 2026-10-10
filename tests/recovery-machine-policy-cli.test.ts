/**
 * dispatch-recovery-LCFG1W through the real manager.ts against an isolated state dir: the old project path for the lend
 * config switch answers not_found (there is no lend project); `scheduler-recovery --machine` reads and writes the machine
 * section for owner / master only (agent channels, lend workers and the scheduler service are refused with zero write),
 * and the real LCFG1 consumer (configFailureMode) in a fresh process reads exactly what was set, next read.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerError } from "../src/lib/ledger-store.js";
import type { Registry } from "../src/manager/core.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { recoveryCmds } from "../src/manager/ledger-recovery-cmds.js";
import { openLedger } from "../src/lib/ledger-store.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { testChildEnv } from "./test-env.js";

const MANAGER = join(import.meta.dir, "../src/manager.ts");

describe("in-process command shape", () => {
  test("--machine: show without project; bad combinations are invalid; project path unchanged", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "machine-cmd-")), "recovery-policy.json");
    const db = openLedger(tempLedgerPath("machine-cmd-db-"));
    const deps = (actor: string): LedgerDeps => ({ db, actor, projectIds: ["a"], now: () => 9_000,
      loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} });
    const run = async (actor: string, ...args: string[]): Promise<Record<string, any>> => {
      const spec = recoveryCmds(path)["scheduler-recovery"]!;
      const p = parseLedgerArgs(["scheduler-recovery", ...args], spec.valued, spec.bools);
      if ("error" in p) return { ok: false, code: "invalid" };
      try { return await spec.run(new LedgerCli(deps(actor), p)); }
      catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
    };
    expect(await run("agent-x", "--machine")).toEqual({ ok: true, scope: "machine", keys: ["lendConfigFailure"],
      policies: { lendConfigFailure: { mode: "observe", manualAfterMs: null, source: "default" } } });
    for (const args of [["--machine", "on", "--reason", "r"], ["--machine", "on", "x", "--key", "lendConfigFailure", "--reason", "r"],
      ["--machine", "--key", "lendConfigFailure"], ["--machine", "on", "--key", "audit", "--reason", "r"], ["--machine", "ON", "--key", "lendConfigFailure", "--reason", "r"],
      ["--machine", "on", "--key", "lendConfigFailure", "--manual-stall-hours", "3", "--reason", "r"], ["--machine", "on", "--key", "lendConfigFailure"],
      ["--machine", "--last", "3"]]) {
      expect([args, (await run("owner", ...args)).code]).toEqual([args, "invalid"]);
    }
    expect(existsSync(path)).toBe(false);
    expect(await run("owner", "--machine", "on", "--key", "lendConfigFailure", "--reason", "r")).toMatchObject({ ok: true, scope: "machine", changed: true, to: { mode: "on" } });
    expect((await run("owner", "a")).policies.audit.mode).toBe("observe"); // the project read view is unaffected
  });
});

describe("real manager.ts (isolated state)", () => {
  const setup = () => {
    const state = mkdtempSync(join(tmpdir(), "machine-cli-state-"));
    writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "a", name: "A", dirs: [state] }] }));
    writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "s", agents: { "agent-pm-a": { channelId: "111" } } }));
    const base: Record<string, string> = { CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run"), CONTROL_CHANNEL_ID: "900" };
    const file = join(state, "recovery-policy.json");
    const cli = async (extra: Record<string, string>, ...args: string[]) => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", MANAGER, "ledger", "scheduler-recovery", ...args],
        { env: testChildEnv({ ...base, ...extra }), stdout: "pipe", stderr: "pipe" });
      const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "{}");
      await proc.exited;
      return out as Record<string, any>;
    };
    /** The real consumer in a fresh process, file-backed (default port, state dir from env). */
    const consumerMode = async () => {
      const script = join(state, "read-mode.ts");
      writeFileSync(script, `import { configFailureMode } from ${JSON.stringify(join(import.meta.dir, "../src/lib/lend-config-failure.ts"))};\nconsole.log(configFailureMode());\n`);
      const proc = Bun.spawn([process.execPath, "--no-env-file", script], { env: testChildEnv(base), stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(proc.stdout).text()).trim().split("\n").at(-1);
      await proc.exited;
      return out;
    };
    return { state, file, cli, consumerMode };
  };

  test("old path not_found reproduced; --machine set by owner is read by the real consumer next time; inherit clears to observe", async () => {
    const t = setup();
    // the pre-LCFG1W way to switch the lend config mechanism: there is no lend project, so it can never be set
    expect(await t.cli({}, "lend", "on", "--key", "lendConfigFailure", "--reason", "r")).toMatchObject({ ok: false, code: "not_found" });
    expect([existsSync(t.file), await t.consumerMode()]).toEqual([false, "observe"]);
    expect(await t.cli({}, "--machine")).toMatchObject({ ok: true, policies: { lendConfigFailure: { mode: "observe", source: "default" } } });
    for (const m of ["on", "off", "observe"]) {
      expect(await t.cli({}, "--machine", m, "--key", "lendConfigFailure", "--reason", `owner ${m}`)).toMatchObject({ ok: true, changed: true, to: { mode: m } });
      expect(await t.consumerMode()).toBe(m);
      expect((await t.cli({}, "--machine")).policies.lendConfigFailure).toMatchObject({ mode: m, source: "config" });
    }
    expect(await t.cli({}, "--machine", "inherit", "--key", "lendConfigFailure", "--reason", "清掉")).toMatchObject({ ok: true, to: { mode: null } });
    expect(await t.consumerMode()).toBe("observe");
    expect(Object.keys(JSON.parse(readFileSync(t.file, "utf8")))).toEqual(["projects", "machine"]);
    expect(JSON.parse(readFileSync(t.file, "utf8")).projects).toEqual({}); // no pseudo lend project was created
    expect(existsSync(join(t.state, "scheduler.json"))).toBe(false);
  }, 60_000);

  test("master (control channel) may switch; PM channel / unknown channel / lend worker / scheduler service are refused with zero write", async () => {
    const t = setup();
    expect(await t.cli({}, "a", "observe", "--key", "audit", "--reason", "init")).toMatchObject({ ok: true }); // project entry exists, ledger created
    const before = readFileSync(t.file, "utf8");
    for (const [env, codes] of [[{ DISCORD_CHANNEL_ID: "111" }, ["forbidden"]], [{ DISCORD_CHANNEL_ID: "999" }, ["forbidden"]],
      [{ CLAUDESTRA_LEND_WORKER: "1" }, ["forbidden"]], [{ CLAUDESTRA_SCHEDULER_SERVICE: "1" }, ["forbidden", "lease-lost"]]] as const) {
      const r = await t.cli(env, "--machine", "on", "--key", "lendConfigFailure", "--reason", "r");
      expect([env, r.ok, codes.includes(r.code)]).toEqual([env, false, true]);
    }
    expect(readFileSync(t.file, "utf8")).toBe(before);
    expect(await t.consumerMode()).toBe("observe");
    expect(await t.cli({ DISCORD_CHANNEL_ID: "900" }, "--machine", "on", "--key", "lendConfigFailure", "--reason", "master")).toMatchObject({ ok: true, changed: true });
    expect(await t.consumerMode()).toBe("on");
    expect(JSON.parse(readFileSync(t.file, "utf8")).projects.a).toMatchObject({ keys: { audit: "observe" } });
  }, 60_000);
});
