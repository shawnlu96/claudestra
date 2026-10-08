/**
 * N8A candidate list + per-feature pre-check. Nothing here installs a gate, writes a journal or a mode, or calls the center:
 * the same preflight prepare runs, then a single-feature export preview against a throwaway mode file in the OS temp dir
 * (previewSharedLedgerExport only reads the planning gate from `stateDir`), so the real state dir is never touched.
 */
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomicSync } from "./state-file.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";
import { previewSharedLedgerExport, SharedLedgerExportContractError, sharedLedgerExportTasks, type SharedLedgerExportOptions } from "./shared-ledger-export.js";
import { SharedLedgerScrubError, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { MigrationError, readSharedLedgerImportRecord, sharedLedgerImportPreflight } from "./shared-ledger-import-run.js";
import type { AutoShareFeature } from "./shared-ledger-auto-share-state.js";
import { AUTO_SHARE_MAX_BATCH_BYTES, autoSharePlanEntry, type AutoSharePlanEntry } from "./shared-ledger-auto-share-batch.js";

/** Fixed texts only: shown by `shared-auto status`, never the refused content itself. */
export const AUTO_SHARE_REASONS = {
  proposal: "有未批修订提案", start: "有未结开工", journal: "已在其他未撤销的迁移批次里", noDag: "还没有子 DAG",
  precheck: "预检未通过", scrub: "当前内容含不能外发的文字", center: "中心拒收", control: "自动共享开关已改，本批未上传",
  sharedCards: "与已共享的 feature 共用卡", tooLarge: "体积超过中心上限", prepare: "导入准备失败",
  batchPrepare: "批次准备失败", batchTooLarge: "批次体积超过中心上限",
} as const;

// Rule version (2: task projection, 3: batching / size / shared cards): a refusal from another version is checked again (absent = 1).
export const AUTO_SHARE_RULES = 3;
export interface AutoShareCheckInput {
  db: Database; dir: string; localProject: string; projectId: string; sourceInstanceId: string;
  exclude: readonly string[]; prior: Readonly<Record<string, AutoShareFeature>>; pendingIds: ReadonlySet<string>; now: number;
  scrub: (featureIds: string[], batchId: string) => Promise<SharedLedgerScrubContext>;
}

/** Feature ids held by a migration journal that is not revoked / aborted (prepare refuses them too). */
function liveJournalFeatures(dir: string): Set<string> {
  const root = join(dir, "shared-ledger-migrations"), out = new Set<string>();
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root).filter((n) => n.endsWith(".json"))) {
    const record = readSharedLedgerImportRecord(join(root, name));
    if (record && record.phase !== "revoked" && record.phase !== "aborted") for (const id of record.featureIds) out.add(id);
  }
  return out;
}

