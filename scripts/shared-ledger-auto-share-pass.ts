/**
 * N8A3 child entry: one auto-share pass under the cron parent's pass lock, outcomes printed as JSON on stdout.
 * Started only by src/lib/shared-ledger-auto-share-run.ts; without the parent's lock in the environment it does nothing.
 * Usage: bun scripts/shared-ledger-auto-share-pass.ts [--ledger <ledger.sqlite>]
 */
import { runSharedLedgerAutoSharePass } from "../src/lib/shared-ledger-auto-share.js";
import { AUTO_SHARE_LOCK_ENV } from "../src/lib/shared-ledger-auto-share-run.js";
import { armSpecPreflight } from "../src/lib/spec-material-preflight-gate.js";

function heldLock(): { path: string; token: string } | null {
  const raw = process.env[AUTO_SHARE_LOCK_ENV];
  delete process.env[AUTO_SHARE_LOCK_ENV];
  try {
    const v = JSON.parse(raw ?? "") as { path?: unknown; token?: unknown };
    return typeof v.path === "string" && typeof v.token === "string" ? { path: v.path, token: v.token } : null;
  } catch { return null; } // No or unreadable lease: refuse to run rather than race the parent's pass.
}

const held = heldLock();
if (!held) {
  console.error("shared-ledger-auto-share-pass: started without the cron parent's pass lock");
  process.exit(2);
}
armSpecPreflight(); // this pass writes the ledger: arm the writer's preflight like the other writing entries (SPECG1)
const at = process.argv.indexOf("--ledger");
const outcomes = await runSharedLedgerAutoSharePass({ heldLock: held, ...(at > 0 && process.argv[at + 1] ? { ledgerPath: process.argv[at + 1] } : {}) });
console.log(JSON.stringify(outcomes));
