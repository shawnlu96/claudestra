/**
 * dispatch-recovery-LCFG1W: the machine namespace of recovery-policy.json — reader (default observe, three modes, clear,
 * unknown / bad → off), owner / master only writes with zero write on refusal, the shared lock / atomic writer /
 * prepared-published-void audits, and project + machine sections coexisting under concurrent saves.
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MASTER_PROJECT } from "../src/lib/ledger-asks.js";
import { listEvents, openLedger, type LedgerError } from "../src/lib/ledger-store.js";
import { appendEvent, setMeta } from "../src/lib/ledger-write.js";
import { machineRecoveryPolicies, machineRecoveryPolicy, parseMachineSection, setMachineRecovery } from "../src/lib/recovery-machine-policy.js";
import { recoveryPolicy, setRecovery } from "../src/lib/recovery-policy.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const PM = "agent-pm-a", DISP = "agent-helper", EXEC = "agent-task-x";
let db: Database, path: string;
const snap = () => (existsSync(path) ? { bytes: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs } : null);
const file = () => JSON.parse(readFileSync(path, "utf8"));
const ops = () => listEvents(db, {}).map((e) => e.data.op).filter((o) => String(o).startsWith("scheduler_recovery"));
const mode = () => machineRecoveryPolicy("lendConfigFailure", path).mode;
const set = (actor: string, m: "on" | "observe" | "off" | "inherit", extra: { dedupKey?: string } = {}) =>
  setMachineRecovery(db, { actor, now: 5, ...extra }, { set: { key: "lendConfigFailure", mode: m }, reason: "r" }, { path });
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as LedgerError).code);

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "recovery-machine-")), "recovery-policy.json");
  db = openLedger(tempLedgerPath("recovery-machine-db-"));
  const owner = { actor: "owner", now: 1 };
  setMeta(db, owner, { project: "a", key: "pms", value: [PM, DISP] });
  setMeta(db, owner, { project: "a", key: "team", value: { dispatcher: DISP, audit: true } });
});

describe("reader", () => {
  test("missing file / old project-only file = observe default; a project entry (even lend) never answers the machine key", () => {
    expect(machineRecoveryPolicy("lendConfigFailure", path)).toEqual({ mode: "observe", manualAfterMs: null, source: "default" });
    writeFileSync(path, JSON.stringify({ projects: { lend: { mode: "on", keys: { lendConfigFailure: "on" } }, a: { mode: "off" } } }));
    expect(machineRecoveryPolicy("lendConfigFailure", path)).toEqual({ mode: "observe", manualAfterMs: null, source: "default" });
    expect(recoveryPolicy("a", "audit", path).mode).toBe("off"); // old file reads exactly as before
  });

  test("three modes from machine.<key>; project modes do not override it, and it does not leak into projects", () => {
    for (const m of ["on", "observe", "off"] as const) {
      writeFileSync(path, JSON.stringify({ projects: { a: { mode: m === "on" ? "off" : "on" } }, machine: { lendConfigFailure: { mode: m, rev: 3 } } }));
      expect(machineRecoveryPolicy("lendConfigFailure", path)).toEqual({ mode: m, manualAfterMs: null, source: "config" });
      expect(recoveryPolicy("a", "lendConfigFailure", path).mode).toBe(m === "on" ? "off" : "on");
    }
    writeFileSync(path, JSON.stringify({ projects: {}, machine: { lendConfigFailure: { rev: 3 } } })); // cleared: rev only
    expect(machineRecoveryPolicy("lendConfigFailure", path)).toMatchObject({ mode: "observe", source: "default" });
    expect(Object.keys(machineRecoveryPolicies(path))).toEqual(["lendConfigFailure"]);
  });

  test("unknown machine key / bad mode / bad rev → machine readers answer off; project readers keep their own entries", () => {
    for (const machine of [{ lendConfigFailur: { mode: "on" } }, { lendConfigFailure: { mode: "sometimes" } }, { lendConfigFailure: { mode: "on", rev: 0 } },
      { lendConfigFailure: { mode: "on", extra: 1 } }, { lendConfigFailure: "on" }]) {
      writeFileSync(path, JSON.stringify({ projects: { a: { mode: "on" } }, machine }));
      expect([machine, machineRecoveryPolicy("lendConfigFailure", path)]).toEqual([machine, expect.objectContaining({ mode: "off", source: "error" })]);
      expect(recoveryPolicy("a", "audit", path)).toMatchObject({ mode: "on", source: "config" });
    }
    for (const machine of [[], "on", null]) { // not even an object: the file's shape is broken for everyone
      writeFileSync(path, JSON.stringify({ projects: { a: { mode: "on" } }, machine }));
      expect([machine, mode(), recoveryPolicy("a", "audit", path).mode]).toEqual([machine, "off", "off"]);
    }
    writeFileSync(path, "{not json");
    expect(machineRecoveryPolicy("lendConfigFailure", path)).toMatchObject({ mode: "off", source: "error", diagnostic: expect.stringContaining("读不了") });
    writeFileSync(path, JSON.stringify({ projects: {}, other: {} }));
    expect(mode()).toBe("off");
    expect(machineRecoveryPolicy("bogus" as never, path)).toMatchObject({ mode: "off", source: "error", diagnostic: expect.stringContaining("未知整机恢复键") });
    expect(() => parseMachineSection({ x: {} })).toThrow();
  });
});

describe("writer: owner / master only", () => {
  test("owner and master switch; inherit clears; audited prepared → published; no-op is not an event", async () => {
    expect(await set("owner", "on")).toMatchObject({ changed: true, from: { mode: null }, to: { mode: "on" } });
    expect(mode()).toBe("on");
    const audits = listEvents(db, {}).filter((e) => e.data.op === "scheduler_recovery_machine");
    expect(audits.map((e) => [e.actor, e.project, e.kind, e.data.key, e.data.publish])).toEqual([["owner", MASTER_PROJECT, "decision", "lendConfigFailure", "prepared"]]);
    expect(file()).toEqual({ projects: {}, machine: { lendConfigFailure: { mode: "on", rev: audits[0]!.seq } } });
    expect(await set("master", "off")).toMatchObject({ changed: true, to: { mode: "off" } });
    expect(await set("owner", "off")).toMatchObject({ changed: false, event: null });
    expect(await set("master", "inherit")).toMatchObject({ changed: true, to: { mode: null } });
    expect([mode(), file().machine.lendConfigFailure]).toEqual(["observe", { rev: expect.any(Number) }]);
    expect(ops()).toEqual(["scheduler_recovery_machine", "scheduler_recovery_published", "scheduler_recovery_machine", "scheduler_recovery_published",
      "scheduler_recovery_machine", "scheduler_recovery_published"]);
  });

  test("project PM / dispatcher / executor / peer / guest / scheduler / unknown are refused: zero write, zero audit", async () => {
    for (const actor of [PM, DISP, EXEC, "peer:team-b", "guest", "scheduler", "unknown", "import"]) {
      expect([actor, await code(set(actor, "on"))]).toEqual([actor, "forbidden"]);
    }
    expect([snap(), ops()]).toEqual([null, []]);
    writeFileSync(path, JSON.stringify({ projects: { a: { mode: "on" } } }));
    const before = snap();
    expect(await code(set(PM, "off"))).toBe("forbidden");
    expect([snap(), ops()]).toEqual([before, []]);
  });

  test("bad key / bad mode → invalid; corrupt file is refused and never overwritten", async () => {
    expect(await code(setMachineRecovery(db, { actor: "owner", now: 1 }, { set: { key: "audit" as never, mode: "on" }, reason: "r" }, { path }))).toBe("invalid");
    expect(await code(setMachineRecovery(db, { actor: "owner", now: 1 }, { set: { key: "lendConfigFailure", mode: "ON" as never }, reason: "r" }, { path }))).toBe("invalid");
    expect(snap()).toBeNull();
    writeFileSync(path, JSON.stringify({ projects: {}, machine: { lendConfigFailure: { mode: "maybe" } } }));
    const before = snap();
    expect(await code(set("owner", "on"))).toBe("invalid");
    expect([snap(), ops()]).toEqual([before, []]);
  });

  test("--dedup replays without a second write; the same key for another op is a mismatch", async () => {
    expect(await set("owner", "on", { dedupKey: "m1" })).toMatchObject({ changed: true });
    const before = snap();
    expect(await set("owner", "on", { dedupKey: "m1" })).toMatchObject({ duplicate: true, changed: false, to: { mode: "on" } });
    expect(snap()).toEqual(before);
    await expect(setRecovery(db, { actor: "owner", now: 6, dedupKey: "m1" }, { project: "a", set: { mode: "on" }, reason: "r" }, { path })).rejects.toMatchObject({ code: "dedup_mismatch" });
    expect(ops().filter((o) => o === "scheduler_recovery_machine")).toHaveLength(1);
  });

  test("lock held elsewhere → busy, nothing written", async () => {
    mkdirSync(`${path}.lock`, { recursive: true });
    writeFileSync(join(`${path}.lock`, "owner"), "someone-else");
    await expect(setMachineRecovery(db, { actor: "owner", now: 1 }, { set: { key: "lendConfigFailure", mode: "on" }, reason: "r" }, { path, lockMs: 300 }))
      .rejects.toMatchObject({ code: "busy" });
    expect([snap(), ops()]).toEqual([null, []]);
  });

  test("publish fails after COMMIT → busy, old file kept, audit voided, its --dedup can't replay as done", async () => {
    writeFileSync(path, JSON.stringify({ projects: { a: { mode: "on" } }, machine: { lendConfigFailure: { mode: "off" } } }));
    const dir = join(path, "..");
    let txs = 0;
    const faulty = new Proxy(db, { get: (t, k) => k !== "transaction" ? Reflect.get(t, k, t).bind?.(t) ?? Reflect.get(t, k, t)
      : (fn: () => unknown) => ({ immediate: () => { if (txs) chmodSync(dir, 0o700); const v = t.transaction(fn).immediate(); if (!txs++) chmodSync(dir, 0o500); return v; } }) });
    const r = await code(setMachineRecovery(faulty, { actor: "owner", now: 5, dedupKey: "k1" }, { set: { key: "lendConfigFailure", mode: "on" }, reason: "x" }, { path })
      .finally(() => chmodSync(dir, 0o700)));
    expect(r).toBe("busy");
    expect(mode()).toBe("off");
    expect(ops()).toEqual(["scheduler_recovery_machine", "scheduler_recovery_void"]);
    expect(await code(set("owner", "on", { dedupKey: "k1" }))).toBe("dedup_mismatch");
    expect(await set("owner", "on", { dedupKey: "k2" })).toMatchObject({ changed: true });
    expect(mode()).toBe("on");
  });

  test("a pending machine audit (setter died between COMMIT and notes) is settled from the file's rev before the next change", async () => {
    writeFileSync(path, JSON.stringify({ projects: {}, machine: { lendConfigFailure: { mode: "on" } } }));
    const ghost = appendEvent(db, { actor: "owner", now: 2, dedupKey: "g1" }, { project: MASTER_PROJECT, target: "", kind: "decision", text: "died",
      data: { op: "scheduler_recovery_machine", key: "lendConfigFailure", from: { mode: "on" }, to: { mode: "off" }, publish: "prepared" } });
    expect(await code(set("owner", "off", { dedupKey: "g1" }))).toBe("dedup_mismatch"); // settled void (file rev ≠ its seq), never "done"
    expect(listEvents(db, {}).filter((e) => e.data.op === "scheduler_recovery_void").map((e) => e.data.voids)).toEqual([ghost.event.seq]);
    expect(mode()).toBe("on");
  });
});

describe("project + machine coexist", () => {
  test("project writes keep the machine section and machine writes keep every project entry", async () => {
    writeFileSync(path, JSON.stringify({ projects: { b: { mode: "off", manualStallHours: 3, keys: { audit: "on" } } } }));
    await set("owner", "on");
    expect(file().projects).toEqual({ b: { mode: "off", manualStallHours: 3, keys: { audit: "on" } } });
    await setRecovery(db, { actor: PM, now: 6 }, { project: "a", set: { mode: "off" }, reason: "r" }, { path });
    expect(file().machine).toEqual({ lendConfigFailure: { mode: "on", rev: expect.any(Number) } });
    expect([mode(), recoveryPolicy("a", "audit", path).mode, recoveryPolicy("b", "audit", path).mode]).toEqual(["on", "off", "on"]);
  });

  test("concurrent project and machine saves serialize on the one lock: every field lands, one audit each", async () => {
    const results = await Promise.all([
      set("owner", "on"),
      setRecovery(db, { actor: PM, now: 1 }, { project: "a", set: { mode: "off" }, reason: "1" }, { path }),
      setRecovery(db, { actor: "owner", now: 2 }, { project: "a", set: { manualStallHours: 4 }, reason: "2" }, { path }),
      set("master", "on"),
      setRecovery(db, { actor: "master", now: 3 }, { project: "b", set: { key: "planGap", mode: "on" }, reason: "3" }, { path }),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(4);
    expect(file()).toEqual({
      projects: { a: { mode: "off", manualStallHours: 4, rev: expect.any(Number) }, b: { keys: { planGap: "on" }, rev: expect.any(Number) } },
      machine: { lendConfigFailure: { mode: "on", rev: expect.any(Number) } },
    });
    expect(ops().filter((o) => o === "scheduler_recovery_published")).toHaveLength(4);
  });
});
