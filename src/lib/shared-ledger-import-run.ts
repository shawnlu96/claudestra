/**
 * Shared-ledger import (migration) library: prepare → commit → (activate | revoke) on a durable local journal.
 * Moved verbatim from scripts/shared-ledger-import.ts so src/lib callers (N8A auto-share) can run the same steps;
 * the script keeps main() and re-exports these names.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "./ask-bind.js";
import { acquireLock } from "./file-lock.js";
import { vacuumBackup } from "./ledger-backup.js";
import { getFeature, getPendingProposal } from "./ledger-feature.js";
import { getEventByDedup, listEvents } from "./ledger-store.js";
import {
  previewSharedLedgerExport, sharedLedgerExportHeads, sharedLedgerScrubWithCommits, SharedLedgerExportContractError, type SharedLedgerExportOptions,
} from "./shared-ledger-export.js";
import { readSharedLedgerMode, writeSharedLedgerModes, resolveSharedLedgerCredential } from "./shared-ledger-mode.js";
import { parseSharedLedgerImport } from "./shared-ledger-contract-transfer.js";
import type { SharedLedgerImport, SharedLedgerImportReceipt } from "./shared-ledger-contract.js";
import type { SharedLedgerClient } from "./shared-ledger-client.js";
import { migrationLockPath } from "./shared-ledger-mirror.js";
import { setSharedLedgerBinding } from "./shared-ledger-gate-bindings.js";
import { STATE_DIR } from "./paths.js";
import { writeJsonAtomicSync } from "./state-file.js";
import { SharedLedgerScrubError, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";

export interface MigrationRecord {
  schemaVersion: 1;
  selectionDigest: string;
  featureIds: string[];
  backup: string;
  phase: "gating" | "prepared" | "committing" | "verified" | "active" | "revoking" | "revoked" | "aborted";
  payload?: SharedLedgerImport;
  target?: string;
  receipt?: SharedLedgerImportReceipt;
}
/**
 * Errors this script raises itself: fixed text with no data from the ledger, the center or a file, so main() prints them as-is.
 * Anything else (center responses, parse failures, library errors) may carry data and still prints only the generic line.
 */
export class MigrationError extends Error {}
const GENERIC_STOP = "Migration stopped; retain local gate and inspect the local journal before recovery.";
export const migrationErrorText = (error: unknown): string =>
  error instanceof MigrationError || error instanceof SharedLedgerScrubError || error instanceof SharedLedgerExportContractError
    ? error.message : GENERIC_STOP;

const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id);
const journalPath = (dir: string, batch: string) => join(dir, "shared-ledger-migrations", `${batch}.json`);

/** Unknown starts remain blockers even after the scheduler has recorded an unknown settlement. */
function preflight(db: Database, options: SharedLedgerExportOptions): void {
  const ids = new Set(options.featureIds);
  if (!ids.size || ids.size !== options.featureIds.length || [...ids].some((id) => !validId(id))) throw new MigrationError("invalid migration selection");
  for (const id of ids) {
    const feature = getFeature(db, id);
    if (!feature || feature.project !== options.localProject) throw new MigrationError("migration feature unavailable");
    if (getPendingProposal(db, id)) throw new MigrationError("migration blocked: pending proposal");
  }
  const events = listEvents(db, { project: options.localProject });
  for (const event of events) {
    if (event.data.op !== "autostart_claim" || !ids.has(event.target)) continue;
    const settled = getEventByDedup(db, `autostart-settle:${event.seq}`)?.data;
    if (!settled || !["done", "failed"].includes(String(settled.outcome)) || (settled.leftovers as unknown[] | undefined)?.length) {
      throw new MigrationError("migration blocked: in-flight or unknown start");
    }
  }
  // A manual start has no claim; an unfinished dag-start attempt in the project is conservatively unknown.
  // Its first task event may precede feature assignment, so filtering by tasks.featureId would miss it.
  for (const event of events.filter((e) => e.dedupKey?.startsWith("dag-start:") && e.dedupKey.endsWith(":task-new"))) {
    const prefix = event.dedupKey!.slice(0, -"task-new".length);
    // Cancellation alone does not prove worktree/agent cleanup succeeded: only a bind or a verified `ledger start-settle` record
    // (src/lib/dag-start-settle.ts: rolled back, session stopped, worktree gone) finishes the attempt.
    if (!getEventByDedup(db, `${prefix}bind`) && !getEventByDedup(db, `${prefix}settled`)) {
      throw new MigrationError("migration blocked: unfinished manual start");
    }
  }
}

