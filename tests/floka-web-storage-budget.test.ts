/** WEBQUOTA1 · webStorageBudget: mirror byte budget, round undo, coalesced syncs and the on / observe / off switch. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoragePort } from "../web/lib/floka-storage/config";
import { createStorageBackend } from "../web/lib/floka-storage/database";
import type { DatabasePort, Mutation, Snapshot } from "../web/lib/floka-storage/idb";
import { migrateLocalStorage, readLegacy, writeCompatible } from "../web/lib/floka-storage/local";
import {
  budgetMode, coalescedSync, MIRROR_BUDGET_BYTES, MIRROR_ENTRY_MAX_BYTES, noteBudgetMode, resetBudgetForTest, setBudgetModeRefresher,
  setBudgetSampleSink, type BudgetSample,
} from "../web/lib/floka-storage/sync-budget";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { RecoveryPolicy } from "../src/lib/recovery-policy.js";
import { recordWebStorageSample, webStorageBudgetMode } from "../src/lib/web-storage-recovery.js";

/** localStorage with a quota in UTF-16 bytes; `onSet` lets a test race another tab into a write. */
class QuotaStorage implements StoragePort {
  data = new Map<string, string>();
  writes: string[] = [];
  failKeys = new Set<string>();
  onSet?: (key: string) => void;
  constructor(public quota = Number.POSITIVE_INFINITY) {}
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  used(except?: string) { let n = 0; for (const [k, v] of this.data) if (k !== except) n += (k.length + v.length) * 2; return n; }
  setItem(k: string, v: string) {
    if (this.failKeys.has(k) || this.used(k) + (k.length + v.length) * 2 > this.quota) throw new Error("QuotaExceededError");
    this.writes.push(k);
    this.data.set(k, v);
    this.onSet?.(k);
  }
  removeItem(k: string) { this.writes.push(`-${k}`); this.data.delete(k); }
  seed(values: Record<string, string>) { this.data = new Map(Object.entries(values)); return this; }
}

const rec = (fp: string) => ({ fp, name: fp, addedAt: 1, lastUsedAt: 2 });
/** Counts reads / mirror replaces; every call yields once, like IDB. */
class CountingPort implements DatabasePort {
  dbs = new Map<string, Snapshot>([["cstra", { machines: [rec("a")], meta: [{ key: "current", value: { fp: "a", base: "/m/a" } }] }]]);
  reads = 0;
  replaces = 0;
  async read(name: string) { this.reads++; await Promise.resolve(); return structuredClone(this.dbs.get(name) ?? { machines: [], meta: [] }); }
  async replace(name: string, snapshot: Snapshot) { this.replaces++; await Promise.resolve(); this.dbs.set(name, structuredClone(snapshot)); }
  async mutate(m: Mutation) {
    await Promise.resolve();
    const db = this.dbs.get("cstra")!;
    if (m.kind === "put") db.machines = [...db.machines.filter((r) => r.fp !== m.record.fp), m.record];
    else if (m.kind === "delete") db.machines = db.machines.filter((r) => r.fp !== m.fp);
    else db.meta = m.value ? [{ key: "current", value: m.value }] : [];
  }
}

const samples: BudgetSample[] = [];
afterEach(() => { resetBudgetForTest(); samples.length = 0; });
const collect = () => setBudgetSampleSink((s) => samples.push(s));
const big = (n: number) => "x".repeat(n);

