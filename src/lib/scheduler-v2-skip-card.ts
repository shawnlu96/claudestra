/**
 * S2D2 · the skip predicates every hook shares (scheduler-v2-skip.ts re-exports them). A card is skip when its route is (§2.2);
 * a feature when it is migrating or execution. Unreadable input holds while shared modes exist; no mode file = all local.
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { schedulerV2Route } from "./scheduler-v2-pass.js";
import { readSharedLedgerModeCached, schedulerV2Diagnostic } from "./scheduler-v2-skip-mode.js";

export function schedulerV2Held(what: string, id: string): void {
  if (schedulerV2Diagnostic(`held:${what}:${id}`)) console.info(`[scheduler-v2 held] ${what} ${id}: skip`);
}

/** No mode file = no shared feature at all: every route is local, so stage one runs exactly as before (nothing else is read). */
export const sharedModes = (db: Database): boolean => existsSync(join(dirname(db.filename), "shared-ledger-modes.json"));

/** The card's route is `skip`. A card that cannot be read (corrupt row) holds while shared modes exist. */
export function schedulerV2SkipTask(db: Database, taskId: string): boolean {
  if (!sharedModes(db)) return false;
  try { return schedulerV2Route(taskId, db) === "skip"; }
  catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    schedulerV2Held("card unreadable", taskId);
    return true;
  }
}

/** No local new card, claim or feature-level write: the feature is migrating or execution (unreadable holds too). */
export function schedulerV2SkipFeature(db: Database, featureId: string): boolean {
  if (!sharedModes(db)) return false;
  try {
    const mode = readSharedLedgerModeCached(featureId, dirname(db.filename));
    return !!mode.migrating || mode.authorityMode === "execution";
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    schedulerV2Held("feature mode unreadable", featureId);
    return true;
  }
}
