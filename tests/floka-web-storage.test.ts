import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { readStorageMode, setStorageMode, type StoragePort } from "../web/lib/floka-storage/config";
import { migrateLocalStorage, readLegacy, writeCompatible } from "../web/lib/floka-storage/local";
import { createStorageBackend, migrateDatabase } from "../web/lib/floka-storage/database";
import { indexedDbPort, type IdbFactory } from "../web/lib/floka-storage/idb";
import { browserBackend } from "../web/lib/floka-storage/browser";
import { MachineStore } from "../web/lib/machines";
import { loadPendingPairing, savePendingPairing } from "../web/lib/pairing";

class FakeStorage implements StoragePort {
  data = new Map<string, string>();
  writes = 0;
  failKey = "";
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) {
    if (k === this.failKey) throw new Error("quota");
    this.writes++;
    this.data.set(k, v);
  }
  removeItem(k: string) {
    if (k === this.failKey) throw new Error("quota");
    this.writes++;
    this.data.delete(k);
  }
  seed(values: Record<string, string>) { this.data = new Map(Object.entries(values)); return this; }
}

// Fake IDB schedules request success before transaction completion, rolls back aborted
// transactions, and tracks opens/upgrades/writes. No real browser storage is accessed.
type Rows = Map<string, Map<string, unknown>>;
class FakeIdb {
  data = new Map<string, Rows>();
  writes = 0;
  opens = 0;
  abortNext = "";
  failOpen = "";
  seed(name: string, machines: unknown[] = [], meta: Record<string, unknown> = {}) {
    this.data.set(name, new Map([
      ["machines", new Map(machines.map((m: any) => [m.fp, structuredClone(m)]))],
      ["meta", new Map(Object.entries(meta))],
    ]));
    return this;
  }
  async databases() { return [...this.data.keys()].map((name) => ({ name })); }
  open(name: string) {
    this.opens++;
    const req: any = { result: null, error: null };
    setTimeout(() => {
      if (this.failOpen === name) { req.error = new Error("open failed"); req.onerror?.(); return; }
      const fresh = !this.data.has(name);
      if (fresh) this.data.set(name, new Map());
      req.result = this.db(name);
      if (fresh) {
        req.transaction = { abort: () => { this.data.delete(name); req.error = new Error("upgrade aborted"); } };
        req.onupgradeneeded?.();
      }
      if (req.error) req.onerror?.();
      else req.onsuccess?.();
    }, 0);
    return req;
  }
  db(name: string) {
    return {
      close() {},
      objectStoreNames: { contains: (key: string) => this.data.get(name)!.has(key) },
      createObjectStore: (key: string) => this.data.get(name)!.set(key, new Map()),
      transaction: (_stores: string[], mode: string) => this.transaction(name, mode),
    };
  }
  transaction(name: string, mode: string) {
    const rows = structuredClone(this.data.get(name)!);
    let aborted = false;
    const queue: (() => void)[] = [];
    const tx: any = { error: null, abort: () => { aborted = true; } };
    const request = (f: () => unknown) => {
      const r: any = {};
      queue.push(() => { r.result = f(); r.onsuccess?.(); });
      return r;
    };
    tx.objectStore = (key: string) => {
      const data = rows.get(key)!;
      if (!data) throw new Error("missing store");
      return {
        getAll: () => request(() => [...data.values()]),
        getAllKeys: () => request(() => [...data.keys()]),
        put: (v: any, k?: string) => request(() => { this.writes++; data.set(k ?? v.fp, structuredClone(v)); }),
        delete: (k: string) => request(() => { this.writes++; data.delete(k); }),
        clear: () => request(() => { this.writes++; data.clear(); }),
      };
    };
    setTimeout(() => {
      while (queue.length && !aborted) queue.shift()!();
      if (mode === "readwrite" && this.abortNext === name) { aborted = true; this.abortNext = ""; }
      setTimeout(() => {
        if (aborted) { tx.error = new Error("transaction aborted"); tx.onabort?.(); }
        else { if (mode === "readwrite") this.data.set(name, rows); tx.oncomplete?.(); }
      }, 0);
    }, 0);
    return tx;
  }
  port() { return indexedDbPort(this as unknown as IdbFactory); }
}
const rec = (fp: string, name = fp) => ({ fp, name, addedAt: 1, lastUsedAt: 2 });
const options = { origin: "https://same.test", targetOrigin: "https://same.test" };

