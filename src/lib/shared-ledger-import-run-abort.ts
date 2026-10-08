import type { Database } from "bun:sqlite";
import { acquireLock } from "./file-lock.js";
import type { SharedLedgerClient } from "./shared-ledger-client.js";
import { migrationLockPath } from "./shared-ledger-mirror.js";
import { readSharedLedgerMode, writeSharedLedgerModes } from "./shared-ledger-mode.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { MigrationError, readSharedLedgerImportRecord, sharedLedgerImportJournalPath } from "./shared-ledger-import-run.js";

/**
 * N8A: the center answered a commit with an explicit 4xx after the journal entered `committing`, which
 * revokeUncommittedSharedLedgerImport refuses. Reopen only if, under the migration lock, the center still has no
 * receipt for the batch: then nothing was staged and no later replay can stage it (the journal ends `aborted`).
 */
export async function abortRejectedSharedLedgerImport(db: Database, stateDir: string, batchId: string, client: SharedLedgerClient, approvedDigest: string) {
  const path = sharedLedgerImportJournalPath(stateDir, batchId);
  const lock = await acquireLock(migrationLockPath(stateDir));
  if (!lock) throw new MigrationError("migration lock unavailable");
  try {
    const record = readSharedLedgerImportRecord(path);
    if (!record || record.phase !== "committing" || record.payload?.manifestDigest !== approvedDigest) throw new MigrationError("reviewed manifest digest required");
    if ((await client.importReceipt(batchId)).status !== "unknown") throw new MigrationError("migration outcome unknown");
    await writeSharedLedgerModes(Object.fromEntries(record.featureIds.map((id) =>
      [id, { authorityMode: "source" as const, sharedPlanning: false }])), stateDir, db.filename, () => {
      for (const id of record.featureIds) if (readSharedLedgerMode(id, stateDir).authorityMode !== "source") throw new MigrationError("migration authority changed");
    });
    record.phase = "aborted";
    writeJsonAtomicSync(path, record, { mode: 0o600, commitIf: lock.held });
    return { status: "aborted" as const, batchId };
  } finally { lock.release(); }
}
