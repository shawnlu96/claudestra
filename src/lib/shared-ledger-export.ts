import type { Database } from "bun:sqlite";
import { canonicalJson } from "./ask-bind.js";
import { getFeature, getDagVersion, getPendingProposal, effectiveNodes } from "./ledger-feature.js";
import { listTasks, listDeps, listEvents } from "./ledger-store.js";
import { listSteps } from "./ledger-steps.js";
import type { SharedLedgerImport, SharedLedgerImportManifest, SharedLedgerTaskProjection } from "./shared-ledger-contract.js";
import { parseSharedLedgerImport, sharedLedgerManifestDigest } from "./shared-ledger-contract-transfer.js";
import { scrubSharedLedger, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";
import type { SharedLedgerClient } from "./shared-ledger-client.js";

export interface SharedLedgerExportOptions {
  localProject: string; projectId: string; sourceInstanceId: string; featureIds: readonly string[]; batchId: string;
  stateDir: string; scrub: SharedLedgerScrubContext;
  /** Reviewed summaries and member codes only; never read spec paths or infer a person's identity from nicknames. */
  summaries: Readonly<Record<string, { summary: string; digest: string | null }>>;
  assigneeCodes?: Readonly<Record<string, string>>;
}
function taskProjection(db: Database, task: ReturnType<typeof listTasks>[number], seq: number, options: SharedLedgerExportOptions): SharedLedgerTaskProjection {
  const summary = options.summaries[task.id] ?? { summary: "", digest: null };
  const events = listEvents(db, { project: options.localProject }).filter((e) => e.target === task.id);
  const sourceSeq = events.at(-1)?.seq ?? 0;
  const asks = db.prepare("SELECT kind, state, blocking FROM asks WHERE taskId = ? AND source NOT IN ('auq','permission','codex') ORDER BY id")
    .all(task.id) as { kind: string; state: string; blocking: number | null }[];
  const deps = listDeps(db, options.localProject).filter((d) => d.to === task.id).map((d) => d.from).sort();
  const pr = task.pr && /^\d+$/.test(task.pr) ? Number(task.pr) : null;
  return { sourceTaskId: task.id, sourceRev: task.rev, sourceSeq, stage: task.stage,
    assigneeCode: task.assignee ? options.assigneeCodes?.[task.assignee] ?? null : null,
    executorInstanceId: options.sourceInstanceId, pr, head: task.headSHA, deps,
    specSummary: summary.summary, specDigest: summary.digest, fullText: "home_only",
    steps: listSteps(db, task.id).filter((s) => !s.derived).map((s) => ({ sourceStepId: `${s.step}:${s.round}`,
      sourceRev: s.rev, sourceSeq: seq, state: s.state })),
    asks: asks.map((a) => ({ kind: a.kind, state: a.state, blocking: a.blocking === 1 })) };
}
/** One read transaction fixes the watermark and every DAG/binding/task read; no migration or old ledger writes. */
export function previewSharedLedgerExport(db: Database, options: SharedLedgerExportOptions): { payload: SharedLedgerImport; preview: string } {
  const manifest = db.transaction((): SharedLedgerImportManifest => {
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
    const tasks = listTasks(db, options.localProject);
    const features = [...options.featureIds].sort().map((featureId) => {
      const feature = getFeature(db, featureId);
      if (!feature || feature.project !== options.localProject) throw new Error("export feature unavailable");
      if (getPendingProposal(db, featureId)) throw new Error("export blocked: pending proposal");
      const mode = readSharedLedgerMode(featureId, options.stateDir);
      if (mode.authorityMode === "execution") throw new Error("execution not shared in V1");
      if (mode.authorityMode === "planning" && !mode.sharedPlanning) throw new Error("planning export requires persistent write gate");
      const versions = Array.from({ length: feature.currentVersion }, (_, index) => {
        const dag = getDagVersion(db, featureId, index + 1);
        if (!dag) throw new Error("export blocked: missing DAG version");
        const nodes = effectiveNodes(db, dag);
        return { version: dag.version, reason: dag.reasonText,
          nodes: nodes.map((n) => ({ key: n.key, oneLine: n.oneLine, deps: n.deps, fileGlobs: n.fileGlobs ?? [], estimate: n.estimate })),
          bindings: nodes.filter((n) => n.taskId).map((n) => ({ nodeKey: n.key, taskId: n.taskId! })) };
      });
      const boundIds = new Set(versions.flatMap((v) => v.bindings.map((b) => b.taskId)));
      const own = tasks.filter((t) => t.featureId === featureId || boundIds.has(t.id)).sort((a, b) => a.id.localeCompare(b.id));
      // Observation time comes from the captured source state, so repeated previews have the same digest.
      const observedAt = Math.max(feature.updatedAt, ...own.map((t) => t.updatedAt));
      return { sourceFeatureId: featureId, title: feature.title, description: feature.ownerWords, rev: feature.rev,
        authorityMode: mode.authorityMode, pendingProposal: false as const, versions,
        projection: { mode: "snapshot" as const, previousSourceSeq: 0, sourceSeq: seq, observedAt,
          tasks: own.map((t) => taskProjection(db, t, seq, options)),
          events: listEvents(db, { project: options.localProject }).filter((e) => own.some((t) => t.id === e.target))
            .map((e) => ({ sourceSeq: e.seq, sourceTaskId: e.target, type: e.kind, at: e.ts, summary: e.kind })) } };
    });
    return { projectId: options.projectId, sourceInstanceId: options.sourceInstanceId, sourceSeq: seq, features };
  }).deferred();
  const payload = scrubSharedLedger({ mode: "dry-run", batchId: options.batchId,
    manifestDigest: sharedLedgerManifestDigest(manifest), manifest }, parseSharedLedgerImport, options.scrub);
  return { payload, preview: canonicalJson(payload.manifest) };
}
export async function dryRunSharedLedgerExport(client: SharedLedgerClient, payload: SharedLedgerImport) {
  return client.import({ ...payload, mode: "dry-run" });
}
/** Approval binds to the reviewed digest; changing the manifest requires a new preview. */
export async function migrateSharedLedgerExport(client: SharedLedgerClient, payload: SharedLedgerImport, approvedDigest: string, stateDir: string) {
  if (approvedDigest !== payload.manifestDigest) throw new Error("export preview approval mismatch");
  for (const feature of payload.manifest.features) {
    if (!readSharedLedgerMode(feature.sourceFeatureId, stateDir).sharedPlanning) throw new Error("migration requires persistent planning gate");
  }
  return client.import({ ...payload, mode: "commit" });
}