function previewWithoutGate(db: Database, options: SharedLedgerExportOptions) {
  const scratch = mkdtempSync(join(tmpdir(), "sl-auto-share-"));
  try {
    writeJsonAtomicSync(join(scratch, "shared-ledger-modes.json"), { features: Object.fromEntries(options.featureIds.map((id) =>
      [id, { authorityMode: "source", sharedPlanning: true }])) }, { mode: 0o600 });
    return previewSharedLedgerExport(db, { ...options, stateDir: scratch });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function preflightReason(error: unknown): string {
  if (!(error instanceof MigrationError)) return AUTO_SHARE_REASONS.precheck;
  if (error.message.includes("pending proposal")) return AUTO_SHARE_REASONS.proposal;
  return error.message.includes("start") ? AUTO_SHARE_REASONS.start : AUTO_SHARE_REASONS.precheck;
}

/** Tasks uploaded by the features already shared from this project (a live journal holds them), by the export's own rule. */
function sharedTaskIds(db: Database, localProject: string, live: ReadonlySet<string>): Set<string> {
  return new Set([...live].flatMap((id) => sharedLedgerExportTasks(db, localProject, id).map((t) => t.id)));
}

export interface AutoShareCheckResult { results: Record<string, AutoShareFeature>; ready: string[]; plan: Record<string, AutoSharePlanEntry> }
/** Every active feature of the bound project gets a result; `ready` are the ones that passed, in id order, `plan` how to batch them. */
export async function checkAutoShareCandidates(input: AutoShareCheckInput): Promise<AutoShareCheckResult> {
  const { db, dir, now } = input;
  const rows = db.prepare("SELECT id, rev, currentVersion FROM features WHERE project = ? AND status = 'active' ORDER BY id")
    .all(input.localProject) as { id: string; rev: number; currentVersion: number }[];
  const live = liveJournalFeatures(dir), results: Record<string, AutoShareFeature> = {}, ready: string[] = [];
  const plan: Record<string, AutoSharePlanEntry> = {};
  let shared: Set<string> | undefined;
  for (const { id, rev, currentVersion: version } of rows) {
    const mode = readSharedLedgerMode(id, dir);
    if (mode.centerPlanned) continue; // A center replica is never imported back.
    if (mode.authorityMode !== "source" || mode.sharedPlanning) {
      results[id] = { status: input.pendingIds.has(id) ? "in_batch" : "shared", at: now };
      continue;
    }
    if (input.exclude.includes(id)) { results[id] = { status: "excluded", at: now }; continue; }
    const prior = input.prior[id];
    const base = { rev, version, at: now, ...(prior?.solo ? { solo: true } : {}) };
    if (live.has(id)) { results[id] = { status: "deferred", reason: AUTO_SHARE_REASONS.journal, ...base }; continue; }
    // Refused content is not retried (nor rewritten to pass) until the feature itself, or the export rules it was refused under, change.
    const staleRules = (prior?.rules ?? 1) !== AUTO_SHARE_RULES;
    if (prior?.status === "refused" && prior.rev === rev && prior.version === version && !staleRules) { results[id] = prior; continue; }
    if (version < 1) { results[id] = { status: "deferred", reason: AUTO_SHARE_REASONS.noDag, ...base }; continue; }
    const batchId = "auto-precheck";
    const options: SharedLedgerExportOptions = { localProject: input.localProject, projectId: input.projectId, sourceInstanceId: input.sourceInstanceId,
      featureIds: [id], batchId, stateDir: dir, scrub: { identity: { username: "-", hostname: "-" } }, summaries: {} };
    try { sharedLedgerImportPreflight(db, options); }
    catch (error) { results[id] = { status: "deferred", reason: preflightReason(error), ...base }; continue; }
    const refuse = (reason: string): AutoShareFeature => ({ status: "refused", reason, rev, version, at: now, rules: AUTO_SHARE_RULES });
    const taskIds = sharedLedgerExportTasks(db, input.localProject, id).map((t) => t.id);
    shared ??= sharedTaskIds(db, input.localProject, live);
    if (taskIds.some((t) => shared!.has(t))) { results[id] = refuse(AUTO_SHARE_REASONS.sharedCards); continue; }
    let entry: AutoSharePlanEntry;
    try { entry = autoSharePlanEntry(previewWithoutGate(db, { ...options, scrub: await input.scrub([id], batchId) }).payload, taskIds, !!prior?.solo); }
    catch (error) {
      const refused = error instanceof SharedLedgerScrubError || error instanceof SharedLedgerExportContractError;
      results[id] = refused ? refuse(AUTO_SHARE_REASONS.scrub) : { status: "deferred", reason: AUTO_SHARE_REASONS.precheck, ...base };
      continue;
    }
    if (entry.bytes > AUTO_SHARE_MAX_BATCH_BYTES) { results[id] = refuse(AUTO_SHARE_REASONS.tooLarge); continue; }
    results[id] = { status: "will_share", ...base };
    ready.push(id);
    plan[id] = entry;
  }
  return { results, ready, plan };
}
