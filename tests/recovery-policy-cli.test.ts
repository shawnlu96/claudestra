/**
 * dispatch-recovery-CFG: `ledger scheduler-recovery` — audited write of recovery-policy.json (never scheduler.json),
 * mode by PM / master / owner, manualStallHours by owner only, bad files refused, concurrent writers serialized,
 * and the real manager.ts CLI refusing unknown / scheduler-service / lend-worker callers.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import { gateRecovery, recoveryPolicy, setRecovery } from "../src/lib/recovery-policy.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import { LedgerCli, type LedgerDeps } from "../src/manager/ledger-context.js";
import { parseLedgerArgs } from "../src/manager/ledger-identity.js";
import { recoveryCmds } from "../src/manager/ledger-recovery-cmds.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";
import { testChildEnv } from "./test-env.js";

const PM_A = "agent-pm-a", PM_B = "agent-pm-b", DISP = "agent-helper", EXEC = "agent-task-x";
let db: Database, path: string;
const deps = (actor: string): LedgerDeps => ({ db, actor, projectIds: ["a", "b"], now: () => 9_000,
  loadRegistry: async () => ({ socket: "s", agents: {} }) as Registry, saveRegistry: async () => {} });
async function run(actor: string, ...args: string[]): Promise<Record<string, any>> {
  const spec = recoveryCmds(path)["scheduler-recovery"]!;
  const p = parseLedgerArgs(["scheduler-recovery", ...args], spec.valued, spec.bools);
  if ("error" in p) return { ok: false, code: "invalid", error: p.error };
  try { return await spec.run(new LedgerCli(deps(actor), p)); }
  catch (e) { if (e instanceof LedgerError) return { ok: false, code: e.code, error: e.message }; throw e; }
}
const snap = () => (existsSync(path) ? { bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs } : null);
const decisions = () => listEvents(db, {}).filter((e) => e.kind === "decision");

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "recovery-cli-")), "recovery-policy.json");
  db = openLedger(tempLedgerPath("recovery-cli-db-"));
  const owner = { actor: "owner", now: 1 };
  setMeta(db, owner, { project: "a", key: "pms", value: [PM_A, DISP] });
  setMeta(db, owner, { project: "a", key: "team", value: { dispatcher: DISP, audit: true } });
  setMeta(db, owner, { project: "b", key: "pms", value: [PM_B] });
});

describe("show", () => {
  test("no mode, no threshold = read: default observe, nothing written", async () => {
    const r = await run(EXEC, "a");
    expect(r).toMatchObject({ ok: true, project: "a", observed: [] });
    expect(r.policies.materials).toEqual({ mode: "observe", manualAfterMs: null, source: "default" });
    expect(Object.keys(r.policies)).toHaveLength(8);
    expect([snap(), decisions()]).toEqual([null, []]);
    expect((await run(EXEC, "zz")).code).toBe("not_found");
  });
});

describe("mode: PM / master / owner", () => {
  test("PM switches; audited decision; file holds only recovery; no-op is not an event", async () => {
    const r = await run(PM_A, "a", "on", "--reason", "实测");
    expect(r).toMatchObject({ ok: true, changed: true, from: { mode: null, manualStallHours: null, keys: {} }, to: { mode: "on", manualStallHours: null, keys: {} } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { a: { mode: "on" } } });
    expect(recoveryPolicy("a", "audit", path).mode).toBe("on");
    expect(recoveryPolicy("b", "audit", path).mode).toBe("observe");
    expect(decisions().map((e) => [e.actor, e.project, e.text, e.data.op])).toEqual([[PM_A, "a", "实测", "scheduler_recovery"]]);
    expect(await run("master", "a", "off", "--reason", "停")).toMatchObject({ ok: true, changed: true });
    expect(await run("owner", "a", "off", "--reason", "再停")).toMatchObject({ ok: true, changed: false, event: null });
    expect(decisions()).toHaveLength(2);
  });

  test("executor, dispatcher, other project's PM, unknown, scheduler are refused; nothing written", async () => {
    for (const actor of [EXEC, DISP, PM_B, "unknown", "scheduler"]) {
      expect([actor, (await run(actor, "a", "on", "--reason", "r")).code]).toEqual([actor, "forbidden"]);
    }
    expect([snap(), decisions()]).toEqual([null, []]);
  });

  test("--dedup replays without a second write", async () => {
    expect(await run(PM_A, "a", "on", "--reason", "r", "--dedup", "k1")).toMatchObject({ changed: true });
    const before = snap();
    expect(await run(PM_A, "a", "on", "--reason", "r", "--dedup", "k1")).toMatchObject({ ok: true, duplicate: true, changed: false });
    expect(await run(PM_A, "b", "on", "--reason", "r", "--dedup", "k1")).toMatchObject({ ok: false });
    expect(snap()).toEqual(before);
    expect(decisions()).toHaveLength(1);
  });
});

describe("per-key override", () => {
  test("PM sets one key; others follow the project mode; inherit drops the override and leaves no residue", async () => {
    expect(await run(PM_A, "a", "on", "--key", "planGap", "--reason", "只开 planGap")).toMatchObject({ ok: true, changed: true, to: { mode: null, keys: { planGap: "on" } } });
    expect([recoveryPolicy("a", "planGap", path).mode, recoveryPolicy("a", "audit", path).mode]).toEqual(["on", "observe"]);
    expect(await run(PM_A, "a", "off", "--reason", "全停，planGap 仍覆盖")).toMatchObject({ ok: true });
    expect([recoveryPolicy("a", "planGap", path).mode, recoveryPolicy("a", "audit", path).mode]).toEqual(["on", "off"]);
    expect(await run(PM_A, "a", "inherit", "--key", "planGap", "--reason", "撤掉")).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { a: { mode: "off" } } });
    expect((await run(EXEC, "a", "on", "--key", "audit", "--reason", "r")).code).toBe("forbidden");
  });
});

describe("manualStallHours: owner only", () => {
  test("owner sets and clears; PM / master cannot, even together with a mode they could set", async () => {
    for (const actor of [PM_A, "master", EXEC]) {
      expect([actor, (await run(actor, "a", "on", "--manual-stall-hours", "6", "--reason", "r")).code]).toEqual([actor, "forbidden"]);
      expect([actor, (await run(actor, "a", "--manual-stall-hours", "none", "--reason", "r")).code]).toEqual([actor, "forbidden"]);
    }
    expect(snap()).toBeNull();
    expect(await run("owner", "a", "--manual-stall-hours", "6", "--reason", "owner 定 6 小时")).toMatchObject({ ok: true, to: { mode: null, manualStallHours: 6 } });
    expect(recoveryPolicy("a", "manualStall", path)).toEqual({ mode: "observe", manualAfterMs: 6 * 3_600_000, source: "config" });
    expect(await run(PM_A, "a", "on", "--reason", "r")).toMatchObject({ ok: true }); // PM's mode switch keeps the owner's number
    expect(recoveryPolicy("a", "manualStall", path)).toEqual({ mode: "on", manualAfterMs: 6 * 3_600_000, source: "config" });
    expect(await run("owner", "a", "--manual-stall-hours", "none", "--reason", "清掉")).toMatchObject({ ok: true, to: { mode: "on", manualStallHours: null } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { a: { mode: "on" } } });
  });
});

describe("bad input / bad file", () => {
  test("bad arguments → invalid, nothing written", async () => {
    for (const args of [["a", "ON", "--reason", "r"], ["a", "pause", "--reason", "r"], ["a", "on"], ["a", "on", "x", "--reason", "r"], [],
      ["a", "--manual-stall-hours", "0", "--reason", "r"], ["a", "--manual-stall-hours", "721", "--reason", "r"], ["a", "--manual-stall-hours", "1.5", "--reason", "r"],
      ["a", "--last", "0"], ["a", "--key", "audit", "--reason", "r"], ["a", "on", "--key", "nudge", "--reason", "r"], ["a", "inherit", "--reason", "r"]]) {
      expect([args, (await run("owner", ...args)).code]).toEqual([args, "invalid"]);
    }
    expect(snap()).toBeNull();
  });

  test("corrupt file is reported as off and never overwritten", async () => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ projects: { a: { mode: "sometimes" } } }));
    const before = snap();
    expect((await run(PM_A, "a")).policies.audit).toMatchObject({ mode: "off", source: "error" });
    expect((await run(PM_A, "a", "on", "--reason", "r")).code).toBe("invalid");
    expect([snap(), decisions()]).toEqual([before, []]);
  });

  test("other projects' entries are kept untouched", async () => {
    writeFileSync(path, JSON.stringify({ projects: { b: { mode: "off", manualStallHours: 3 } } }));
    expect(await run(PM_A, "a", "on", "--reason", "r")).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { b: { mode: "off", manualStallHours: 3 }, a: { mode: "on" } } });
  });
});

describe("concurrency", () => {
  test("parallel writers serialize under the lock: every change lands, one event each", async () => {
    const results = await Promise.all([
      setRecovery(db, { actor: PM_A, now: 1 }, { project: "a", set: { mode: "on" }, reason: "1" }, { path }),
      setRecovery(db, { actor: "owner", now: 2 }, { project: "a", set: { manualStallHours: 4 }, reason: "2" }, { path }),
      setRecovery(db, { actor: PM_B, now: 3 }, { project: "b", set: { mode: "off" }, reason: "3" }, { path }),
    ]);
    expect(results.every((r) => r.changed)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).projects).toEqual({ a: { mode: "on", manualStallHours: 4 }, b: { mode: "off" } });
    expect(decisions()).toHaveLength(3);
  });

  test("lock held elsewhere → busy, nothing written", async () => {
    mkdirSync(`${path}.lock`, { recursive: true });
    writeFileSync(join(`${path}.lock`, "owner"), "someone-else");
    await expect(setRecovery(db, { actor: PM_A, now: 1 }, { project: "a", set: { mode: "on" }, reason: "r" }, { path, lockMs: 300 }))
      .rejects.toMatchObject({ code: "busy" });
    expect([snap(), decisions()]).toEqual([null, []]);
  });

  test("permission revoked while queued on the lock → forbidden after the lock, nothing written", async () => {
    const hold = () => { mkdirSync(`${path}.lock`, { recursive: true }); writeFileSync(join(`${path}.lock`, "owner"), "someone-else"); };
    hold();
    const pending = setRecovery(db, { actor: PM_A, now: 1 }, { project: "a", set: { mode: "on" }, reason: "r" }, { path });
    await Bun.sleep(100);
    setMeta(db, { actor: "owner", now: 2 }, { project: "a", key: "pms", value: [DISP] });
    rmSync(`${path}.lock`, { recursive: true });
    await expect(pending).rejects.toMatchObject({ code: "forbidden" });
    expect([snap(), decisions()]).toEqual([null, []]);
  });
});

/** Real manager.ts children against an isolated state dir; the parent holds the file lock / ledger write lock to stage the race. */
describe("real CLI races (review r1)", () => {
  const setup = () => {
    const state = mkdtempSync(join(tmpdir(), "recovery-race-state-"));
    writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "a", name: "A", dirs: [state] }] }));
    writeFileSync(join(state, "registry.json"), JSON.stringify({ socket: "s", agents: { [PM_A]: { channelId: "111" } } }));
    const env = { CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") };
    const file = join(state, "recovery-policy.json"), ledger = join(state, "ledger.sqlite");
    const cli = (extra: Record<string, string>, ...args: string[]) => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "ledger", "scheduler-recovery", ...args],
        { env: testChildEnv({ ...env, ...extra }), stdout: "pipe", stderr: "pipe" });
      return (async () => { const t = await new Response(proc.stdout).text(); await proc.exited; return JSON.parse(t.trim().split("\n").at(-1) ?? "{}"); })();
    };
    const hold = () => { mkdirSync(`${file}.lock`, { recursive: true }); writeFileSync(join(`${file}.lock`, "owner"), "parent"); };
    const release = () => rmSync(`${file}.lock`, { recursive: true });
    return { state, file, ledger, cli, hold, release };
  };
  const ledgerDecisions = (p: string) => listEvents(openLedger(p), {}).filter((e) => e.kind === "decision" && e.data.op === "scheduler_recovery");

  test("PM dropped from pms while its CLI waits for the file lock → forbidden, mode stays off", async () => {
    const t = setup();
    expect(await t.cli({}, "a", "off", "--reason", "init")).toMatchObject({ ok: true, changed: true }); // creates the ledger
    const ldb = openLedger(t.ledger);
    setMeta(ldb, { actor: "owner", now: 1 }, { project: "a", key: "pms", value: [PM_A] });
    t.hold();
    const pending = t.cli({ DISCORD_CHANNEL_ID: "111" }, "a", "on", "--reason", "probe");
    await Bun.sleep(2_500); // child is up and polling the lock
    setMeta(ldb, { actor: "owner", now: 2 }, { project: "a", key: "pms", value: [] });
    t.release();
    expect(await pending).toMatchObject({ ok: false, code: "forbidden" });
    expect(recoveryPolicy("a", "audit", t.file).mode).toBe("off");
    expect(ledgerDecisions(t.ledger)).toHaveLength(1);
  }, 60_000);

  test("ledger busy during the audit → the new mode is never visible to readers, no recovery runs, CLI busy", async () => {
    const t = setup();
    expect(await t.cli({}, "a", "off", "--reason", "init")).toMatchObject({ ok: true, changed: true });
    t.hold();
    const pending = t.cli({}, "a", "on", "--reason", "probe");
    await Bun.sleep(2_500);
    const blocker = new Database(t.ledger);
    blocker.exec("BEGIN IMMEDIATE");
    t.release();
    let acted = 0, seen = new Set<string>(), done = false;
    pending.finally(() => { done = true; });
    const gdb = new Database(":memory:");
    while (!done) {
      seen.add(recoveryPolicy("a", "audit", t.file).mode);
      const g = await gateRecovery(gdb, { project: "a", mechanism: "audit", target: "", actionKey: "probe", action: "probe" }, () => ++acted,
        { now: 1, policy: (p, m) => recoveryPolicy(p, m, t.file) });
      expect(g.outcome).toBe("skipped");
      await Bun.sleep(50);
    }
    expect(await pending).toMatchObject({ ok: false, code: "busy" });
    blocker.exec("ROLLBACK");
    blocker.close();
    expect([acted, [...seen], recoveryPolicy("a", "audit", t.file).mode]).toEqual([0, ["off"], "off"]);
    expect(ledgerDecisions(t.ledger)).toHaveLength(1);
  }, 60_000);
});