describe("[验收线 1] quota: a failed mirror round never blocks the next legacy save", () => {
  test("on: quota-failed mirror is undone, so the next legacy save fits; off keeps the half mirror and the next save fails", () => {
    const run = (budget: "on" | "off") => {
      // Legacy a + b ≈ 2 KB of a 3.5 KB quota: the round mirrors a (≈1 KB), then b no longer fits.
      const storage = new QuotaStorage(3_500).seed({ cstra_a: big(500), cstra_b: big(500) });
      const round = migrateLocalStorage({ mode: "on", storage, budget }).status;
      const halfMirror = storage.getItem("floka_a") !== null;
      let saved = true;
      try { writeCompatible(storage, "cstra_c", big(600), "on", budget); } catch { saved = false; }
      return { round, halfMirror, saved, legacy: readLegacy(storage, "cstra_c")?.length ?? null };
    };
    expect(run("on")).toEqual({ round: "interrupted", halfMirror: false, saved: true, legacy: 600 });
    expect(run("off")).toEqual({ round: "interrupted", halfMirror: true, saved: false, legacy: null }); // baseline
  });

  test("drafts, generated css and oversized entries are never mirrored; within budget still is", () => {
    const storage = new QuotaStorage();
    writeCompatible(storage, "cstra_draft_worker", big(10), "on", "on");
    writeCompatible(storage, "cstra_theme_vars_css", big(10), "on", "on");
    writeCompatible(storage, "cstra_chat_prefs", big(MIRROR_ENTRY_MAX_BYTES), "on", "on");
    writeCompatible(storage, "cstra_theme", "dark", "on", "on");
    expect([...storage.data.keys()].filter((k) => k.startsWith("floka_"))).toEqual(["floka_theme"]);
    expect(storage.getItem("cstra_draft_worker")).toBe(big(10)); // legacy always written
  });

  test("the mirror total stays within its budget, earliest keys first", () => {
    const storage = new QuotaStorage().seed({ "rename.webStorage": "on" });
    const each = Math.floor(MIRROR_ENTRY_MAX_BYTES / 2 / 2) - 20;
    for (let i = 0; i < 20; i++) storage.data.set(`cstra_k${String(i).padStart(2, "0")}`, big(each));
    expect(migrateLocalStorage({ mode: "on", storage, budget: "on" }).status).toBe("complete");
    let mirror = 0;
    for (const [k, v] of storage.data) if (k.startsWith("floka_")) mirror += (k.length + v.length) * 2;
    expect(mirror).toBeLessThanOrEqual(MIRROR_BUDGET_BYTES);
    expect(storage.getItem("floka_k00")).not.toBeNull();
    expect(storage.getItem("floka_k19")).toBeNull();
  });

  test("partial round failure undoes only this round's own, untouched writes: older and foreign mirrors stay", () => {
    const storage = new QuotaStorage().seed({ cstra_a: "1", cstra_b: "2", cstra_c: "3", floka_a: "old", floka_z: "foreign" });
    storage.failKeys.add("floka_c");
    storage.onSet = (k) => { if (k === "floka_b") storage.data.set("floka_b", "other-tab"); }; // concurrent change after our write
    const report = migrateLocalStorage({ mode: "on", storage, budget: "on" });
    expect(report.status).toBe("interrupted");
    expect(storage.getItem("floka_a")).toBe("old"); // own write reverted to the pre-round value
    expect(storage.getItem("floka_b")).toBe("other-tab"); // changed since our write: left alone
    expect(storage.getItem("floka_z")).toBe("foreign");
    expect([storage.getItem("cstra_a"), storage.getItem("cstra_b"), storage.getItem("cstra_c")]).toEqual(["1", "2", "3"]);
    storage.failKeys.clear();
    storage.onSet = undefined;
    expect(migrateLocalStorage({ mode: "on", storage, budget: "on" }).status).toBe("complete");
    expect(storage.getItem("floka_c")).toBe("3");
  });

  test("deletions propagate to the mirror and are never undone by a failed round", () => {
    const storage = new QuotaStorage().seed({ cstra_b: "2", floka_a: "revoked" });
    storage.failKeys.add("floka_b");
    migrateLocalStorage({ mode: "on", storage, budget: "on" });
    expect(storage.getItem("floka_a")).toBeNull();
    writeCompatible(storage, "cstra_b", null, "on", "on");
    expect(storage.getItem("floka_b")).toBeNull();
  });
});