function readRecord(path: string): MigrationRecord | null {
  if (!existsSync(path)) return null;
  const value = JSON.parse(readFileSync(path, "utf8")) as MigrationRecord;
  if (value.schemaVersion !== 1 || !["gating", "prepared", "committing", "verified", "active", "revoking", "revoked", "aborted"].includes(value.phase)
    || typeof value.backup !== "string" || !/^[a-f0-9]{64}$/.test(value.selectionDigest)
    || !Array.isArray(value.featureIds) || !value.featureIds.length || value.featureIds.some((id) => !validId(id))) throw new MigrationError("invalid migration journal");
  if (value.payload) value.payload = parseSharedLedgerImport(value.payload);
  if (value.phase !== "gating" && value.phase !== "aborted" && !value.payload) throw new MigrationError("missing migration payload");
  return value;
}

/** Durable, local-only preparation. Nothing is uploaded before the operator reviews the returned manifest digest. */
export async function prepareSharedLedgerImport(db: Database, options: SharedLedgerExportOptions) {
  if (!validId(options.batchId) || !db.filename || db.filename === ":memory:") throw new MigrationError("persistent batch and ledger required");
  const dir = join(options.stateDir, "shared-ledger-migrations"), path = journalPath(options.stateDir, options.batchId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(migrationLockPath(options.stateDir));
  if (!lock) throw new MigrationError("migration lock unavailable");
  try {
    const selectionDigest = createHash("sha256").update(canonicalJson({ ...options, scrub: undefined })).digest("hex");
    let record = readRecord(path);
    if (record && record.selectionDigest !== selectionDigest) throw new MigrationError("batch selection changed");
    if (record?.phase === "revoked" || record?.phase === "aborted") throw new MigrationError("batch revoked; choose a new batch");
    if (record && record.phase !== "gating") {
      for (const id of options.featureIds) if (!readSharedLedgerMode(id, options.stateDir).sharedPlanning) throw new MigrationError("migration gate missing");
      return { payload: record.payload!, preview: canonicalJson(record.payload!.manifest), backup: record.backup };
    }
    if (!record) {
      // A crash can leave the mode reopened before the revocation journal is saved. The old batch still owns its selection.
      for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
        const prior = readRecord(join(dir, file));
        if (prior && prior.phase !== "revoked" && prior.phase !== "aborted" && prior.featureIds.some((id) => options.featureIds.includes(id))) {
          throw new MigrationError("feature already migrating or shared");
        }
      }
      preflight(db, options);
      for (const id of options.featureIds) {
        const mode = readSharedLedgerMode(id, options.stateDir);
        if (mode.sharedPlanning || mode.authorityMode !== "source") throw new MigrationError("feature already migrating or shared");
      }
      const backup = vacuumBackup(db, join(dir, `${options.batchId}.backup.sqlite`), "migration backup failed", "migration stopped", false);
      chmodSync(backup, 0o600);
      record = { schemaVersion: 1, selectionDigest, featureIds: [...options.featureIds], backup, phase: "gating" };
      writeJsonAtomicSync(path, record, { mode: 0o600, commitIf: lock.held });
    }
    const modes = Object.fromEntries(options.featureIds.map((id) => [id, { authorityMode: "source" as const, sharedPlanning: true }]));
    await writeSharedLedgerModes(modes, options.stateDir, db.filename, () => preflight(db, options));
    const exported = previewSharedLedgerExport(db, options);
    writeJsonAtomicSync(path, { ...record, phase: "prepared", payload: exported.payload }, { mode: 0o600, commitIf: lock.held });
    return { ...exported, backup: record.backup };
  } finally { lock.release(); }
}

