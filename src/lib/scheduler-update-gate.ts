/**
 * Agent idleness does not imply the merge controller is idle. `updating` / `merging` have a GitHub effect in flight;
 * `unknown` means nobody has confirmed that effect ended, so it blocks updates until the PM runs
 * `ledger scheduler-merge-resolve`, which is its exit (tests/scheduler-update-gate.test.ts). `merged` is terminal:
 * deploying it is the PM's `update`, so it must not block.
 */
import type { Database } from "bun:sqlite";
import { LedgerReader } from "./ledger-read.js";

export function mergeQueueBusy(db: Database): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return false;
  return !!db.query("SELECT 1 FROM scheduler_merges WHERE phase IN ('updating','merging','unknown') LIMIT 1").get();
}

export function schedulerQueueIdle(reader = new LedgerReader()): boolean {
  try {
    const db = reader.get();
    if (db && mergeQueueBusy(db)) {
      console.log("auto-update deferred: scheduler merge queue is busy or has an unresolved unknown merge");
      return false;
    }
    return true;
  } catch (e) {
    console.error(`auto-update deferred: cannot inspect scheduler queue: ${(e as Error).message}`);
    return false;
  } finally { reader.close(); }
}
