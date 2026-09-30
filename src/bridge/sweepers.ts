/**
 * Periodic sweepers the bridge starts once at boot (the Discord-ready path or the web-only path, never both):
 * the daily archive snapshot (archive-sweeper.ts), the lend lease expiry and the lend key-pin log (local-api/lend.ts).
 */
import { startArchiveSweeper } from "./archive-sweeper.js";
import { startLendSweeper, watchLendPins } from "./local-api/lend.js";

export function startSweepers(): void {
  startArchiveSweeper();
  startLendSweeper();
  watchLendPins();
}
