/**
 * dispatch-recovery-CFG: `ledger scheduler-recovery` — audited write of recovery-policy.json (never scheduler.json),
 * mode by PM / master / owner, manualStallHours by owner only, bad files refused, concurrent writers serialized,
 * and the real manager.ts CLI refusing unknown / scheduler-service / lend-worker callers.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
/** each published entry carries rev = seq of the audit that wrote it (proof of publish, review r4) */
const REV = expect.any(Number);
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
    expect(Object.keys(r.policies)).toHaveLength(12);
    expect(r.policies.manualMergeQueue).toEqual({ mode: "observe", manualAfterMs: null, source: "default" });
    expect([snap(), decisions()]).toEqual([null, []]);
    expect((await run(EXEC, "zz")).code).toBe("not_found");
  });
});

describe("mode: PM / master / owner", () => {
  test("PM switches; audited decision; file holds only recovery; no-op is not an event", async () => {
    const r = await run(PM_A, "a", "on", "--reason", "实测");
    expect(r).toMatchObject({ ok: true, changed: true, from: { mode: null, manualStallHours: null, keys: {} }, to: { mode: "on", manualStallHours: null, keys: {} } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { a: { mode: "on", rev: decisions().at(-1)!.seq } } });
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
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { a: { mode: "off", rev: REV } } });
    expect((await run(EXEC, "a", "on", "--key", "audit", "--reason", "r")).code).toBe("forbidden");
  });

  test("--key placementReservations: PM overrides and inherits like the other keys; an unknown --key is invalid", async () => {
    expect(await run(PM_A, "a", "off", "--key", "placementReservations", "--reason", "r")).toMatchObject({ ok: true, changed: true });
    expect([recoveryPolicy("a", "placementReservations", path).mode, recoveryPolicy("a", "audit", path).mode]).toEqual(["off", "observe"]);
    expect(await run(PM_A, "a", "inherit", "--key", "placementReservations", "--reason", "r")).toMatchObject({ ok: true, changed: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { a: { rev: REV } } });
    expect(await run(PM_A, "a", "on", "--key", "placement", "--reason", "r")).toMatchObject({ ok: false, code: "invalid" });
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
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { a: { mode: "on", rev: REV } } });
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
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ projects: { b: { mode: "off", manualStallHours: 3 }, a: { mode: "on", rev: REV } } });
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
    expect(JSON.parse(readFileSync(path, "utf8")).projects).toEqual({ a: { mode: "on", manualStallHours: 4, rev: REV }, b: { mode: "off", rev: REV } });
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

