import type { Database } from "bun:sqlite";
import { canonicalJson } from "./ask-bind.js";
import { getFeature, getDagVersion, getPendingProposal, effectiveNodes } from "./ledger-feature.js";
import { listTasks, listDeps, listEvents } from "./ledger-store.js";
import { listSteps } from "./ledger-steps.js";
import type { SharedLedgerImport, SharedLedgerImportManifest, SharedLedgerTaskProjection } from "./shared-ledger-contract.js";
import { SharedLedgerError } from "./shared-ledger-contract.js";
import { parseSharedLedgerImport, sharedLedgerManifestDigest, taskProjectionSchema } from "./shared-ledger-contract-transfer.js";
import { nodeSchema } from "./shared-ledger-contract-validation.js";
import { scrubSharedLedger, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { knownCommits } from "./peer-pr-github.js";
import { REPO_ROOT } from "./repo-root.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";
import type { SharedLedgerClient } from "./shared-ledger-client.js";

export interface SharedLedgerExportOptions {
  localProject: string; projectId: string; sourceInstanceId: string; featureIds: readonly string[]; batchId: string;
  stateDir: string; scrub: SharedLedgerScrubContext;
  /** Reviewed summaries and member codes only; never read spec paths or infer a person's identity from nicknames. */
  summaries: Readonly<Record<string, { summary: string; digest: string | null }>>;
  assigneeCodes?: Readonly<Record<string, string>>;
}
/** Fixed text: names the failing location by index only, never the rejected value. */
export class SharedLedgerExportContractError extends Error {
  constructor(readonly field: string) { super(`export does not fit the shared-ledger contract at ${field}`); }
}

type ProbeFields = { title?: string; description?: string; reason?: string };
const probeManifest = (f: ProbeFields) => ({ projectId: "probe", sourceInstanceId: "probe", sourceSeq: 0, features: [{
  sourceFeatureId: "probe", title: f.title ?? "probe", description: f.description ?? "", rev: 1, authorityMode: "source",
  pendingProposal: false, versions: [{ version: 1, nodes: [], bindings: [], reason: f.reason ?? "" }],
  projection: { mode: "snapshot", previousSourceSeq: 0, sourceSeq: 0, observedAt: 0, tasks: [], events: [] } }] }) as unknown as SharedLedgerImportManifest;
const probeNode = (f: { oneLine?: string; estimate?: string }) =>
  ({ key: "probe", oneLine: f.oneLine ?? "probe", deps: [], fileGlobs: [], estimate: f.estimate ?? "" });
/** Longest text the contract schema itself accepts, so each limit is written once (in the contract). */
function acceptedLength(accepts: (value: string) => unknown): number {
  const ok = (n: number) => { try { accepts("x".repeat(n)); return true; } catch { return false; } };
  let lo = 1, hi = 1 << 20;
  if (ok(hi)) return Number.POSITIVE_INFINITY;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ok(mid)) lo = mid; else hi = mid; }
  return lo;
}
let limits: Record<"reason" | "oneLine" | "estimate" | "title" | "description", number> | undefined;
export function sharedLedgerExportLimits() {
  return limits ??= {
    reason: acceptedLength((reason) => sharedLedgerManifestDigest(probeManifest({ reason }))),
    title: acceptedLength((title) => sharedLedgerManifestDigest(probeManifest({ title }))),
    description: acceptedLength((description) => sharedLedgerManifestDigest(probeManifest({ description }))),
    oneLine: acceptedLength((oneLine) => nodeSchema(probeNode({ oneLine }))),
    estimate: acceptedLength((estimate) => nodeSchema(probeNode({ estimate }))),
  };
}
/** Only the uploaded copy is shortened; the marker keeps the original length visible and the result within max. */
export function fitSharedLedgerText(value: string, max: number): string {
  if (value.length <= max) return value;
  const marker = `...(已截断,原文 ${value.length} 字)`;
  let head = value.slice(0, Math.max(0, max - marker.length));
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}${marker}`.slice(0, max);
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
const exportedTasks = (tasks: ReturnType<typeof listTasks>, featureId: string, boundIds: ReadonlySet<string>) =>
  tasks.filter((t) => t.featureId === featureId || boundIds.has(t.id)).sort((a, b) => a.id.localeCompare(b.id));

/** Narrow a contract rejection to the first failing node, task or feature, by index. */
function misfit(manifest: SharedLedgerImportManifest): string {
  const rejects = (check: () => unknown) => { try { check(); return false; } catch { return true; } };
  for (const [f, feature] of manifest.features.entries()) {
    const at = `$.manifest.features[${f}]`;
    for (const [v, version] of feature.versions.entries()) {
      for (const [n, node] of version.nodes.entries()) if (rejects(() => nodeSchema(node))) return `${at}.versions[${v}].nodes[${n}]`;
    }
    for (const [t, task] of feature.projection.tasks.entries()) {
      if (rejects(() => taskProjectionSchema(task))) return `${at}.projection.tasks[${t}]`;
    }
    if (rejects(() => sharedLedgerManifestDigest({ ...manifest, features: [feature] }))) return at;
  }
  return "$.manifest";
}

/** Heads of every task this selection would upload (feature tasks plus tasks bound in any DAG version). */
export function sharedLedgerExportHeads(db: Database, localProject: string, featureIds: readonly string[]): string[] {
  const tasks = listTasks(db, localProject), heads = new Set<string>();
  for (const featureId of featureIds) {
    const feature = getFeature(db, featureId);
    if (!feature || feature.project !== localProject) continue;
    const boundIds = new Set<string>();
    for (let version = 1; version <= feature.currentVersion; version++) {
      const dag = getDagVersion(db, featureId, version);
      if (dag) for (const n of effectiveNodes(db, dag)) if (n.taskId) boundIds.add(n.taskId);
    }
    for (const t of exportedTasks(tasks, featureId, boundIds)) if (t.headSHA) heads.add(t.headSHA);
  }
  return [...heads].sort();
}

/**
 * Lets a task head through the scrub only when it is a real commit in the local install repo; unknown hex stays blocked.
 * Commits live in `scrub` only, which the migration selection digest excludes.
 */
export async function sharedLedgerScrubWithCommits(base: SharedLedgerScrubContext, shas: readonly string[], repoDir = REPO_ROOT): Promise<SharedLedgerScrubContext> {
  const commits = new Set(base.commits ?? []);
  const want = [...new Set(shas)];
  for (let i = 0; i < want.length; i += 200) for (const sha of await knownCommits(repoDir, want.slice(i, i + 200))) commits.add(sha);
  return { ...base, commits };
}

/** One read transaction fixes the watermark and every DAG/binding/task read; no migration or old ledger writes. */
export function previewSharedLedgerExport(db: Database, options: SharedLedgerExportOptions): { payload: SharedLedgerImport; preview: string } {
  const limit = sharedLedgerExportLimits();
  const manifest = db.transaction((): SharedLedgerImportManifest => {
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
    const tasks = listTasks(db, options.localProject);
    const features = [...options.featureIds].sort().map((featureId) => {
      const feature = getFeature(db, featureId);
      if (!feature || feature.project !== options.localProject) throw new Error("export feature unavailable");
      if (getPendingProposal(db, featureId)) throw new Error("export blocked: pending proposal");
      const mode = readSharedLedgerMode(featureId, options.stateDir);
      if (mode.authorityMode === "execution") throw new Error("execution not shared in V1");
      if (!mode.sharedPlanning) throw new Error("preview requires persistent planning gate");
      const versions = Array.from({ length: feature.currentVersion }, (_, index) => {
        const dag = getDagVersion(db, featureId, index + 1);
        if (!dag) throw new Error("export blocked: missing DAG version");
        const nodes = effectiveNodes(db, dag);
        return { version: dag.version, reason: fitSharedLedgerText(dag.reasonText, limit.reason),
          nodes: nodes.map((n) => ({ key: n.key, oneLine: fitSharedLedgerText(n.oneLine, limit.oneLine), deps: n.deps,
            fileGlobs: n.fileGlobs ?? [], estimate: fitSharedLedgerText(n.estimate, limit.estimate) })),
          bindings: nodes.filter((n) => n.taskId).map((n) => ({ nodeKey: n.key, taskId: n.taskId! })) };
      });
      const boundIds = new Set(versions.flatMap((v) => v.bindings.map((b) => b.taskId)));
      const own = exportedTasks(tasks, featureId, boundIds);
      // Observation time comes from the captured source state, so repeated previews have the same digest.
      const observedAt = Math.max(feature.updatedAt, ...own.map((t) => t.updatedAt));
      return { sourceFeatureId: featureId, title: fitSharedLedgerText(feature.title, limit.title),
        description: fitSharedLedgerText(feature.ownerWords, limit.description), rev: feature.rev,
        authorityMode: mode.authorityMode, pendingProposal: false as const, versions,
        projection: { mode: "snapshot" as const, previousSourceSeq: 0, sourceSeq: seq, observedAt,
          tasks: own.map((t) => taskProjection(db, t, seq, options)),
          events: listEvents(db, { project: options.localProject }).filter((e) => own.some((t) => t.id === e.target))
            .map((e) => ({ sourceSeq: e.seq, sourceTaskId: e.target, type: e.kind, at: e.ts, summary: e.kind })) } };
    });
    return { projectId: options.projectId, sourceInstanceId: options.sourceInstanceId, sourceSeq: seq, features };
  }).deferred();
  let manifestDigest: string;
  try { manifestDigest = sharedLedgerManifestDigest(manifest); }
  catch (error) {
    if (error instanceof SharedLedgerError) throw new SharedLedgerExportContractError(misfit(manifest));
    throw error;
  }
  const payload = scrubSharedLedger({ mode: "dry-run", batchId: options.batchId, manifestDigest, manifest },
    parseSharedLedgerImport, options.scrub);
  return { payload, preview: canonicalJson(payload.manifest) };
}
export async function dryRunSharedLedgerExport(client: SharedLedgerClient, payload: SharedLedgerImport) {
  return client.import({ ...payload, mode: "dry-run" });
}
/** Approval binds to the reviewed digest; changing the manifest requires a new preview. */
export async function migrateSharedLedgerExport(client: SharedLedgerClient, payload: SharedLedgerImport, approvedDigest: string, db: Database, stateDir: string) {
  if (approvedDigest !== payload.manifestDigest) throw new Error("export preview approval mismatch");
  db.transaction(() => {
    for (const feature of payload.manifest.features) {
      if (!readSharedLedgerMode(feature.sourceFeatureId, stateDir).sharedPlanning) throw new Error("migration requires persistent planning gate");
      const current = getFeature(db, feature.sourceFeatureId);
      if (!current || current.currentVersion !== feature.versions.length || current.rev !== feature.rev) {
        throw new Error("planning changed; preview required again");
      }
    }
  }).deferred();
  return client.import({ ...payload, mode: "commit" });
}
