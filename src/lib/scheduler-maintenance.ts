/** Updates and scheduler effects share a lease; durable journals block updates across daemon replacement. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { statePath } from "./paths.js";
import { LedgerReader } from "./ledger-read.js";
import { mergeQueueBusy } from "./scheduler-update-gate.js";
import { UPDATE_INFLIGHT } from "./update-inflight.js";

export class SchedulerStopped extends Error {}

export async function whileOwned<T>(assertActive: () => void, operation: () => Promise<T>): Promise<T> {
  assertActive();
  const result = await operation();
  assertActive();
  return result;
}

export async function acquireMaintenance(kind: "scheduler" | "update", opts: {
  path?: string; marker?: string; reader?: LedgerReader; ownIntent?: string;
} = {}): Promise<LockHandle | null> {
  const path = opts.path ?? statePath("scheduler-maintenance.lock"), marker = opts.marker ?? UPDATE_INFLIGHT;
  mkdirSync(dirname(path), { recursive: true });
  const lock = await acquireLock(path, kind === "update" && opts.ownIntent ? 60_000 : 0);
  if (!lock) return null;
  try {
    if (kind === "scheduler" && existsSync(marker)) { lock.release(); return null; }
    if (kind === "update") {
      const reader = opts.reader ?? new LedgerReader();
      try {
        const db = reader.get();
        if (db && mergeQueueBusy(db, opts.ownIntent)) { lock.release(); return null; }
      } finally { reader.close(); }
    }
    return lock;
  } catch (e) { lock.release(); throw e; }
}
