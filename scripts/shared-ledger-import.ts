#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { SharedLedgerExportOptions } from "../src/lib/shared-ledger-export.js";
import { SharedLedgerClient } from "../src/lib/shared-ledger-client.js";
import { instanceKeySync } from "../src/lib/instance-key.js";
import { STATE_DIR } from "../src/lib/paths.js";
import {
  advanceSharedLedgerImport, importScrubContext, MigrationError, migrationErrorText, prepareSharedLedgerImport, resolveImportCredential,
  revokeUncommittedSharedLedgerImport,
} from "../src/lib/shared-ledger-import-run.js";

/** The library lives in src/lib/shared-ledger-import-run.ts (N8A auto-share runs the same steps); tests import it from here. */
export {
  advanceSharedLedgerImport, importScrubContext, MigrationError, migrationErrorText, prepareSharedLedgerImport, resolveImportCredential,
  revokeUncommittedSharedLedgerImport,
};

async function main() {
  const [command, planPath, approvedDigest] = Bun.argv.slice(2);
  if (!["prepare", "commit", "activate", "revoke"].includes(command ?? "") || !planPath) {
    throw new MigrationError("Usage: shared-ledger-import.ts prepare|commit|activate|revoke <local-plan.json> [approvedDigest]");
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Omit<SharedLedgerExportOptions, "stateDir" | "scrub"> & { centerId: string; teamId: string };
  const dbPath = join(STATE_DIR, "ledger.sqlite");
  if (!existsSync(dbPath)) throw new MigrationError("existing home ledger required");
  const db = openLedger(dbPath);
  try {
    const scrub = await importScrubContext(db, plan, STATE_DIR);
    if (command === "prepare") {
      const result = await prepareSharedLedgerImport(db, { ...plan, stateDir: STATE_DIR, scrub });
      console.log(result.preview);
      console.log(`Review manifestDigest: ${result.payload.manifestDigest}`);
    } else {
      if (command === "revoke") {
        const local = await revokeUncommittedSharedLedgerImport(db, STATE_DIR, plan.batchId, approvedDigest);
        if (local) { console.log(JSON.stringify(local)); return; }
      }
      const credential = resolveImportCredential(plan);
      const key = instanceKeySync();
      if (!credential || !key) throw new MigrationError("local import credential unavailable");
      const receipt = await advanceSharedLedgerImport(db, STATE_DIR, plan.batchId, new SharedLedgerClient(credential, key, { scrub }),
        approvedDigest ?? "", command as "commit" | "activate" | "revoke");
      console.log(JSON.stringify(receipt));
    }
  } finally { closeLedger(dbPath); }
}
if (import.meta.main) await main().catch((error) => {
  console.error(migrationErrorText(error));
  process.exitCode = 1;
});
