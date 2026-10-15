import { readStorageMode, type KeyValueStorage, type StoragePort } from "./config";
import { migrationReport, type MigrationReport, type MigrationScope } from "./report";

const legacyPrefix = "cstra_";
const mirrorPrefix = "floka_";
function mirrorKey(key: string): string {
  if (!key.startsWith(legacyPrefix)) throw new Error("expected legacy storage key");
  return mirrorPrefix + key.slice(legacyPrefix.length);
}

/** Never fall back to the mirror: absence can mean an old page revoked/deleted the value. */
export function readLegacy(storage: KeyValueStorage | null, key: string): string | null {
  return storage?.getItem(key) ?? null;
}

function syncKey(storage: KeyValueStorage, key: string): void {
  const next = mirrorKey(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = storage.getItem(key);
    if (storage.getItem(next) !== value) {
      if (value === null) storage.removeItem(next);
      else storage.setItem(next, value);
    }
    if (storage.getItem(key) === value) return;
  }
  throw new Error("legacy storage changed during mirror write");
}

/** Commit legacy first so rollback pages see the new state even if a mirror write fails. */
export function writeCompatible(storage: KeyValueStorage | null, key: string, value: string | null, mode = readStorageMode()): void {
  if (!storage) return;
  mirrorKey(key); // Validate before touching either family.
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
  if (mode !== "on") return;
  syncKey(storage, key);
}

function keys(storage: StoragePort): string[] {
  const result = new Set<string>();
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(legacyPrefix)) result.add(key);
    if (key?.startsWith(mirrorPrefix)) result.add(legacyPrefix + key.slice(mirrorPrefix.length));
  }
  return [...result].sort();
}

/** Repeatable copy, no completion marker: old pages can still change or remove any key. */
export function migrateLocalStorage(scope: MigrationScope & { storage: StoragePort }): MigrationReport {
  const report = migrationReport("localStorage", scope);
  if (report.status === "off" || report.status === "cross-origin") return report;
  try {
    for (const key of keys(scope.storage)) {
      const current = scope.storage.getItem(key);
      const next = mirrorKey(key);
      const mirrored = scope.storage.getItem(next);
      if (current === mirrored) continue;
      report.changes.push(key);
      if (mirrored !== null) report.conflicts.push(key);
    }
    if (scope.mode === "on") for (const key of report.changes) syncKey(scope.storage, key);
  } catch {
    // Preserve a partial plan and report failure; a retry re-reads legacy, including deletions.
    report.status = "interrupted";
  }
  return report;
}
