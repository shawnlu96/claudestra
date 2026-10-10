/**
 * PJ1 projector: one mirrored source feature → one `/projections` push (X0/C1 DTO only).
 * Pure with respect to durable state: it returns the next mirror entry and the caller persists it,
 * so a failed push never moves the watermark (docs/design/shared-ledger.md §3.2).
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalJson } from "./ask-bind.js";
import { getFeature, getDagVersion, effectiveNodes } from "./ledger-feature.js";
import { listTasks, listDeps, listEvents } from "./ledger-store.js";
import type { SharedLedgerProjection, SharedLedgerProjectionResult, SharedLedgerTaskProjection } from "./shared-ledger-contract.js";
import { SharedLedgerRemoteError } from "./shared-ledger-client.js";
import { scrubSharedLedger, SharedLedgerScrubError, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { parseSharedLedgerProjection } from "./shared-ledger-contract-transfer.js";
import { record } from "./shared-ledger-contract-schema.js";
import type { SourceDagClient } from "./shared-ledger-source-dag-push.js";
import { sharedLedgerTaskProjection } from "./shared-ledger-task-projection.js";

/** Summary / member code reviewed at import time; never re-derived from local spec files or nicknames. */
export interface MirrorTaskMeta { specSummary: string; specDigest: string | null; assigneeCode: string | null }
export interface MirrorEntry {
  enabled: boolean;
  batchId: string; centerId: string; teamId: string; projectId: string; centerFeatureId: string;
  sourceInstanceId: string; localProject: string;
  /** Last sourceSeq the center confirmed for this feature. */
  watermark: number;
  /** Next push must be a full snapshot (after a conflict / watermark gap). */
  snapshot: boolean;
  fingerprints: Record<string, string>;
  taskMeta: Record<string, MirrorTaskMeta>;
  lastPushAt: number | null; lastPushSeq: number | null;
  lastError: string | null; lastErrorAt: number | null;
  failures: number; nextAttemptAt: number;
  /** N8M source-DAG upload, kept apart from the projection fields above (absent in older files = 0 / null). */
  dagVersion?: number; dagUnsupportedUntil?: number | null;
  dagError?: { reason: string; at: number; failures: number; nextAttemptAt: number } | null;
}
export interface MirrorClient { projection(input: SharedLedgerProjection): Promise<SharedLedgerProjectionResult>; sourceDag?: SourceDagClient["sourceDag"] }
export type PushOutcome =
  | { kind: "idle"; seq: number }
  | { kind: "pushed"; mode: "snapshot" | "delta"; seq: number; tasks: number; events: number }
  | { kind: "failed"; error: string };

const BACKOFF_BASE_MS = 10_000, BACKOFF_MAX_MS = 5 * 60_000;
export const mirrorBackoffMs = (failures: number) => Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));

const fingerprint = (t: SharedLedgerTaskProjection) => createHash("sha256")
  // Step sourceSeq follows the global watermark and changes every push; it is not a task change.
  .update(canonicalJson({ ...t, steps: t.steps.map(({ sourceSeq: _seq, ...s }) => s) })).digest("hex");

function ownTasks(db: Database, featureId: string, localProject: string) {
  const feature = getFeature(db, featureId);
  if (!feature || feature.project !== localProject) throw new Error("mirror feature unavailable");
  const bound = new Set<string>();
  for (let version = 1; version <= feature.currentVersion; version++) {
    const dag = getDagVersion(db, featureId, version);
    if (dag) for (const n of effectiveNodes(db, dag)) if (n.taskId) bound.add(n.taskId);
  }
  return listTasks(db, localProject).filter((t) => t.featureId === featureId || bound.has(t.id)).sort((a, b) => a.id.localeCompare(b.id));
}

/** Heads the scrub may need to recognise as real commits (unknown heads are sent as null, never as raw hex). */
export const mirrorTaskHeads = (db: Database, featureId: string, localProject: string) =>
  ownTasks(db, featureId, localProject).flatMap((t) => t.headSHA ? [t.headSHA.toLowerCase()] : []);

/** Builds the full current task set at `seq`; field rules in shared-ledger-task-projection.ts. */
function mirrorTaskProjections(db: Database, featureId: string, entry: Pick<MirrorEntry, "localProject" | "sourceInstanceId" | "taskMeta">,
  seq: number, commits: ReadonlySet<string>): SharedLedgerTaskProjection[] {
  const tasks = ownTasks(db, featureId, entry.localProject), ids = new Set(tasks.map((t) => t.id));
  const lastSeq = new Map((db.prepare("SELECT target, MAX(seq) AS seq FROM events WHERE project = ? GROUP BY target")
    .all(entry.localProject) as { target: string; seq: number }[]).map((r) => [r.target, r.seq]));
  const deps = listDeps(db, entry.localProject);
  return tasks.map((task) => {
    const meta = entry.taskMeta[task.id] ?? { specSummary: "", specDigest: null, assigneeCode: null };
    return sharedLedgerTaskProjection(db, task, { sourceSeq: Math.min(lastSeq.get(task.id) ?? 0, seq), stepSeq: seq,
      specSummary: meta.specSummary, specDigest: meta.specDigest, assigneeCode: meta.assigneeCode,
      executorInstanceId: entry.sourceInstanceId, featureTaskIds: ids, edges: deps, commits });
  });
}