function setup() {
  const idb = new FakeIdb().seed("cstra", [rec("a")], { current: { fp: "a", base: "/m/a" } });
  return { idb, port: idb.port() };
}

describe("[验收线 1] IDB migration and interruption", () => {
  test("old → new retains machines, principal and metadata; rerun is idempotent", async () => {
    const idb = new FakeIdb().seed("cstra", [{ ...rec("a"), principalId: "guest:1" }], { current: { fp: "a", base: "" }, other: [1] });
    const port = idb.port();
    expect((await migrateDatabase({ mode: "on", port, ...options })).status).toBe("complete");
    expect(await port.read("floka")).toEqual(await port.read("cstra"));
    const writes = idb.writes;
    expect((await migrateDatabase({ mode: "on", port, ...options })).status).toBe("complete");
    expect(idb.writes).toBe(writes);
  });
  test("conflicting records and new-only credentials lose to legacy, without leaking values", async () => {
    const { idb, port } = setup();
    idb.seed("floka", [rec("a", "secret-value"), rec("revoked")], { current: { fp: "revoked", base: "secret-value" } });
    const result = await migrateDatabase({ mode: "on", port, ...options });
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(await port.read("floka")).toEqual(await port.read("cstra"));
  });
  test("request success followed by transaction abort is reported; retry finishes", async () => {
    const { idb, port } = setup();
    idb.seed("floka", [rec("stale")]);
    idb.abortNext = "floka";
    expect((await migrateDatabase({ mode: "on", port, ...options })).status).toBe("interrupted");
    expect((await port.read("floka")).machines).toEqual([rec("stale")]);
    expect((await port.read("cstra")).machines).toEqual([rec("a")]);
    expect((await migrateDatabase({ mode: "on", port, ...options })).status).toBe("complete");
    expect(await port.read("floka")).toEqual(await port.read("cstra"));
  });
  test("legacy deletion during mirror commit is reconciled before reporting completion", async () => {
    const { port } = setup();
    let changed = false;
    const racing = {
      ...port,
      async replace(name: string, snapshot: Parameters<typeof port.replace>[1]) {
        await port.replace(name, snapshot);
        if (!changed) { changed = true; await port.mutate({ kind: "delete", fp: "a" }); }
      },
    };
    const result = await migrateDatabase({ mode: "on", port: racing });
    expect(result.status).toBe("complete");
    expect((await port.read("floka")).machines).toEqual([]);
    expect(await port.read("floka")).toEqual(await port.read("cstra"));
  });
  test("empty legacy removes stale mirror without creating the legacy database", async () => {
    const idb = new FakeIdb().seed("floka", [rec("revoked")]);
    await migrateDatabase({ mode: "on", port: idb.port(), ...options });
    expect(idb.data.has("cstra")).toBe(false);
    expect((await idb.port().read("floka")).machines).toEqual([]);
  });
});