/** Review r2: audit INSERT succeeds, COMMIT is refused (DELETE journal + an outside shared read lock), in a separate setter process. */
describe("COMMIT busy (review r2)", () => {
  test("the uncommitted mode is never readable: no recovery runs while COMMIT waits, setter busy, file and audit stay old", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recovery-commit-busy-"));
    const ledger = join(dir, "ledger.sqlite"), file = join(dir, "recovery-policy.json"), go = join(dir, "go");
    writeFileSync(file, JSON.stringify({ projects: { a: { mode: "off" } } }));
    const lib = join(import.meta.dir, "../src/lib");
    const script = join(dir, "setter.ts");
    writeFileSync(script, `
      import { existsSync } from "node:fs";
      import { openLedger, LedgerError } from ${JSON.stringify(join(lib, "ledger-store.ts"))};
      import { setRecovery } from ${JSON.stringify(join(lib, "recovery-policy.ts"))};
      const db = openLedger(${JSON.stringify(ledger)});
      db.exec("PRAGMA journal_mode = DELETE");
      console.log("ready");
      while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(20);
      try { await setRecovery(db, { actor: "owner", now: 5 }, { project: "a", set: { mode: "on" }, reason: "probe" }, { path: ${JSON.stringify(file)} }); console.log(JSON.stringify({ ok: true })); }
      catch (e) { console.log(JSON.stringify({ ok: false, code: e instanceof LedgerError ? e.code : String(e) })); }
    `);
    const proc = Bun.spawn([process.execPath, "--no-env-file", script], { env: testChildEnv({ CLAUDESTRA_STATE_DIR: dir, CLAUDESTRA_RUNTIME_DIR: join(dir, "run") }), stdout: "pipe", stderr: "pipe" });
    const out = new Response(proc.stdout).text();
    while (!existsSync(ledger) || !(await Bun.file(ledger).exists())) await Bun.sleep(20);
    await Bun.sleep(1_500); // child opened the ledger and switched to DELETE
    const reader = new Database(ledger);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM events").get(); // shared lock: the setter's RESERVED is fine, its COMMIT is not
    writeFileSync(go, "");
    let acted = 0, done = false;
    const seen = new Set<string>();
    proc.exited.finally(() => { done = true; });
    const gdb = new Database(":memory:");
    while (!done) {
      seen.add(recoveryPolicy("a", "audit", file).mode);
      await gateRecovery(gdb, { project: "a", mechanism: "audit", target: "", actionKey: "probe", action: "probe" }, () => ++acted,
        { now: 1, policy: (p, m) => recoveryPolicy(p, m, file) });
      await Bun.sleep(20);
    }
    reader.exec("ROLLBACK");
    reader.close();
    expect(JSON.parse((await out).trim().split("\n").at(-1)!)).toEqual({ ok: false, code: "busy" });
    expect([acted, [...seen], recoveryPolicy("a", "audit", file).mode]).toEqual([0, ["off"], "off"]);
    expect(listEvents(openLedger(ledger), {}).filter((e) => e.data.op === "scheduler_recovery")).toHaveLength(0);
  }, 60_000);

  test("publish fails after COMMIT → busy, old file kept, the committed audit is voided and its --dedup can't replay as done", async () => {
    writeFileSync(path, JSON.stringify({ projects: { a: { mode: "off" } } }));
    const { chmodSync } = await import("node:fs");
    const dir = join(path, "..");
    // after the audit tx committed the directory turns read-only (the atomic write's temp file cannot be created);
    // the next tx (the void note) gives it back so the lock can be released
    let txs = 0;
    const faulty = new Proxy(db, { get: (t, k) => k !== "transaction" ? Reflect.get(t, k, t).bind?.(t) ?? Reflect.get(t, k, t)
      : (fn: () => unknown) => ({ immediate: () => { if (txs) chmodSync(dir, 0o700); const v = t.transaction(fn).immediate(); if (!txs++) chmodSync(dir, 0o500); return v; } }) });
    let r: Record<string, any>;
    try {
      r = await setRecovery(faulty, { actor: "owner", now: 5, dedupKey: "k1" }, { project: "a", set: { mode: "on" }, reason: "x" }, { path })
        .catch((e) => ({ ok: false, code: (e as LedgerError).code }));
    } finally { chmodSync(dir, 0o700); }
    expect(r).toMatchObject({ ok: false, code: "busy" });
    expect(recoveryPolicy("a", "audit", path).mode).toBe("off");
    const ev = decisions().filter((e) => e.data.op === "scheduler_recovery");
    expect(ev).toHaveLength(1);
    expect(listEvents(db, {}).filter((e) => e.data.op === "scheduler_recovery_void").map((e) => e.data.voids)).toEqual([ev[0]!.seq]);
    expect(await run("owner", "a", "on", "--reason", "x", "--dedup", "k1")).toMatchObject({ ok: false, code: "dedup_mismatch" });
    expect(await run("owner", "a", "on", "--reason", "x", "--dedup", "k2")).toMatchObject({ ok: true, changed: true });
    expect(recoveryPolicy("a", "audit", path).mode).toBe("on");
  });
});

/**
 * Review r4 publish-gap-dedup: the audit is committed but the file is not (yet) published — the setter process dies in
 * between, or the publish fails and so does its void note. A --dedup retry through the real manager CLI must not answer
 * "done, to=off" while the file still says on; the next setter settles the audit from the file's rev, not by comparing modes.
 */