/** Snapshot event base: the center's watermark from a conflict body when it is behind ours, else our last confirmed one. */
function snapshotBase(error: unknown, watermark: number): number {
  if (!(error instanceof SharedLedgerRemoteError)) return watermark;
  let at: unknown;
  try { at = record(record(record(record(error.response).latest).feature).projection).sourceSeq; }
  catch { return watermark; } // No usable center watermark (null projection / non-conflict body).
  return typeof at === "number" && Number.isSafeInteger(at) && at >= 0 && at < watermark ? at : watermark;
}
/** Fixed text only: remote bodies and exception messages can carry secrets. */
export function mirrorErrorSummary(error: unknown): string {
  if (error instanceof SharedLedgerScrubError) return `upload blocked at ${error.fields.slice(0, 5).join(", ")}`;
  if (error instanceof SharedLedgerRemoteError) return `center rejected (${error.status})`;
  if (error instanceof Error && error.message === "mirror feature unavailable") return error.message;
  return "center unavailable; outcome unconfirmed";
}

export interface PushDeps { client: MirrorClient; scrub: SharedLedgerScrubContext; now: number }
/**
 * Nothing to send unless the local global event seq moved past the watermark (PM 10-02: freshness rides any local event;
 * a fully idle machine shows stale on the center). A conflict or gap gets exactly one full snapshot in the same pass.
 */
export async function pushSharedLedgerMirror(db: Database, featureId: string, entry: MirrorEntry, deps: PushDeps): Promise<{ entry: MirrorEntry; outcome: PushOutcome }> {
  const fail = (error: unknown, snapshot: boolean) => {
    if (error instanceof SharedLedgerRemoteError && error.status === 429) throw error;
    const failures = entry.failures + 1, text = mirrorErrorSummary(error);
    return { entry: { ...entry, snapshot, failures, lastError: text, lastErrorAt: deps.now, nextAttemptAt: deps.now + mirrorBackoffMs(failures) },
      outcome: { kind: "failed" as const, error: text } };
  };
  let seq: number, current: SharedLedgerTaskProjection[];
  try {
    seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
    if (seq < entry.watermark) throw new Error("local ledger behind center watermark");
    // A snapshot also needs a newer sourceSeq: the center answers an equal one from its cached receipt.
    if (seq === entry.watermark) return { entry, outcome: { kind: "idle", seq } };
    current = mirrorTaskProjections(db, featureId, entry, seq, deps.scrub.commits ?? new Set());
  } catch (error) { return fail(error, entry.snapshot); }
  const ids = new Set(current.map((t) => t.sourceTaskId));
  const build = (mode: "snapshot" | "delta", previousSourceSeq: number): SharedLedgerProjection => ({
    projectId: entry.projectId, featureId: entry.centerFeatureId, sourceInstanceId: entry.sourceInstanceId, mode, previousSourceSeq,
    sourceSeq: seq, observedAt: deps.now,
    // A task missing locally is simply not sent: absence never means deletion or completion on the center.
    tasks: mode === "snapshot" ? current
      : current.filter((t) => t.sourceSeq > previousSourceSeq || entry.fingerprints[t.sourceTaskId] !== fingerprint(t)),
    events: listEvents(db, { project: entry.localProject, afterSeq: previousSourceSeq }).filter((e) => e.seq <= seq && ids.has(e.target))
      .map((e) => ({ sourceSeq: e.seq, sourceTaskId: e.target, type: e.kind, at: e.ts, summary: e.kind })),
  });
  const send = async (projection: SharedLedgerProjection) => {
    // Scrub here as well as in the client so a fake or proxied client can never receive a blocked value.
    const payload = scrubSharedLedger(projection, parseSharedLedgerProjection, deps.scrub);
    const result = await deps.client.projection(payload);
    if (result.sourceSeq !== payload.sourceSeq || result.sourceInstanceId !== payload.sourceInstanceId) throw new Error("projection receipt mismatch");
    return payload;
  };
  let sent: SharedLedgerProjection;
  try {
    sent = await send(build(entry.snapshot ? "snapshot" : "delta", entry.watermark));
  } catch (error) {
    if (entry.snapshot || !(error instanceof SharedLedgerRemoteError && error.status === 409)) return fail(error, entry.snapshot);
    try { sent = await send(build("snapshot", snapshotBase(error, entry.watermark))); }
    catch (retry) { return fail(retry, true); }
  }
  const fingerprints = Object.fromEntries(current.map((t) => [t.sourceTaskId, fingerprint(t)]));
  return { entry: { ...entry, watermark: seq, snapshot: false, fingerprints: { ...entry.fingerprints, ...fingerprints },
    lastPushAt: deps.now, lastPushSeq: seq, lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0 },
  outcome: { kind: "pushed", mode: sent.mode, seq, tasks: sent.tasks.length, events: sent.events.length } };
}