describe("[验收线 2] compatibility writes and rollback", () => {
  test("add/update/delete/current from new page are visible to old IDB reader", async () => {
    const { port } = setup();
    const backend = createStorageBackend({ port, mode: () => "on" });
    await backend.put(rec("b", "paired"));
    await backend.put({ ...rec("b", "updated"), principalId: "guest:2" });
    await backend.setCurrent({ fp: "b", base: "/m/b" });
    expect((await port.read("cstra")).machines.find((m) => m.fp === "b")?.name).toBe("updated");
    expect(await port.read("floka")).toEqual(await port.read("cstra"));
    await backend.delete("b");
    await backend.setCurrent(null);
    expect((await port.read("cstra")).machines.map((m) => m.fp)).toEqual(["a"]);
    expect(await backend.getCurrent()).toBeNull();
    expect(await port.read("floka")).toEqual(await port.read("cstra"));
  });
  test("legacy page deletion and update always win after switching back to new page", async () => {
    const { port } = setup();
    const backend = createStorageBackend({ port, mode: () => "on" });
    await backend.getAll();
    await port.mutate({ kind: "delete", fp: "a" });
    expect(await backend.getAll()).toEqual([]);
    await port.mutate({ kind: "put", record: rec("a", "old-page-update") });
    expect((await backend.getAll())[0].name).toBe("old-page-update");
  });
  test("mirror failure preserves authoritative mutation and retries on next access", async () => {
    const { idb, port } = setup();
    const reports: unknown[] = [];
    const backend = createStorageBackend({ port, mode: () => "on", report: (r) => reports.push(r) });
    await backend.getAll();
    idb.abortNext = "floka";
    await backend.delete("a");
    expect((await port.read("cstra")).machines).toEqual([]);
    expect(reports).toContainEqual(expect.objectContaining({ status: "interrupted" }));
    expect(await backend.getAll()).toEqual([]);
    expect((await port.read("floka")).machines).toEqual([]);
  });
  test("legacy transaction abort rejects a new page write and does not mirror it", async () => {
    const { idb, port } = setup();
    const backend = createStorageBackend({ port, mode: () => "on" });
    idb.abortNext = "cstra";
    await expect(backend.delete("a")).rejects.toThrow();
    expect((await port.read("cstra")).machines).toEqual([rec("a")]);
    expect(idb.data.has("floka")).toBe(false);
  });
  test("LS mirrors additions/updates/deletions and never resurrects old-page deletion", () => {
    const storage = new FakeStorage().seed({ cstra_theme: "dark", cstra_api_base: "/m/a", unrelated: "keep" });
    expect(migrateLocalStorage({ mode: "on", storage, ...options }).status).toBe("complete");
    expect(storage.getItem("floka_theme")).toBe("dark");
    writeCompatible(storage, "cstra_theme", "light", "on");
    expect(storage.getItem("cstra_theme")).toBe("light");
    writeCompatible(storage, "cstra_theme", null, "on");
    expect(storage.getItem("floka_theme")).toBeNull();
    storage.removeItem("cstra_api_base");
    expect(readLegacy(storage, "cstra_api_base")).toBeNull();
    migrateLocalStorage({ mode: "on", storage, ...options });
    expect(storage.getItem("floka_api_base")).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
  });
  test("LS write overlapping an old-page deletion converges to the latest legacy value", () => {
    const storage = new FakeStorage();
    const set = storage.setItem.bind(storage);
    storage.setItem = (key, value) => {
      set(key, value);
      if (key === "floka_theme") storage.removeItem("cstra_theme");
    };
    writeCompatible(storage, "cstra_theme", "dark", "on");
    expect(storage.getItem("cstra_theme")).toBeNull();
    expect(storage.getItem("floka_theme")).toBeNull();
  });
  test("pair_pending uses sessionStorage dual keys, reads only legacy, migrates no history", () => {
    const storage = new FakeStorage();
    const pending = { fp: "a", approvalId: "approval", machineName: "name", expiresAt: "2099-01-01" };
    savePendingPairing(pending, storage, "on");
    expect(storage.getItem("floka_pair_pending")).toBe(storage.getItem("cstra_pair_pending"));
    expect(loadPendingPairing(0, storage)).toEqual(pending);
    storage.removeItem("cstra_pair_pending");
    expect(loadPendingPairing(0, storage)).toBeNull();
    savePendingPairing(null, storage, "on");
    expect(storage.getItem("floka_pair_pending")).toBeNull();
  });
});

