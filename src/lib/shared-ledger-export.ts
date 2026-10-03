import type { Database } from "bun:sqlite";
import { canonicalJson } from "./ask-bind.js";
import { getFeature, getDagVersion, getPendingProposal, effectiveNodes } from "./ledger-feature.js";
import { listTasks, listDeps, listEvents } from "./ledger-store.js";
import { listSteps } from "./ledger-steps.js";
import type { SharedLedgerImport, SharedLedgerImportManifest, SharedLedgerTaskProjection } from "./shared-ledger-contract.js";
import { SharedLedgerError } from "./shared-ledger-contract.js";
import { parseSharedLedgerImport, sharedLedgerManifestDigest, taskProjectionSchema } from "./shared-ledger-contract-transfer.js";
import { nodeSchema } from "./shared-ledger-contract-validation.js";
import { scrubSharedLedger, SharedLedgerScrubError, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
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

type ExportFeature = SharedLedgerImportManifest["features"][number];
type ExportVersion = ExportFeature["versions"][number];
type ProbeFields = { title?: string; description?: string; reason?: string };
const probeManifest = (f: ProbeFields) => ({ projectId: "probe", sourceInstanceId: "probe", sourceSeq: 0, features: [{
  sourceFeatureId: "probe", title: f.title ?? "probe", description: f.description ?? "", rev: 1, authorityMode: "source",
  pendingProposal: false, versions: [{ version: 1, nodes: [], bindings: [], reason: f.reason ?? "" }],
  projection: { mode: "snapshot", previousSourceSeq: 0, sourceSeq: 0, observedAt: 0, tasks: [], events: [] } }] }) as unknown as SharedLedgerImportManifest;
const probeNode = (f: { oneLine?: string; estimate?: string }) =>
  ({ key: "probe", oneLine: f.oneLine ?? "probe", deps: [], fileGlobs: [], estimate: f.estimate ?? "" });
const probeWith = (edit: (feature: ExportFeature) => unknown) => {
  const m = probeManifest({});
  return { ...m, features: [edit(m.features[0]!)] } as SharedLedgerImportManifest;
};
const probeEvents = (n: number) => Array.from({ length: n }, (_, i) => ({ sourceSeq: i, sourceTaskId: "probe", type: "probe", at: 0, summary: "" }));
/** Largest size the contract schema itself accepts, so each limit is written once (in the contract). */
function acceptedSize(accepts: (n: number) => unknown, max = 1 << 20): number {
  const ok = (n: number) => { try { accepts(n); return true; } catch { return false; } };
  let lo = 1, hi = max;
  if (ok(hi)) return Number.POSITIVE_INFINITY;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ok(mid)) lo = mid; else hi = mid; }
  return lo;
}
const acceptedLength = (accepts: (value: string) => unknown) => acceptedSize((n) => accepts("x".repeat(n)));
let limits: Record<"reason" | "oneLine" | "estimate" | "title" | "description" | "events", number> | undefined;
export function sharedLedgerExportLimits() {
  return limits ??= {
    reason: acceptedLength((reason) => sharedLedgerManifestDigest(probeManifest({ reason }))),
    title: acceptedLength((title) => sharedLedgerManifestDigest(probeManifest({ title }))),
    description: acceptedLength((description) => sharedLedgerManifestDigest(probeManifest({ description }))),
    oneLine: acceptedLength((oneLine) => nodeSchema(probeNode({ oneLine }))),
    estimate: acceptedLength((estimate) => nodeSchema(probeNode({ estimate }))),
    events: acceptedSize((n) => sharedLedgerManifestDigest(probeWith((f) => ({ ...f, projection: { ...f.projection, events: probeEvents(n) } }))), 1 << 16),
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

const goodScalars = { sourceFeatureId: "probe", title: "probe", description: "", rev: 1, authorityMode: "source", pendingProposal: false } as const;
/**
 * Narrow a contract rejection to a field path, by index. Limits are found by running the contract's own schema on reduced
 * copies of the feature (manifestSchema checks one feature at a time); only a failing DAG graph is narrowed by key/deps here.
 */
function misfit(manifest: SharedLedgerImportManifest): string {
  const rejects = (check: () => unknown) => { try { check(); return false; } catch { return true; } };
  for (const [f, feature] of manifest.features.entries()) {
    const at = `$.manifest.features[${f}]`;
    const fits = (part: ExportFeature) => !rejects(() => sharedLedgerManifestDigest({ ...manifest, features: [part] }));
    if (fits(feature)) continue;
    const bare: ExportFeature = { ...feature, versions: [], projection: { ...feature.projection, tasks: [], events: [] } };
    if (!fits(bare)) {
      const key = (Object.keys(goodScalars) as (keyof typeof goodScalars)[]).find((k) => fits({ ...bare, [k]: goodScalars[k] }));
      return key ? `${at}.${key}` : `${at}.projection`;
    }
    for (const [v, version] of feature.versions.entries()) {
      const vat = `${at}.versions[${v}]`, fitsVersion = (part: ExportVersion) => fits({ ...bare, versions: [part] });
      if (fitsVersion(version)) continue;
      for (const [n, node] of version.nodes.entries()) if (rejects(() => nodeSchema(node))) return `${vat}.nodes[${n}]`;
      if (!fitsVersion({ ...version, bindings: [] })) {
        if (fitsVersion({ ...version, bindings: [], reason: "" })) return `${vat}.reason`;
        const keys = version.nodes.map((n) => n.key);
        const dup = keys.findIndex((k, i) => keys.indexOf(k) !== i);
        if (dup >= 0) return `${vat}.nodes[${dup}].key`;
        const deps = version.nodes.findIndex((n) => n.deps.some((d) => !keys.includes(d)) || new Set(n.deps).size !== n.deps.length);
        if (deps >= 0) return `${vat}.nodes[${deps}].deps`;
        const globs = version.nodes.findIndex((n) => new Set(n.fileGlobs).size !== n.fileGlobs.length);
        return globs >= 0 ? `${vat}.nodes[${globs}].fileGlobs` : `${vat}.nodes`; // count over the cap, or a dependency cycle
      }
      const b = version.bindings.findIndex((_, i) => !fitsVersion({ ...version, bindings: version.bindings.slice(0, i + 1) }));
      return b >= 0 ? `${vat}.bindings[${b}]` : `${vat}.bindings`;
    }
    if (!fits({ ...bare, versions: feature.versions })) return `${at}.versions`;
    for (const [t, task] of feature.projection.tasks.entries()) {
      if (rejects(() => taskProjectionSchema(task))) return `${at}.projection.tasks[${t}]`;
    }
    if (!fits({ ...bare, projection: { ...bare.projection, tasks: feature.projection.tasks } })) return `${at}.projection.tasks`;
    for (const [e, event] of feature.projection.events.entries()) {
      if (!fits({ ...bare, projection: { ...bare.projection, events: [event] } })) return `${at}.projection.events[${e}]`;
    }
    if (!fits({ ...bare, projection: { ...bare.projection, events: feature.projection.events } })) return `${at}.projection.events`;
    return at;
  }
  return "$.manifest";
}

/**
 * History stays home. A past DAG version's reason never uploads its text; it becomes HISTORY_REASON. A past node's oneLine
 * uploads as is unless the outgoing gate would refuse it, in which case it becomes the current version's text for the same
 * key (or HISTORY_ONE_LINE when the key is gone). The gate itself is unchanged and still checks every uploaded value:
 * the current reason, every uploaded oneLine and all other fields still refuse the whole batch. Nothing is masked in place.
 */
export const HISTORY_REASON = "历史原因仅本机可见";
export const HISTORY_ONE_LINE = "历史节点说明仅本机可见";
/** Runs the unchanged gate on one value in a node-text position. */
function gateRefuses(value: string, scrub: SharedLedgerScrubContext, field = "oneLine"): boolean {
  try {
    scrubSharedLedger({ manifest: { features: [{ versions: [{ nodes: [{ [field]: value }] }] }] } }, (v) => v, scrub);
    return false;
  } catch (error) {
    if (error instanceof SharedLedgerScrubError) return true;
    throw error;
  }
}

// Labels only; the refusal itself is decided by shared-ledger-scrub.ts and is never re-judged here.
const pathLike = /(?<![\p{L}\p{N}._~:/-])(?:~?\/[^\s/]+|[A-Za-z]:[\\/])/u;
const addressLike = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9:]+\b/i;
function refusalKind(value: unknown, field: string, scrub: SharedLedgerScrubContext): string {
  if (field === "fileGlobs") return "path";
  if (typeof value !== "string") return "field";
  if (pathLike.test(value)) return "path";
  if (addressLike.test(value)) return "address";
  // Without the local name and the known values, does the gate still refuse? Then it is a secret pattern.
  const neutral = { identity: { username: "\u0001", hostname: "\u0002" }, commits: scrub.commits };
  if (gateRefuses(value, neutral)) return "secret";
  return gateRefuses(value, { identity: scrub.identity, commits: scrub.commits }) ? "identity" : "known-value";
}

/** Fixed text plus ids and node keys (each shown only when it passes the gate itself); never the refused value. */
export class SharedLedgerExportBlockedError extends SharedLedgerScrubError {
  constructor(fields: readonly string[], readonly locations: readonly string[]) {
    super(fields);
    this.message = `${this.message}; ${locations.join("; ")}`;
  }
}
function locateRefusal(manifest: SharedLedgerImportManifest, error: SharedLedgerScrubError, scrub: SharedLedgerScrubContext): SharedLedgerScrubError {
  const shown = (value: string, fallback: string) => gateRefuses(value, scrub, "key") ? fallback : value;
  const locations = error.fields.flatMap((path) => {
    const steps = [...path.matchAll(/\.([A-Za-z]+)|\[(\d+)\]/g)].map((m) => m[1] ?? Number(m[2]));
    const feature = steps[0] === "manifest" && steps[1] === "features" && typeof steps[2] === "number" ? manifest.features[steps[2]] : undefined;
    if (!feature) return [];
    const parts = [`feature ${shown(feature.sourceFeatureId, `#${steps[2]}`)}`];
    let value: unknown = { manifest }, field = "";
    for (const step of steps) {
      value = (value as Record<string | number, unknown> | undefined)?.[step];
      if (typeof step === "string") field = step;
    }
    if (steps[3] === "versions" && typeof steps[4] === "number") {
      const version = feature.versions[steps[4]]!;
      parts.push(`version ${version.version}${version.version === feature.versions.length ? " (current)" : ""}`);
      if (steps[5] === "nodes" && typeof steps[6] === "number") parts.push(`node ${shown(version.nodes[steps[6]]!.key, `#${steps[6]}`)}`);
    } else if (steps[3] === "projection" && steps[4] === "tasks" && typeof steps[5] === "number") {
      parts.push(`task ${shown(feature.projection.tasks[steps[5]]!.sourceTaskId, `#${steps[5]}`)}`);
    }
    const fix = field === "oneLine" || field === "reason" ? " (rewrite_dag this text, then rerun prepare)" : "";
    return [`${parts.join(" · ")} · ${field} · ${refusalKind(value, field, scrub)}${fix}`];
  });
  return locations.length ? new SharedLedgerExportBlockedError(error.fields, locations) : error;
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

/** Shortens only the upload copy of each contract-limited text field. */
function fitSharedLedgerManifest(manifest: SharedLedgerImportManifest): SharedLedgerImportManifest {
  const limit = sharedLedgerExportLimits();
  return { ...manifest, features: manifest.features.map((feature) => ({ ...feature,
    title: fitSharedLedgerText(feature.title, limit.title), description: fitSharedLedgerText(feature.description, limit.description),
    versions: feature.versions.map((version) => ({ ...version, reason: fitSharedLedgerText(version.reason, limit.reason),
      nodes: version.nodes.map((n) => ({ ...n, oneLine: fitSharedLedgerText(n.oneLine, limit.oneLine),
        estimate: fitSharedLedgerText(n.estimate, limit.estimate) })) })),
    // Events are an observation log: past the contract's count, only the newest upload.
    projection: { ...feature.projection, events: feature.projection.events.slice(-limit.events) } })) };
}

/** One read transaction fixes the watermark and every DAG/binding/task read; no migration or old ledger writes. */
export function previewSharedLedgerExport(db: Database, options: SharedLedgerExportOptions): { payload: SharedLedgerImport; preview: string } {
  const original = db.transaction((): SharedLedgerImportManifest => {
    const seq = (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
    const tasks = listTasks(db, options.localProject);
    const features = [...options.featureIds].sort().map((featureId) => {
      const feature = getFeature(db, featureId);
      if (!feature || feature.project !== options.localProject) throw new Error("export feature unavailable");
      if (getPendingProposal(db, featureId)) throw new Error("export blocked: pending proposal");
      const mode = readSharedLedgerMode(featureId, options.stateDir);
      if (mode.authorityMode === "execution") throw new Error("execution not shared in V1");
      if (!mode.sharedPlanning) throw new Error("preview requires persistent planning gate");
      const dags = Array.from({ length: feature.currentVersion }, (_, index) => {
        const dag = getDagVersion(db, featureId, index + 1);
        if (!dag) throw new Error("export blocked: missing DAG version");
        return { dag, nodes: effectiveNodes(db, dag) };
      });
      const currentText = new Map(dags.at(-1)?.nodes.map((n) => [n.key, n.oneLine]));
      const versions = dags.map(({ dag, nodes }) => {
        const past = dag.version !== feature.currentVersion;
        return { version: dag.version, reason: past ? HISTORY_REASON : dag.reasonText,
          nodes: nodes.map((n) => ({ key: n.key, deps: n.deps, fileGlobs: n.fileGlobs ?? [], estimate: n.estimate,
            oneLine: past && gateRefuses(n.oneLine, options.scrub) ? currentText.get(n.key) ?? HISTORY_ONE_LINE : n.oneLine })),
          bindings: nodes.filter((n) => n.taskId).map((n) => ({ nodeKey: n.key, taskId: n.taskId! })) };
      });
      const boundIds = new Set(versions.flatMap((v) => v.bindings.map((b) => b.taskId)));
      const own = exportedTasks(tasks, featureId, boundIds);
      // Observation time comes from the captured source state, so repeated previews have the same digest.
      const observedAt = Math.max(feature.updatedAt, ...own.map((t) => t.updatedAt));
      return { sourceFeatureId: featureId, title: feature.title,
        description: feature.ownerWords, rev: feature.rev,
        authorityMode: mode.authorityMode, pendingProposal: false as const, versions,
        projection: { mode: "snapshot" as const, previousSourceSeq: 0, sourceSeq: seq, observedAt,
          tasks: own.map((t) => taskProjection(db, t, seq, options)),
          events: listEvents(db, { project: options.localProject }).filter((e) => own.some((t) => t.id === e.target))
            .map((e) => ({ sourceSeq: e.seq, sourceTaskId: e.target, type: e.kind, at: e.ts, summary: e.kind })) } };
    });
    return { projectId: options.projectId, sourceInstanceId: options.sourceInstanceId, sourceSeq: seq, features };
  }).deferred();
  // Scrub the untruncated text first: a cut could leave a secret fragment below every detector's threshold.
  try { scrubSharedLedger({ manifest: original }, (value) => value, options.scrub); }
  catch (error) {
    if (error instanceof SharedLedgerScrubError) throw locateRefusal(original, error, options.scrub);
    throw error;
  }
  const manifest = fitSharedLedgerManifest(original);
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
