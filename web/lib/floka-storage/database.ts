import type { MachinesBackend } from "../machines";
import type { StorageMode } from "./config";
import type { DatabasePort, Mutation, Snapshot } from "./idb";
import { migrationReport, reportMigration, type MigrationReport, type MigrationScope } from "./report";
import { budgetMode, coalescedSync, observeBudget, reportOnce, SYNC_TTL_MS, type BudgetMode } from "./sync-budget";

function entries(data: Snapshot): Map<string, unknown> {
  return new Map([
    ...data.machines.map((record) => [`machines/${record.fp}`, record] as const),
    ...data.meta.map((entry) => [`meta/${entry.key}`, entry.value] as const),
  ]);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function plan(legacy: Snapshot, mirror: Snapshot): { changes: string[]; conflicts: string[] } {
  const oldEntries = entries(legacy), newEntries = entries(mirror);
  const changes: string[] = [], conflicts: string[] = [];
  for (const key of [...new Set([...oldEntries.keys(), ...newEntries.keys()])].sort()) {
    if (oldEntries.has(key) === newEntries.has(key) && stable(oldEntries.get(key)) === stable(newEntries.get(key))) continue;
    changes.push(key);
    if (newEntries.has(key)) conflicts.push(key);
  }
  return { changes, conflicts };
}

export async function migrateDatabase(scope: MigrationScope & { port: DatabasePort }): Promise<MigrationReport> {
  const report = migrationReport("indexedDB", scope);
  if (report.status === "off" || report.status === "cross-origin") return report;
  try {
    // Old tabs cannot join a cross-database lock. Validate against legacy after each
    // mirror commit, so an overlapping revocation cannot leave a completed stale copy.
    for (let attempt = 0; attempt < 3; attempt++) {
      const legacy = await scope.port.read("cstra", { observe: scope.mode === "observe" });
      const mirror = await scope.port.read("floka", { observe: scope.mode === "observe" });
      const next = plan(legacy, mirror);
      report.changes = [...new Set([...report.changes, ...next.changes])].sort();
      report.conflicts = [...new Set([...report.conflicts, ...next.conflicts])].sort();
      if (scope.mode === "observe") return report;
      if (next.changes.length) await scope.port.replace("floka", legacy);
      if (!plan(await scope.port.read("cstra"), legacy).changes.length) return report;
    }
    report.status = "interrupted";
  } catch {
    // The legacy DB is untouched; mirror transactions are atomic and the next access retries.
    report.status = "interrupted";
  }
  return report;
}

/**
 * All versions share the legacy authority until CLEAN1 can retire old-page writers. webStorageBudget=on (sync-budget.ts):
 * the mirror sync runs only when marked dirty (own mutation, markDirty from storage events / other tabs) or stale past the
 * TTL, concurrent requests share one run, and concurrent reads share one legacy read. observe/off: sync on every access.
 */
export function createStorageBackend(options: {
  port: DatabasePort;
  mode: () => StorageMode;
  report?: (report: MigrationReport) => void;
  budget?: () => BudgetMode;
  /** on: after a committed mutation, so other tabs can mark their sync dirty */
  onMutate?: () => void;
  now?: () => number;
}): MachinesBackend & { markDirty(): void } {
  const report = options.report ?? reportMigration;
  const budget = options.budget ?? budgetMode;
  const now = options.now ?? Date.now;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run, run);
    tail = next;
    return next;
  };
  const sync = async (coalesced = false) => {
    const mode = options.mode();
    if (mode === "off") return;
    const result = await migrateDatabase({ mode, port: options.port });
    if (!coalesced) return report(result);
    reportOnce(result.area, JSON.stringify(result), () => report(result));
    if (result.status === "interrupted") merged.markDirty(); // the next access retries; no loop without an access
  };
  const merged = coalescedSync(() => serial(() => sync(true)), { ttlMs: SYNC_TTL_MS, now });
  // observe: what on would skip, against the same dirty/TTL rules, without changing the sync itself.
  let shadowDirty = true, shadowAt = Number.NEGATIVE_INFINITY;
  const observed = async () => {
    if (!shadowDirty && now() - shadowAt <= SYNC_TTL_MS) observeBudget("indexedDB", "machines", "skip-fresh-sync");
    shadowDirty = false;
    await sync();
    shadowAt = now();
  };
  let shared: Promise<Snapshot> | null = null;
  const legacy = () => {
    if (shared) return shared;
    const current: Promise<Snapshot> = serial(() => options.port.read("cstra")).finally(() => { if (shared === current) shared = null; });
    shared = current;
    return current;
  };
  const read = async () => {
    const level = budget();
    if (level === "on") {
      await merged.request();
      return legacy();
    }
    return serial(async () => { await (level === "observe" ? observed() : sync()); return options.port.read("cstra"); });
  };
  const mutate = async (change: Mutation) => {
    const level = budget();
    if (level !== "on") {
      return serial(async () => { await options.port.mutate(change); shadowDirty = true; await (level === "observe" ? observed() : sync()); });
    }
    shared = null; // a read started before this write must not answer reads issued after it
    await serial(() => options.port.mutate(change));
    merged.markDirty();
    try { options.onMutate?.(); } catch { /* other tabs fall back to their TTL */ }
    await merged.request();
  };
  return {
    getAll: async () => (await read()).machines,
    getCurrent: async () => ((await read()).meta.find((entry) => entry.key === "current")?.value ?? null) as Awaited<ReturnType<MachinesBackend["getCurrent"]>>,
    put: (record) => mutate({ kind: "put", record }),
    delete: (fp) => mutate({ kind: "delete", fp }),
    setCurrent: (value) => mutate({ kind: "current", value }),
    markDirty: () => { merged.markDirty(); shadowDirty = true; },
  };
}