describe("[验收线 3] gates, origin and no-write observation", () => {
  test("explicit browser setting defaults off, unknown fails closed", () => {
    const storage = new FakeStorage();
    expect(readStorageMode(storage)).toBe("off");
    storage.setItem("rename.webStorage", "invalid");
    expect(readStorageMode(storage)).toBe("off");
    setStorageMode("observe", storage);
    expect(readStorageMode(storage)).toBe("observe");
    setStorageMode("on", storage);
    expect(readStorageMode(storage)).toBe("on");
  });
  test.each(["off", "observe"] as const)("%s performs zero migration writes, including absent IDB", async (mode) => {
    const { idb, port } = setup();
    const storage = new FakeStorage().seed({ cstra_theme: "dark", floka_theme: "light" });
    const before = structuredClone(storage.data);
    expect((await migrateDatabase({ mode, port, ...options })).status).toBe(mode === "off" ? "off" : "observed");
    expect(migrateLocalStorage({ mode, storage, ...options }).status).toBe(mode === "off" ? "off" : "observed");
    expect(storage.data).toEqual(before);
    expect(storage.writes).toBe(0);
    expect(idb.writes).toBe(0);
    expect(idb.data.has("floka")).toBe(false);
    const fresh = new FakeIdb();
    await migrateDatabase({ mode, port: fresh.port(), ...options });
    expect(fresh.opens).toBe(0);
    expect(fresh.data.size).toBe(0);
  });
  test("cannot enumerate existing DBs: observation refuses safely without open/create", async () => {
    const idb = new FakeIdb();
    const factory = { open: idb.open.bind(idb) } as unknown as IdbFactory;
    const result = await migrateDatabase({ mode: "observe", port: indexedDbPort(factory), ...options });
    expect(result.status).toBe("interrupted");
    expect(idb.opens).toBe(0);
  });
  test("different origins explicitly refuse without touching storage", async () => {
    const { idb, port } = setup();
    const storage = new FakeStorage().seed({ cstra_theme: "dark" });
    const cross = { origin: "https://old.test", targetOrigin: "https://new.test" };
    expect((await migrateDatabase({ mode: "on", port, ...cross })).status).toBe("cross-origin");
    expect(migrateLocalStorage({ mode: "on", storage, ...cross }).status).toBe("cross-origin");
    expect(idb.opens).toBe(0);
    expect(storage.writes).toBe(0);
  });
  test("LS interruption retries and conflicts report keys, never values", () => {
    const storage = new FakeStorage().seed({ cstra_theme: "dark", cstra_api_base: "SECRET", floka_theme: "light" });
    storage.failKey = "floka_theme";
    const failed = migrateLocalStorage({ mode: "on", storage, ...options });
    expect(failed.status).toBe("interrupted");
    expect(failed.conflicts).toContain("cstra_theme");
    expect(JSON.stringify(failed)).not.toContain("SECRET");
    storage.failKey = "";
    expect(migrateLocalStorage({ mode: "on", storage, ...options }).status).toBe("complete");
    const writes = storage.writes;
    migrateLocalStorage({ mode: "on", storage, ...options });
    expect(storage.writes).toBe(writes);
  });
  test("boot reads same flag and legacy theme even when new mirror disagrees", () => {
    const script = readFileSync(new URL("../web/public/boot.js", import.meta.url), "utf8").split("// ②")[0];
    const storage = new FakeStorage().seed({ "rename.webStorage": "on", cstra_theme: "dark", floka_theme: "light" });
    const attributes: Record<string, string> = {};
    const window: Record<string, unknown> = {};
    runInNewContext(script, { localStorage: storage, window, document: { documentElement: { setAttribute: (k: string, v: string) => attributes[k] = v } } });
    expect(window.__flokaStorageMode).toBe("on");
    expect(attributes["data-theme"]).toBe("dark");
    expect(storage.writes).toBe(0);
  });
});


