/** Updates and scheduler effects share a lease; durable journals block updates across daemon replacement. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLock, type LockHandle } from "./file-lock.js";
import { statePath } from "./paths.js";
import { LedgerReader } from "./ledger-read.js";
import { mergeQueueBusy } from "./scheduler-update-gate.js";
import { UPDATE_INFLIGHT } from "./update-inflight.js";
import { clearMaintenanceRequest, MAINTENANCE_REQUEST, maintenanceRequested, requestMaintenance } from "./scheduler-yield.js";

export class SchedulerStopped extends Error {}

export async function whileOwned<T>(assertActive: () => void, operation: () => Promise<T>): Promise<T> {
  assertActive();
  const result = await operation();
  assertActive();
  return result;
}

/**
 * scheduler: never waits, and stands aside while an update is waiting (a fresh request file, lib/scheduler-yield.ts).
 * update: with `waitMs`, keeps a request fresh and retries until the running pass yields; a busy merge queue refuses at once.
 * deploy: the one-shot deploy job (T68g) waits like update, but it is part of the queue, so only a half-finished update refuses it.
 */
export async function acquireMaintenance(kind: "scheduler" | "update" | "deploy", opts: {
  path?: string; marker?: string; reader?: LedgerReader; request?: string; waitMs?: number;
} = {}): Promise<(LockHandle & { path: string }) | null> {
  const path = opts.path ?? statePath("scheduler-maintenance.lock"), marker = opts.marker ?? UPDATE_INFLIGHT, request = opts.request ?? MAINTENANCE_REQUEST;
  mkdirSync(dirname(path), { recursive: true });
  if (kind === "scheduler") {
    if (maintenanceRequested(request)) return null;
    const lock = await acquireLock(path, 0);
    if (lock && existsSync(marker)) { lock.release(); return null; }
    return lock && Object.assign(lock, { path });
  }
  const deadline = Date.now() + (opts.waitMs ?? 0);
  try {
    for (;;) {
      const lock = await acquireLock(path, 0);
      const mayRun = kind === "deploy" ? (l: LockHandle) => !existsSync(marker) || (l.release(), false) : (l: LockHandle) => updateMayRun(l, opts.reader);
      if (lock) return mayRun(lock) ? Object.assign(lock, { path }) : null;
      if (Date.now() >= deadline) return null;
      requestMaintenance(request);
      await Bun.sleep(250);
    }
  } finally { clearMaintenanceRequest(request); }
}

/** Releases the lock and says no while a merge journal is in flight or unresolved (it must finish across restarts first). */
function updateMayRun(lock: LockHandle, given?: LedgerReader): boolean {
  const reader = given ?? new LedgerReader();
  try {
    const db = reader.get();
    if (db && mergeQueueBusy(db)) { lock.release(); return false; }
    return true;
  } catch (e) { lock.release(); throw e; } finally { reader.close(); }
}