describe("[验收线 2] coalesced syncs", () => {
  const backend = (port: CountingPort, budget: "on" | "observe" | "off", clock = { t: 0 }) =>
    createStorageBackend({ port, mode: () => "on", report: () => undefined, budget: () => budget, now: () => clock.t });

  test("concurrent getAll / getCurrent / setCurrent run a bounded number of mirror syncs", async () => {
    const port = new CountingPort();
    const store = backend(port, "on");
    await Promise.all([...Array(10)].flatMap(() => [store.getAll(), store.getCurrent()]));
    expect(port.replaces).toBe(1);
    const reads = port.reads;
    await Promise.all([store.getAll(), store.getCurrent(), store.getAll()]); // clean and fresh: legacy read only
    expect(port.reads - reads).toBe(1);
    port.replaces = 0;
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.setCurrent({ fp: `m${n}`, base: "" })));
    expect(port.replaces).toBeLessThanOrEqual(2);
    expect(port.dbs.get("floka")).toEqual(port.dbs.get("cstra"));
  });

  test("baseline (off) syncs on every access, for comparison", async () => {
    const port = new CountingPort();
    const store = backend(port, "off");
    await Promise.all([store.getAll(), store.getCurrent(), store.getAll()]);
    expect(port.reads).toBe(3 * 4); // 3 migrate reads + 1 legacy read per access
  });

  test("another page's legacy change becomes visible via markDirty or the TTL; no access, no sync", async () => {
    const clock = { t: 0 };
    const port = new CountingPort();
    const store = backend(port, "on", clock);
    await store.getAll();
    port.dbs.get("cstra")!.machines.push(rec("b")); // old page writes legacy directly
    expect((await store.getAll()).map((r) => r.fp)).toEqual(["a", "b"]); // legacy is always the read authority
    expect(port.dbs.get("floka")!.machines).toHaveLength(1); // still fresh: mirror not yet repaired
    store.markDirty(); // storage event / BroadcastChannel
    await store.getAll();
    expect(port.dbs.get("floka")!.machines).toHaveLength(2);
    port.dbs.get("cstra")!.machines.push(rec("c"));
    clock.t += 31_000; // silent old page: TTL
    await store.getAll();
    expect(port.dbs.get("floka")!.machines).toHaveLength(3);
    const reads = port.reads;
    await new Promise((r) => setTimeout(r, 5));
    expect(port.reads).toBe(reads); // nothing runs on its own: no sync loop
  });

  test("an interrupted mirror stays dirty and is retried by the next access only", async () => {
    let fail = true;
    const port = new CountingPort();
    const replace = port.replace.bind(port);
    port.replace = async (n, s) => { if (fail) throw new Error("abort"); return replace(n, s); };
    const store = backend(port, "on");
    await store.getAll();
    fail = false;
    await store.getAll();
    expect(port.dbs.get("floka")).toEqual(port.dbs.get("cstra"));
  });

  test("coalescedSync: requests during a run share at most one follow-up", async () => {
    let runs = 0;
    let release!: () => void;
    const sync = coalescedSync(() => { runs++; return new Promise<void>((r) => { release = r; }); }, { ttlMs: 1_000, now: () => 0 });
    const first = sync.request();
    sync.markDirty();
    const followers = [sync.request(), sync.request(), sync.request()];
    release();
    await first;
    await Promise.resolve();
    release();
    await Promise.all(followers);
    expect(runs).toBe(2);
    await sync.request();
    expect(runs).toBe(2);
  });

  test("on: our own stale mirror is not reported as a conflict; a foreign one still is", () => {
    const storage = new QuotaStorage();
    writeCompatible(storage, "cstra_theme", "dark", "on", "on");
    storage.data.set("cstra_theme", "light"); // another tab moved legacy on
    storage.data.set("cstra_lang", "en");
    storage.data.set("floka_lang", "zh"); // foreign mirror
    const report = migrateLocalStorage({ mode: "observe", storage, budget: "on" });
    expect(report.changes).toEqual(["cstra_lang", "cstra_theme"]);
    expect(report.conflicts).toEqual(["cstra_lang"]);
  });

  test("observe samples are deduplicated per target + action and carry no values", async () => {
    collect();
    const port = new CountingPort();
    const store = backend(port, "observe");
    for (let i = 0; i < 5; i++) await store.getAll();
    const storage = new QuotaStorage();
    for (let i = 0; i < 3; i++) writeCompatible(storage, "cstra_draft_agent", `secret-${i}`, "on", "observe");
    expect(samples).toEqual([
      { target: "machines", actionKey: "indexedDB:skip-fresh-sync:r1" },
      { target: "cstra_draft_", actionKey: "localStorage:skip-excluded:r1" },
    ]);
    expect(JSON.stringify(samples)).not.toContain("secret");
  });
});

