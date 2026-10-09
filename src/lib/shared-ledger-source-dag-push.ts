/**
 * team-project-N8M: after each mirror pass (projection pushed or idle) a source mirror whose local DAG moved past the
 * version the center confirmed uploads its current version once (`POST source-dags`, contract N8MK). Intermediate
 * versions are skipped, as the contract allows. Errors live in dag* fields only: the projection's failures / backoff
 * never see them. A 429 escapes to the pass so every remaining feature stops immediately.
 */
import type { Database } from "bun:sqlite";
import { getFeature, getDagVersion, effectiveNodes } from "./ledger-feature.js";
import { SharedLedgerRemoteError } from "./shared-ledger-client-transport.js";
import { STATE_DIR } from "./paths.js";
import { fitSharedLedgerText, sharedLedgerExportLimits } from "./shared-ledger-export.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";
import { mirrorBackoffMs, type MirrorEntry } from "./shared-ledger-projector.js";
import { scrubSharedLedger, SharedLedgerScrubError, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { parseSourceDagUpload, type SourceDagUpload, type SourceDagUploadOutcome } from "./shared-ledger-contract-source-dag.js";
import { sharedLedgerDagVersion, sourceDagScrubView } from "./shared-ledger-source-dag-push-version.js";
import { readSharedLedgerMirrors } from "./shared-ledger-mirror.js";

export interface SourceDagClient { sourceDag(upload: SourceDagUpload): Promise<SourceDagUploadOutcome> }
/** An old center (404) is asked again after this long; not a failure, no backoff. */
export const SOURCE_DAG_UNSUPPORTED_RETRY_MS = 6 * 60 * 60_000;
/** Fixed reasons only: center bodies and exception messages can carry secrets. */
export const SOURCE_DAG_REASONS = {
  blocked: "DAG 版本含不能外发的内容",
  unavailable: "中心不可达，DAG 版本上传结果未确认",
  mismatch: "中心回执与上传的 DAG 版本对不上",
  behind: "中心来源 DAG 版本冲突（409）",
  rejected: (status: number) => `中心拒收 DAG 版本（${status}）`,
  local: "本机 DAG 版本读不到",
} as const;

/** The current local version as an upload; bindings carry local task ids (= sourceTaskId). Throws SharedLedgerScrubError when blocked. */
function buildSourceDagUpload(db: Database, featureId: string, entry: MirrorEntry, scrub: SharedLedgerScrubContext): SourceDagUpload {
  const feature = getFeature(db, featureId);
  const dag = feature && feature.project === entry.localProject ? getDagVersion(db, featureId, feature.currentVersion) : null;
  if (!dag) throw new Error("source dag unavailable");
  const original: SourceDagUpload = { schemaVersion: 1, projectId: entry.projectId, featureId: entry.centerFeatureId,
    sourceInstanceId: entry.sourceInstanceId, dag: sharedLedgerDagVersion(dag, effectiveNodes(db, dag)) };
  // Scrub the untruncated text first (as the export does): a cut could leave a secret fragment below every detector.
  scrubSharedLedger(sourceDagScrubView(original), (value) => value, scrub);
  const limit = sharedLedgerExportLimits();
  const fitted: SourceDagUpload = { ...original, dag: { ...original.dag, reason: fitSharedLedgerText(original.dag.reason, limit.reason),
    nodes: original.dag.nodes.map((n) => ({ ...n, oneLine: fitSharedLedgerText(n.oneLine, limit.oneLine),
      estimate: fitSharedLedgerText(n.estimate, limit.estimate) })) } };
  return scrubSharedLedger(sourceDagScrubView(fitted), () => parseSourceDagUpload(fitted), scrub);
}

export interface SourceDagPushDeps { client: Partial<SourceDagClient>; scrub: SharedLedgerScrubContext; now: number; stateDir?: string }
/** Returns the same entry object when nothing was attempted, so the caller can skip the write-back. */
export async function pushSourceDagMirror(db: Database, featureId: string, entry: MirrorEntry, deps: SourceDagPushDeps): Promise<MirrorEntry> {
  const { client, now } = deps;
  if (!client.sourceDag || (entry.dagUnsupportedUntil ?? 0) > now || (entry.dagError?.nextAttemptAt ?? 0) > now) return entry;
  try {
    // Source mirrors only: an N7X planning replica (centerPlanned) is written by the center, never uploaded from here.
    const mode = readSharedLedgerMode(featureId, deps.stateDir ?? STATE_DIR);
    if (mode.authorityMode !== "source" || mode.mirror !== true) return entry;
  } catch { return entry; } // Unverifiable authority must never upload a DAG.
  const local = getFeature(db, featureId)?.currentVersion ?? 0;
  if (local <= (entry.dagVersion ?? 0)) return entry;
  const fail = (reason: string): MirrorEntry => {
    const failures = (entry.dagError?.failures ?? 0) + 1;
    return { ...entry, dagError: { reason, at: now, failures, nextAttemptAt: now + mirrorBackoffMs(failures) } };
  };
  let upload: SourceDagUpload;
  try { upload = buildSourceDagUpload(db, featureId, entry, deps.scrub); }
  catch (error) { return fail(error instanceof SharedLedgerScrubError ? SOURCE_DAG_REASONS.blocked : SOURCE_DAG_REASONS.local); }
  let outcome: SourceDagUploadOutcome;
  try { outcome = await client.sourceDag(upload); }
  catch (error) {
    if (error instanceof SharedLedgerRemoteError && error.status === 429) throw error; // The pass owns the global cooldown; never count this as a DAG failure.
    return fail(error instanceof SharedLedgerScrubError ? SOURCE_DAG_REASONS.blocked : SOURCE_DAG_REASONS.unavailable);
  }
  const confirmed = (version: number): MirrorEntry => ({ ...entry, dagVersion: version, dagUnsupportedUntil: null, dagError: null });
  if (outcome.kind === "unsupported") return { ...entry, dagUnsupportedUntil: now + SOURCE_DAG_UNSUPPORTED_RETRY_MS };
  if (outcome.kind === "ok") {
    const r = outcome.result;
    return r.featureId === upload.featureId && r.version === upload.dag.version ? confirmed(r.version) : fail(SOURCE_DAG_REASONS.mismatch);
  }
  const e = outcome.error;
  if (e.code === "conflict") {
    // N8MC P2-1: a retry of the same body after the center's binding map grew is a 409 at the same version: already there.
    return e.currentVersion >= upload.dag.version ? confirmed(upload.dag.version) : fail(SOURCE_DAG_REASONS.behind);
  }
  return fail(SOURCE_DAG_REASONS.rejected(e.status));
}

/** `ledger shared-mirror status` fields (older entries: version 0, nothing pending). */
export function sourceDagStatus(featureId: string, dir = STATE_DIR) {
  const e = readSharedLedgerMirrors(dir)[featureId];
  const at = (t: number | null | undefined) => t ? new Date(t).toISOString() : null;
  return e ? { dagVersion: e.dagVersion ?? 0, dagUnsupportedUntil: at(e.dagUnsupportedUntil),
    dagError: e.dagError ? { reason: e.dagError.reason, at: at(e.dagError.at), failures: e.dagError.failures,
      nextAttemptAt: at(e.dagError.nextAttemptAt) } : null } : {};
}