describe("publish gap after COMMIT (review r4)", () => {
  const setup = () => {
    const state = mkdtempSync(join(tmpdir(), "recovery-gap-"));
    writeFileSync(join(state, "projects.json"), JSON.stringify({ projects: [{ id: "a", name: "A", dirs: [state] }] }));
    const env = { CLAUDESTRA_STATE_DIR: state, CLAUDESTRA_RUNTIME_DIR: join(state, "run") };
    const file = join(state, "recovery-policy.json"), ledger = join(state, "ledger.sqlite");
    const cli = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "../src/manager.ts"), "ledger", "scheduler-recovery", ...args],
        { env: testChildEnv(env), stdout: "pipe", stderr: "pipe" });
      const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "{}");
      await proc.exited;
      return out as Record<string, any>;
    };
    /** a setter process that dies (exit 9, lock left behind) right after its crashAfter-th top-level ledger tx returned */
    const crashingSetter = async (crashAfter: number, args: { mode: string; dedupKey: string }) => {
      const lib = join(import.meta.dir, "../src/lib"), script = join(state, "crash.ts");
      writeFileSync(script, `
        import { openLedger } from ${JSON.stringify(join(lib, "ledger-store.ts"))};
        import { setRecovery } from ${JSON.stringify(join(lib, "recovery-policy.ts"))};
        const db = openLedger(${JSON.stringify(ledger)});
        let depth = 0, txs = 0;
        const crashy = new Proxy(db, { get: (t, k) => k !== "transaction" ? Reflect.get(t, k, t).bind?.(t) ?? Reflect.get(t, k, t)
          : (fn) => ({ immediate: () => { depth++; try { return t.transaction(fn).immediate(); } finally { if (!--depth && ++txs === ${crashAfter}) process.exit(9); } } }) });
        await setRecovery(crashy, { actor: "owner", now: 5, dedupKey: ${JSON.stringify(args.dedupKey)} },
          { project: "a", set: { mode: ${JSON.stringify(args.mode)} }, reason: "crash probe" }, { path: ${JSON.stringify(file)} });
        process.exit(0);
      `);
      const proc = Bun.spawn([process.execPath, "--no-env-file", script], { env: testChildEnv(env), stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      // the dead holder's lock: age it past the stale window so the next setter reclaims it, as it would in production
      if (existsSync(`${file}.lock`)) utimesSync(`${file}.lock`, new Date(0), new Date(0));
      return code;
    };
    const acted = async () => {
      let n = 0;
      await gateRecovery(new Database(":memory:"), { project: "a", mechanism: "audit", target: "", actionKey: "probe", action: "probe" }, () => ++n,
        { now: 1, policy: (p, m) => recoveryPolicy(p, m, file) });
      return n;
    };
    const ops = () => listEvents(openLedger(ledger), {}).map((e) => e.data.op).filter((o) => String(o).startsWith("scheduler_recovery"));
    return { cli, crashingSetter, acted, file, ops };
  };

  test("crash between COMMIT and publish: the --dedup retry is refused as not in effect, the file stays on, a new key then applies", async () => {
    const { cli, crashingSetter, acted, file, ops } = setup();
    expect(await cli("a", "on", "--reason", "start")).toMatchObject({ ok: true, changed: true });
    expect(await crashingSetter(1, { mode: "off", dedupKey: "k1" })).toBe(9);
    expect(recoveryPolicy("a", "audit", file).mode).toBe("on");
    const retry = await cli("a", "off", "--reason", "retry", "--dedup", "k1");
    expect(retry).toMatchObject({ ok: false, code: "dedup_mismatch" });
    expect([recoveryPolicy("a", "audit", file).mode, await acted()]).toEqual(["on", 1]); // honestly on, and nobody was told off
    expect(ops()).toEqual(["scheduler_recovery", "scheduler_recovery_published", "scheduler_recovery", "scheduler_recovery_void"]);
    expect(await cli("a", "off", "--reason", "retry", "--dedup", "k2")).toMatchObject({ ok: true, changed: true, to: { mode: "off" } });
    expect([recoveryPolicy("a", "audit", file).mode, await acted()]).toEqual(["off", 0]);
  }, 60_000);

  test("crash after publish, before the published note: the retry settles it as done (file rev), duplicate with the file really off", async () => {
    const { cli, crashingSetter, acted, file, ops } = setup();
    expect(await cli("a", "on", "--reason", "start")).toMatchObject({ ok: true, changed: true });
    expect(await crashingSetter(2, { mode: "off", dedupKey: "k1" })).toBe(9);
    expect(await cli("a", "off", "--reason", "retry", "--dedup", "k1")).toMatchObject({ ok: true, duplicate: true, to: { mode: "off" } });
    expect([recoveryPolicy("a", "audit", file).mode, await acted()]).toEqual(["off", 0]);
    expect(ops()).toEqual(["scheduler_recovery", "scheduler_recovery_published", "scheduler_recovery", "scheduler_recovery_published"]);
  }, 60_000);

  test("a later change of the project first settles the pending audit; the old --dedup retry can't then claim it", async () => {
    const { cli, crashingSetter, file, ops } = setup();
    expect(await cli("a", "on", "--reason", "start")).toMatchObject({ ok: true, changed: true });
    expect(await crashingSetter(1, { mode: "off", dedupKey: "k1" })).toBe(9);
    expect(await cli("a", "observe", "--key", "audit", "--reason", "later")).toMatchObject({ ok: true, changed: true, from: { mode: "on" } });
    expect(await cli("a", "off", "--reason", "retry", "--dedup", "k1")).toMatchObject({ ok: false, code: "dedup_mismatch" });
    expect([recoveryPolicy("a", "audit", file).mode, recoveryPolicy("a", "materials", file).mode]).toEqual(["observe", "on"]);
    expect(ops().filter((o) => o === "scheduler_recovery_void")).toHaveLength(1);
  }, 60_000);

  test("publish fails and the void note fails too: the retry is refused (settled void from the file), never ok/duplicate", async () => {
    writeFileSync(path, JSON.stringify({ projects: { a: { mode: "on" } } }));
    const { chmodSync } = await import("node:fs");
    const dir = join(path, "..");
    // after the audit tx the directory turns read-only (publish fails); the next tx of this setter (the void note) throws
    let depth = 0, txs = 0;
    const faulty = new Proxy(db, { get: (t, k) => k !== "transaction" ? Reflect.get(t, k, t).bind?.(t) ?? Reflect.get(t, k, t)
      : (fn: () => unknown) => ({ immediate: () => {
        if (!depth && txs) { chmodSync(dir, 0o700); throw new Error("void write failed (injected)"); } // perms back so the lock can be released
        depth++;
        try { return t.transaction(fn).immediate(); } finally { if (!--depth && !txs++) chmodSync(dir, 0o500); }
      } }) });
    const r = await setRecovery(faulty, { actor: "owner", now: 5, dedupKey: "k1" }, { project: "a", set: { mode: "off" }, reason: "x" }, { path })
      .catch((e) => ({ ok: false, code: (e as LedgerError).code })).finally(() => chmodSync(dir, 0o700));
    expect(r).toMatchObject({ ok: false, code: "busy" });
    expect(listEvents(db, {}).map((e) => e.data.op).filter((o) => String(o).startsWith("scheduler_recovery"))).toEqual(["scheduler_recovery"]);
    expect(await run("owner", "a", "off", "--reason", "x", "--dedup", "k1")).toMatchObject({ ok: false, code: "dedup_mismatch" });
    expect(recoveryPolicy("a", "audit", path).mode).toBe("on");
    expect(await run("owner", "a", "off", "--reason", "x", "--dedup", "k2")).toMatchObject({ ok: true, changed: true });
    expect(recoveryPolicy("a", "audit", path).mode).toBe("off");
  });
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
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ projects: { a: { mode: "on", manualStallHours: 6, rev: 1 } } });
    expect(existsSync(join(state, "scheduler.json"))).toBe(false); // the scheduler config is never touched
  }, 60_000);
});
