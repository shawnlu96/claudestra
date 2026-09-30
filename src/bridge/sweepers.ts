/**
 * Periodic sweepers the bridge starts once at boot (the Discord-ready path or the web-only path, never both):
 * the daily archive snapshot (archive-sweeper.ts) and the lend lease expiry (local-api/lend.ts).
 */
import { startArchiveSweeper } from "./archive-sweeper.js";
import { startLendSweeper } from "./local-api/lend.js";

export function startSweepers(): void {
  startArchiveSweeper();
  startLendSweeper();
}