/** A batch that never entered committing has no possible center write; reopen only while holding the migration and ledger writer locks. */
export async function revokeUncommittedSharedLedgerImport(db: Database, stateDir: string, batchId: string, approvedDigest = "") {
  if (!validId(batchId)) throw new MigrationError("invalid batch id");
  const dir = join(stateDir, "shared-ledger-migrations"), path = journalPath(stateDir, batchId);
  const lock = await acquireLock(migrationLockPath(stateDir));
  if (!lock) throw new MigrationError("migration lock unavailable");
  try {
    const record = readRecord(path);
    if (!record) throw new MigrationError("migration journal missing");
    if (record.phase === "aborted") return { status: "aborted" as const, batchId };
    if (record.phase !== "gating" && record.phase !== "prepared") return null;
    if (record.phase === "prepared" && record.payload?.manifestDigest !== approvedDigest) throw new MigrationError("reviewed manifest digest required");
    await writeSharedLedgerModes(Object.fromEntries(record.featureIds.map((id) =>
      [id, { authorityMode: "source" as const, sharedPlanning: false }])), stateDir, db.filename, () => {
      for (const id of record.featureIds) if (readSharedLedgerMode(id, stateDir).authorityMode !== "source") {
        throw new MigrationError("migration authority changed");
      }
    });
    record.phase = "aborted";
    writeJsonAtomicSync(path, record, { mode: 0o600, commitIf: lock.held });
    dropAbortedAutoBackup(stateDir, batchId);
    return { status: "aborted" as const, batchId };
  } finally { lock.release(); }
}
/** An aborted auto-share batch (auto- prefix) drops its own backup; staged / verified / revoked and manual batches keep theirs. */
export const dropAbortedAutoBackup = (stateDir: string, batchId: string) =>
  batchId.startsWith("auto-") && rmSync(join(stateDir, "shared-ledger-migrations", `${batchId}.backup.sqlite`), { force: true });

function checkReceipt(payload: SharedLedgerImport, receipt: SharedLedgerImportReceipt) {
  if (receipt.status === "unknown" || receipt.batchId !== payload.batchId || receipt.projectId !== payload.manifest.projectId
    || receipt.receipt.manifestDigest !== payload.manifestDigest || !receipt.verification) throw new MigrationError("migration receipt unconfirmed");
  const features = payload.manifest.features;
  const expected = { features: features.length, versions: features.reduce((n, f) => n + f.versions.length, 0),
    bindings: features.reduce((n, f) => n + f.versions.reduce((a, v) => a + v.bindings.length, 0), 0),
    tasks: features.reduce((n, f) => n + f.projection.tasks.length, 0), sourceSeq: payload.manifest.sourceSeq, manifestDigest: payload.manifestDigest };
  if (canonicalJson(expected) !== canonicalJson(receipt.verification) || receipt.serverSeq < receipt.receipt.serverSeq) {
    throw new MigrationError("migration verification mismatch");
  }
  const expectedMaps = features.flatMap((f) => [`feature:${f.sourceFeatureId}`, ...f.projection.tasks.map((t) => `task:${t.sourceTaskId}`)]).sort();
  const maps = receipt.receipt.mappings;
  if (canonicalJson(expectedMaps) !== canonicalJson(maps.map((m) => `${m.kind}:${m.sourceId}`).sort())
    || maps.some((m) => m.sourceInstanceId !== payload.manifest.sourceInstanceId) || new Set(maps.map((m) => m.id)).size !== maps.length) {
    throw new MigrationError("migration mapping mismatch");
  }
}