describe("[验收线 3] on / observe / off", () => {
  const scenario = (budget: "on" | "observe" | "off") => {
    const storage = new QuotaStorage().seed({ cstra_theme: "dark", cstra_draft_x: "d", floka_old: "o" });
    const report = migrateLocalStorage({ mode: "on", storage, budget });
    writeCompatible(storage, "cstra_lang", "en", "on", budget);
    return { report, data: Object.fromEntries(storage.data), writes: storage.writes };
  };

  test("observe leaves business results exactly as off; on differs only in skipped mirrors", () => {
    expect(scenario("observe")).toEqual(scenario("off"));
    const on = scenario("on");
    expect(on.data.floka_draft_x).toBeUndefined();
    expect(on.data.cstra_draft_x).toBe("d");
    expect(on.data.floka_theme).toBe("dark");
  });

  test("rename.webStorage off/observe: the budget never adds mirror writes", () => {
    for (const budget of ["on", "observe", "off"] as const) {
      const storage = new QuotaStorage().seed({ cstra_theme: "dark" });
      migrateLocalStorage({ mode: "observe", storage, budget });
      writeCompatible(storage, "cstra_lang", "en", "off", budget);
      expect(storage.writes).toEqual(["cstra_lang"]);
    }
  });

  test("delivered mode: unknown bridge = off, switches apply to the next action, stale value re-asks without reload", () => {
    let asked = 0;
    setBudgetModeRefresher(() => { asked++; });
    noteBudgetMode(undefined, 0); // old bridge: no field
    expect(budgetMode(1)).toBe("off");
    noteBudgetMode("on", 0);
    expect(budgetMode(1)).toBe("on");
    noteBudgetMode("observe", 2);
    expect(budgetMode(3)).toBe("observe");
    noteBudgetMode("bogus", 4);
    expect(budgetMode(5)).toBe("off");
    expect(asked).toBe(0);
    budgetMode(4 + 61_000);
    budgetMode(4 + 61_001);
    expect(asked).toBe(1);
  });

  test("switching mid-run: an on backend falls back to per-access sync as soon as the mode turns off", async () => {
    let level: "on" | "off" = "on";
    const port = new CountingPort();
    const store = createStorageBackend({ port, mode: () => "on", report: () => undefined, budget: () => level, now: () => 0 });
    await store.getAll();
    await store.getAll();
    const replaces = port.replaces;
    level = "off";
    port.dbs.get("cstra")!.machines.push(rec("b"));
    await store.getAll();
    expect(port.replaces).toBe(replaces + 1);
    expect(port.dbs.get("floka")).toEqual(port.dbs.get("cstra"));
  });

  test("bridge: samples are recorded only in observe, once per target + action, and validated", () => {
    const dir = mkdtempSync(join(tmpdir(), "web-storage-budget-"));
    const db = openLedger(join(dir, "ledger.db"));
    let mode: RecoveryPolicy["mode"] = "observe";
    const deps = { db: () => db, policy: () => ({ mode, manualAfterMs: null, source: "config" as const }), now: 1 };
    const sample = { target: "cstra_theme", actionKey: "localStorage:skip-over-budget:r1" };
    expect(recordWebStorageSample(sample, deps)).toEqual({ ok: true, recorded: true });
    expect(recordWebStorageSample(sample, deps)).toEqual({ ok: true, recorded: false });
    expect(recordWebStorageSample({ ...sample, value: "secret" }, deps)).toEqual({ ok: true, recorded: false });
    expect(recordWebStorageSample({ target: "a b", actionKey: "x" }, deps)).toMatchObject({ ok: false, status: 400 });
    mode = "on";
    expect(recordWebStorageSample(sample, deps)).toMatchObject({ ok: false, status: 409 });
    expect(webStorageBudgetMode(deps.policy)).toBe("on");
    const rows = db.query("SELECT text, data FROM events WHERE kind = 'note'").all() as { text: string; data: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).not.toContain("secret");
    closeLedger(join(dir, "ledger.db"));
    rmSync(dir, { recursive: true, force: true });
  });
});
