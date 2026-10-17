import { readStorageMode, type KeyValueStorage, type StoragePort } from "./config";
import { migrationReport, type MigrationReport, type MigrationScope } from "./report";
import {
  admitMirror, budgetMode, entryBytes, isSelfWrite, MirrorRound, mirrorUsage, noteSelfWrite, observeBudget, sampleTarget,
  type Admission, type BudgetMode,
} from "./sync-budget";

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

const isPort = (storage: KeyValueStorage): storage is StoragePort => typeof (storage as StoragePort).key === "function";

/** webStorageBudget=on: syncKey under the byte budget, recording own writes in `round` so a failure can undo them. */
function syncBudgeted(storage: KeyValueStorage, key: string, round: MirrorRound, usage: { used: number }): Admission {
  const next = mirrorKey(key);
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = storage.getItem(key);
    const previous = storage.getItem(next);
    if (previous !== value) {
      if (value === null) {
        storage.removeItem(next); // a deletion only frees space and is never undone
        usage.used -= entryBytes(next, previous ?? "");
        noteSelfWrite(next, null);
      } else {
        const admission = admitMirror(key, next, value, previous, usage.used);
        if (admission !== "write") return admission;
        storage.setItem(next, value);
        round.record(next, previous, value);
        noteSelfWrite(next, value);
        usage.used += entryBytes(next, value) - (previous === null ? 0 : entryBytes(next, previous));
      }
    }
    if (storage.getItem(key) === value) return "write";
  }
  throw new Error("legacy storage changed during mirror write");
}

/** observe: the admission on would apply to this key, as a sample; the caller then runs the unchanged off path. */
function observeAdmission(storage: KeyValueStorage, key: string, usage: { used: number }): void {
  const value = storage.getItem(key);
  if (value === null) return;
  const next = mirrorKey(key), previous = storage.getItem(next);
  if (previous === value) return;
  const admission = admitMirror(key, next, value, previous, usage.used);
  if (admission !== "write") observeBudget("localStorage", sampleTarget(key), `skip-${admission}`);
  else usage.used += entryBytes(next, value) - (previous === null ? 0 : entryBytes(next, previous));
}

/** Commit legacy first so rollback pages see the new state even if a mirror write fails. */
export function writeCompatible(storage: KeyValueStorage | null, key: string, value: string | null, mode = readStorageMode(), budget: BudgetMode = budgetMode()): void {
  if (!storage) return;
  mirrorKey(key); // Validate before touching either family.
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
  if (mode !== "on") return;
  if (budget === "off") return syncKey(storage, key);
  const usage = { used: isPort(storage) ? mirrorUsage(storage, mirrorPrefix) : 0 };
  if (budget === "observe") {
    observeAdmission(storage, key, usage);
    try {
      return syncKey(storage, key);
    } catch (error) {
      observeBudget("localStorage", sampleTarget(key), "undo-failed-mirror");
      throw error;
    }
  }
  const round = new MirrorRound();
  try {
    syncBudgeted(storage, key, round, usage);
  } catch {
    // The legacy save already landed; a quota-failed mirror gives its space back instead of failing the save.
    round.revert(storage as StoragePort);
  }
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
export function migrateLocalStorage(scope: MigrationScope & { storage: StoragePort; budget?: BudgetMode }): MigrationReport {
  const report = migrationReport("localStorage", scope);
  if (report.status === "off" || report.status === "cross-origin") return report;
  const budget = scope.budget ?? budgetMode();
  const round = new MirrorRound();
  try {
    for (const key of keys(scope.storage)) {
      const current = scope.storage.getItem(key);
      const next = mirrorKey(key);
      const mirrored = scope.storage.getItem(next);
      if (current === mirrored) continue;
      report.changes.push(key);
      // on: a mirror this page wrote that legacy has since moved past is our own stale copy, not a conflict.
      if (mirrored !== null && !(budget === "on" && isSelfWrite(next, mirrored))) report.conflicts.push(key);
    }
    if (scope.mode !== "on") return report;
    const usage = { used: budget === "off" ? 0 : mirrorUsage(scope.storage, mirrorPrefix) };
    for (const key of report.changes) {
      if (budget === "on") syncBudgeted(scope.storage, key, round, usage);
      else {
        if (budget === "observe") observeAdmission(scope.storage, key, usage);
        syncKey(scope.storage, key);
      }
    }
  } catch {
    // Preserve a partial plan and report failure; a retry re-reads legacy, including deletions.
    report.status = "interrupted";
    if (budget === "on") round.revert(scope.storage);
    else if (budget === "observe" && scope.mode === "on") observeBudget("localStorage", "all", "undo-failed-round");
  }
  return report;
}