describe("[验收线 1] storage wiring and read-only edge cases", () => {
  test("old engines without enumeration can still read/write legacy in off mode", async () => {
    const idb = new FakeIdb().seed("cstra", [rec("a")]);
    const factory = { open: idb.open.bind(idb) } as unknown as IdbFactory;
    const backend = createStorageBackend({ port: indexedDbPort(factory), mode: () => "off" });
    expect(await backend.getAll()).toEqual([rec("a")]);
    await backend.put(rec("b"));
    expect((await backend.getAll()).length).toBe(2);
    expect(idb.data.has("floka")).toBe(false);
    idb.data.delete("cstra");
    expect(await backend.getAll()).toEqual([]);
    expect(idb.data.has("cstra")).toBe(false);
  });
  test("DB disappears after enumeration: observe aborts creation and remains zero-write", async () => {
    const idb = new FakeIdb().seed("cstra", [rec("a")]);
    const factory = {
      databases: idb.databases.bind(idb),
      open: (name: string) => { idb.data.delete(name); return idb.open(name); },
    } as unknown as IdbFactory;
    const result = await migrateDatabase({ mode: "observe", port: indexedDbPort(factory) });
    expect(result.status).toBe("observed");
    expect(idb.data.size).toBe(0);
    expect(idb.writes).toBe(0);
  });
  test("off/observe backend reads do not create DBs; ordinary user writes only change legacy", async () => {
    for (const mode of ["off", "observe"] as const) {
      const idb = new FakeIdb();
      const backend = createStorageBackend({ port: idb.port(), mode: () => mode, report: () => undefined });
      expect(await backend.getAll()).toEqual([]);
      expect(await backend.getCurrent()).toBeNull();
      expect(idb.data.size).toBe(0);
      await backend.put(rec("a"));
      expect(idb.data.has("cstra")).toBe(true);
      expect(idb.data.has("floka")).toBe(false);
    }
  });
  test("broken mirror open cannot hide the paired machines from new page readers", async () => {
    const { idb, port } = setup();
    idb.seed("floka", [rec("stale")]);
    idb.failOpen = "floka";
    const backend = createStorageBackend({ port, mode: () => "on", report: () => undefined });
    expect(await backend.getAll()).toEqual([rec("a")]);
    expect(await backend.getCurrent()).toEqual({ fp: "a", base: "/m/a" });
  });
  test("LS mirror write failure keeps latest legacy and next reconciliation repairs it", () => {
    const storage = new FakeStorage().seed({ cstra_theme: "dark", floka_theme: "dark" });
    storage.failKey = "floka_theme";
    expect(() => writeCompatible(storage, "cstra_theme", null, "on")).toThrow("quota");
    expect(readLegacy(storage, "cstra_theme")).toBeNull();
    storage.failKey = "";
    migrateLocalStorage({ mode: "on", storage });
    expect(storage.getItem("floka_theme")).toBeNull();
  });
  test("MachineStore current mirrors and pairing removal survive old-page reload", async () => {
    const local = new FakeStorage().seed({ "rename.webStorage": "on" });
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    try {
      const { port } = setup();
      const store = new MachineStore(createStorageBackend({ port, mode: () => "on", report: () => undefined }));
      store.setBaseResolver((fp) => "/m/" + fp);
      await store.load();
      await store.setCurrent("a");
      expect(local.getItem("cstra_api_base")).toBe("/m/a");
      expect(local.getItem("floka_api_base")).toBe("/m/a");
      await store.remove("a");
      expect(local.getItem("cstra_api_base")).toBeNull();
      expect(local.getItem("floka_api_base")).toBeNull();
      const oldPage = new MachineStore(createStorageBackend({ port, mode: () => "off" }));
      await oldPage.load();
      expect(oldPage.all()).toEqual([]);
      expect(oldPage.current()).toBeNull();
    } finally {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
  test("LS migration works without IDB; session history remains untouched on load", () => {
    const local = new FakeStorage().seed({ "rename.webStorage": "on", cstra_theme: "dark" });
    const session = new FakeStorage().seed({ cstra_pair_pending: JSON.stringify({ fp: "a", approvalId: "x", expiresAt: "2099-01-01" }) });
    const previous = ["localStorage", "indexedDB"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    try {
      expect(browserBackend()).toBeNull();
      expect(local.getItem("floka_theme")).toBe("dark");
      expect(loadPendingPairing(0, session)?.fp).toBe("a");
      expect(session.getItem("floka_pair_pending")).toBeNull();
      expect(session.writes).toBe(0);
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
});
