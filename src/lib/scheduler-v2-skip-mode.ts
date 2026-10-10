/**
 * Route inputs without per-card I/O. The mode file is re-read only when its identity (inode, size, mtime, ctime) changes, so a
 * revocation is seen on the next check while an unchanged file costs one stat; a corrupt file is never cached (every check holds).
 * Diagnostics dedupe per key within a time window, so route checks made outside a pass still log again; S2F may clear them per tick.
 * Tests: tests/shared-ledger-v2-stage2-skip-mode.test.ts.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { readSharedLedgerMode, type SharedLedgerMode } from "./shared-ledger-mode.js";

const MODES_FILE = "shared-ledger-modes.json";
const CACHE_MAX = 1000;
const cache = new Map<string, { stamp: string; mode: SharedLedgerMode }>();

function stamp(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Same answer as `readSharedLedgerMode(featureId, dir)`; the cached copy is returned only while the file is unchanged. */
export function readSharedLedgerModeCached(featureId: string, dir: string): SharedLedgerMode {
  const before = stamp(join(dir, MODES_FILE));
  if (before === null) return readSharedLedgerMode(featureId, dir);
  const key = `${dir}\0${featureId}`, hit = cache.get(key);
  if (hit && hit.stamp === before) return { ...hit.mode };
  const mode = readSharedLedgerMode(featureId, dir);
  // Replaced while reading: answer with what was read, but cache nothing, so the next check reads again.
  if (stamp(join(dir, MODES_FILE)) === before) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { stamp: before, mode: { ...mode } });
  }
  return mode;
}

const DIAGNOSTIC_WINDOW_MS = 10 * 60_000;
const logged = new Map<string, number>();

/** True when `key` was not logged within the window (and records it now). */
export function schedulerV2Diagnostic(key: string, now = Date.now()): boolean {
  const at = logged.get(key);
  if (at !== undefined && now - at < DIAGNOSTIC_WINDOW_MS) return false;
  if (logged.size >= CACHE_MAX) logged.clear();
  logged.set(key, now);
  return true;
}

export function clearSchedulerV2Diagnostics(): void { logged.clear(); }
