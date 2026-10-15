import type { MachineRecord } from "../machines";

export interface Snapshot {
  machines: MachineRecord[];
  meta: { key: string; value: unknown }[];
}
export type Mutation = { kind: "put"; record: MachineRecord } | { kind: "delete"; fp: string }
  | { kind: "current"; value: { fp: string; base: string } | null };
export interface DatabasePort {
  read(name: string, options?: { observe: boolean }): Promise<Snapshot>;
  replace(name: string, snapshot: Snapshot): Promise<void>;
  mutate(mutation: Mutation): Promise<void>;
}
// Structural IDB types also compile under the root test tsconfig (no DOM library).
interface Request<T = unknown> {
  result: T;
  error: { message?: string } | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface Store {
  getAll(): Request<unknown[]>;
  getAllKeys(): Request<string[]>;
  put(value: unknown, key?: string): Request;
  delete(key: string): Request;
  clear(): Request;
}
interface Transaction {
  error: { message?: string } | null;
  oncomplete: (() => void) | null;
  onabort: (() => void) | null;
  onerror: (() => void) | null;
  objectStore(name: string): Store;
  abort(): void;
}
interface Database {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath: string }): unknown;
  transaction(stores: string[], mode: "readonly" | "readwrite"): Transaction;
  close(): void;
}
export interface IdbFactory {
  databases?: () => Promise<{ name?: string }[]>;
  open(name: string, version: number): Request<Database> & {
    onupgradeneeded: (() => void) | null;
    onblocked: (() => void) | null;
    transaction: Transaction | null;
  };
}
const stores = ["machines", "meta"];
const empty = (): Snapshot => ({ machines: [], meta: [] });

function open(factory: IdbFactory, name: string, create: boolean): Promise<Database | null> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    let blocked = false;
    let absent = false;
    request.onblocked = () => { blocked = true; reject(new Error("indexedDB open blocked")); };
    request.onupgradeneeded = () => {
      if (blocked || !create) { absent = !blocked; request.transaction?.abort(); return; }
      const db = request.result;
      if (!db.objectStoreNames.contains("machines")) db.createObjectStore("machines", { keyPath: "fp" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    request.onerror = () => {
      if (absent) resolve(null);
      else reject(new Error(request.error?.message ?? "indexedDB open failed"));
    };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
  });
}

/** Request success is provisional. Only oncomplete may acknowledge a committed write. */
async function transaction<T>(db: Database, mode: "readonly" | "readwrite", run: (tx: Transaction) => () => T): Promise<T> {
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      tx.onabort = () => reject(new Error(tx.error?.message ?? "indexedDB transaction aborted"));
      tx.onerror = () => reject(new Error(tx.error?.message ?? "indexedDB transaction failed"));
      try {
        const result = run(tx);
        tx.oncomplete = () => {
          try { resolve(result()); } catch (error) { reject(error); }
        };
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  } finally {
    db.close();
  }
}

function snapshot(tx: Transaction): () => Snapshot {
  const machines = tx.objectStore("machines").getAll();
  const meta = tx.objectStore("meta");
  const values = meta.getAll();
  const keys = meta.getAllKeys();
  return () => ({
    machines: machines.result as MachineRecord[],
    meta: keys.result.map((key, index) => ({ key, value: values.result[index] })),
  });
}

export function indexedDbPort(factory: IdbFactory): DatabasePort {
  return {
    async read(name, options) {
      // Observe never probes a missing database by opening it. Other reads can abort a
      // creation upgrade on older engines without databases(); no empty DB is persisted.
      if (!factory.databases && options?.observe) throw new Error("indexedDB enumeration unavailable");
      if (factory.databases && !(await factory.databases()).some((db) => db.name === name)) return empty();
      const db = await open(factory, name, false);
      return db ? transaction(db, "readonly", snapshot) : empty();
    },
    async replace(name, data) {
      await transaction((await open(factory, name, true))!, "readwrite", (tx) => {
        const machines = tx.objectStore("machines");
        const meta = tx.objectStore("meta");
        machines.clear();
        meta.clear();
        for (const record of data.machines) machines.put(record);
        for (const entry of data.meta) meta.put(entry.value, entry.key);
        return () => undefined;
      });
    },
    async mutate(mutation) {
      await transaction((await open(factory, "cstra", true))!, "readwrite", (tx) => {
        if (mutation.kind === "put") tx.objectStore("machines").put(mutation.record);
        else if (mutation.kind === "delete") tx.objectStore("machines").delete(mutation.fp);
        else if (mutation.value) tx.objectStore("meta").put(mutation.value, "current");
        else tx.objectStore("meta").delete("current");
        return () => undefined;
      });
    },
  };
}