describe("registered in the ledger command family", () => {
  test("runLedger knows it; the scheduler service identity is refused before anything runs", async () => {
    const r = await runLedger(["scheduler-recovery", "a", "on", "--reason", "r"], deps("scheduler"));
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    expect(await runLedger(["help"], deps("owner"))).toMatchObject({ usage: expect.stringContaining("scheduler-recovery <project>") });
  });

  test("real manager.ts: terminal owner writes; unknown channel / scheduler service / lend worker are refused", async () => {
    const state = mkdtempSync(join(tmpdir(), "recovery-cli-state-"));
    writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "a", name: "A", dirs: [state] }] }));
    const base: Record<string, string> = { CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") };
    const cli = async (env: Record<string, string>, ...args: string[]) => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "ledger", "scheduler-recovery", ...args],
        { env: testChildEnv(env), stdout: "pipe", stderr: "pipe" });
      const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "{}");
      await proc.exited;
      return { out };
    };
    const file = join(state, "recovery-policy.json");
    // a service caller without the scheduler's lease is stopped even earlier (lease-lost); either way nothing runs
    for (const [env, codes] of [[{ ...base, DISCORD_CHANNEL_ID: "999" }, ["forbidden"]], [{ ...base, CLAUDESTRA_SCHEDULER_SERVICE: "1" }, ["forbidden", "lease-lost"]],
      [{ ...base, CLAUDESTRA_LEND_WORKER: "1" }, ["forbidden"]]] as const) {
      const r = await cli(env, "a", "on", "--manual-stall-hours", "6", "--reason", "r");
      expect([r.out.ok, codes.includes(r.out.code)]).toEqual([false, true]);
    }
    expect(existsSync(file)).toBe(false);
    expect((await cli(base, "zz", "on", "--reason", "r")).out).toMatchObject({ ok: false, code: "not_found" });
    expect((await cli(base, "a", "on", "--manual-stall-hours", "6", "--reason", "owner 实测")).out).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ projects: { a: { mode: "on", manualStallHours: 6 } } });
    expect(existsSync(join(state, "scheduler.json"))).toBe(false); // the scheduler config is never touched
  }, 60_000);
});