/** Explicit phases, never an automatic queue: every recovery first reads the same batch's durable receipt. */
export async function advanceSharedLedgerImport(db: Database, stateDir: string, batchId: string, client: SharedLedgerClient,
  approvedDigest: string, action: "commit" | "activate" | "revoke") {
  if (!validId(batchId)) throw new MigrationError("invalid batch id");
  if (action === "revoke") {
    const local = await revokeUncommittedSharedLedgerImport(db, stateDir, batchId, approvedDigest);
    if (local) return local;
  }
  const dir = join(stateDir, "shared-ledger-migrations"), path = journalPath(stateDir, batchId);
  const lock = await acquireLock(migrationLockPath(stateDir));
  if (!lock) throw new MigrationError("migration lock unavailable");
  try {
    const record = readRecord(path), payload = record?.payload;
    if (record?.phase === "aborted") throw new MigrationError("migration aborted");
    if (!record || !payload || payload.manifestDigest !== approvedDigest) throw new MigrationError("reviewed manifest digest required");
    const { bearer: _secret, ...connection } = client.connection;
    const target = canonicalJson(connection);
    if ((record.target && record.target !== target) || connection.instanceId !== payload.manifest.sourceInstanceId) throw new MigrationError("migration identity changed");
    if (record.phase === "revoked" && action !== "revoke") throw new MigrationError("migration revoked");
    const save = () => writeJsonAtomicSync(path, record, { mode: 0o600, commitIf: lock.held });
    record.target = target; save();
    let receipt = await client.importReceipt(batchId);
    if (record.receipt && record.receipt.status !== "unknown"
      && (receipt.status === "unknown" || receipt.serverSeq < record.receipt.serverSeq)) throw new MigrationError("center receipt rollback");
    if (receipt.status === "unknown") {
      if (action !== "commit" || ["active", "verified", "revoking", "revoked"].includes(record.phase)) throw new MigrationError("migration outcome unknown");
      checkLocalSnapshot(db, payload, stateDir);
      await client.import({ ...payload, mode: "dry-run" });
      record.phase = "committing"; save();
      await client.commitImport(payload);
      receipt = await client.importReceipt(batchId);
    }
    checkReceipt(payload, receipt);
    if (receipt.status === "unknown") throw new MigrationError("migration outcome unknown");
    // Replaying a finished revoke must never reopen a feature now owned by a newer batch.
    if (record.phase === "revoked") {
      if (receipt.status !== "revoked") throw new MigrationError("center receipt rollback");
      return receipt;
    }
    record.receipt = receipt; save();
    if (action === "revoke") {
      if (receipt.status === "active") throw new MigrationError("planning already opened; separate return migration required");
      record.phase = "revoking"; save();
      receipt = await client.controlImport({ mode: "revoke", batchId, manifestDigest: approvedDigest, projectId: payload.manifest.projectId });
      checkReceipt(payload, receipt);
      await writeSharedLedgerModes(Object.fromEntries(payload.manifest.features.map((f) =>
        [f.sourceFeatureId, { authorityMode: "source" as const, sharedPlanning: false }])), stateDir, db.filename);
      record.phase = "revoked"; record.receipt = receipt; save();
      return receipt;
    }
    if (receipt.status === "revoked") throw new MigrationError("migration revoked");
    if (action === "activate" && receipt.status !== "active") {
      checkLocalSnapshot(db, payload, stateDir);
      receipt = await client.controlImport({ mode: "activate", batchId, manifestDigest: approvedDigest, projectId: payload.manifest.projectId });
      checkReceipt(payload, receipt);
    }
    record.phase = receipt.status === "active" ? "active" : "verified"; record.receipt = receipt; save();
    if (receipt.status === "active") {
      await writeSharedLedgerModes(Object.fromEntries(payload.manifest.features.map((f) =>
        [f.sourceFeatureId, { authorityMode: "planning" as const, sharedPlanning: true }])), stateDir, db.filename);
      await setSharedLedgerBinding({ centerId: connection.centerId, teamId: connection.teamId,
        projectId: payload.manifest.projectId, localProjectId: getFeature(db, payload.manifest.features[0]!.sourceFeatureId)!.project }, stateDir);
    }
    return receipt;
  } finally { lock.release(); }
}

function checkLocalSnapshot(db: Database, payload: SharedLedgerImport, dir: string) {
  db.transaction(() => {
    for (const source of payload.manifest.features) {
      const current = getFeature(db, source.sourceFeatureId);
      if (!readSharedLedgerMode(source.sourceFeatureId, dir).sharedPlanning || !current
        || current.rev !== source.rev || current.currentVersion !== source.versions.length || getPendingProposal(db, source.sourceFeatureId)) {
        throw new MigrationError("planning changed; new preview required");
      }
    }
  }).deferred();
}

/**
 * The one scrub context for prepare/commit/activate/revoke: local identity plus the heads of the selected tasks (and of an
 * already reviewed payload) that are real commits in the install repo. It only lives in `scrub`, so selectionDigest is unchanged.
 */
export async function importScrubContext(db: Database, plan: Pick<SharedLedgerExportOptions, "localProject" | "featureIds" | "batchId">,
  stateDir: string, identity: SharedLedgerScrubContext["identity"] = { username: userInfo().username, hostname: hostname() },
  repoDir?: string): Promise<SharedLedgerScrubContext> {
  const heads = sharedLedgerExportHeads(db, plan.localProject, plan.featureIds);
  const reviewed = validId(plan.batchId) ? readRecord(journalPath(stateDir, plan.batchId))?.payload : undefined;
  for (const feature of reviewed?.manifest.features ?? []) for (const task of feature.projection.tasks) if (task.head) heads.push(task.head);
  return sharedLedgerScrubWithCommits({ identity }, heads, repoDir);
}

/** Import is only granted to service enrollments (JN1: `--role service` codes); member codes carry read/plan only. */
export const resolveImportCredential = (plan: { centerId: string; teamId: string; projectId: string }, dir = STATE_DIR) =>
  resolveSharedLedgerCredential("owner:self", "service", plan.centerId, plan.teamId, plan.projectId, "import", dir);

/** N8A auto-share runs the same selection checks and journal reads as prepare (names kept from the script). */
export { preflight as sharedLedgerImportPreflight, readRecord as readSharedLedgerImportRecord, journalPath as sharedLedgerImportJournalPath };
