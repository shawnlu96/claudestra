/**
 * N8A3 child entry: one auto-share pass under the cron parent's pass lock, outcomes printed as JSON on stdout.
 * Started only by src/lib/shared-ledger-auto-share-run.ts; without the parent's lock in the environment it does nothing.
 * Usage: bun scripts/shared-ledger-auto-share-pass.ts [--ledger <ledger.sqlite>]
 */
import { runSharedLedgerAutoSharePass } from "../src/lib/shared-ledger-auto-share.js";
import { AUTO_SHARE_LOCK_ENV } from "../src/lib/shared-ledger-auto-share-run.js";
import { armSpecPreflight } from "../src/lib/spec-material-preflight-gate.js";

function heldLock(env: Record<string, string | undefined>): { path: string; token: string } | null {
  const raw = env[AUTO_SHARE_LOCK_ENV];
  delete env[AUTO_SHARE_LOCK_ENV];
  try {
    const v = JSON.parse(raw ?? "") as { path?: unknown; token?: unknown } | null;
    return v && typeof v.path === "string" && typeof v.token === "string" ? { path: v.path, token: v.token } : null;
  } catch { return null; } // No or unreadable lock: refuse to run rather than race the parent's pass.
}

/** Exit code: 0 = pass ran (outcomes on stdout), 2 = started without the parent's pass lock. */
export async function main(argv = process.argv.slice(2), env: Record<string, string | undefined> = process.env): Promise<number> {
  const held = heldLock(env);
  if (!held) {
    console.error("shared-ledger-auto-share-pass: started without the cron parent's pass lock");
    return 2;
  }
  armSpecPreflight(); // this pass writes the ledger: arm the writer's preflight like the other writing entries (SPECG1)
  const at = argv.indexOf("--ledger"), ledgerPath = at >= 0 ? argv[at + 1] : undefined;
  console.log(JSON.stringify(await runSharedLedgerAutoSharePass({ heldLock: held, ...(ledgerPath ? { ledgerPath } : {}) })));
  return 0;
}

if (import.meta.main) process.exitCode = await main();
