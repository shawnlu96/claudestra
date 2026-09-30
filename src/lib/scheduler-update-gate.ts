/** Agent idleness does not imply the merge/deploy controller is idle. */
import type { Database } from "bun:sqlite";
import { LedgerReader } from "./ledger-read.js";

export function mergeQueueBusy(db: Database, ownIntent = ""): boolean {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_merges'").get()) return false;
  return !!db.query(`SELECT 1 FROM scheduler_merges
    WHERE phase IN ('updating','merging','merged','deploying','deployed','verifying','unknown')
    AND (?='' OR intentId<>?) LIMIT 1`).get(ownIntent, ownIntent);
}

export function schedulerQueueIdle(reader = new LedgerReader()): boolean {
  try {
    const db = reader.get();
    if (db && mergeQueueBusy(db)) {
      console.log("auto-update deferred: scheduler merge/deploy queue is busy");
      return false;
    }
    return true;
  } catch (e) {
    console.error(`auto-update deferred: cannot inspect scheduler queue: ${(e as Error).message}`);
    return false;
  } finally { reader.close(); }
}
