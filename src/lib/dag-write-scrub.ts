/**
 * team-project-N8B8: a source mirror pushes only its current DAG version, and the push refuses a version whose reason, node
 * text or fileGlobs trip the outbound scrub (shared-ledger-source-dag-push.ts buildSourceDagUpload). The writer never saw
 * that: the version stayed unpushable until someone wrote a newer one. The three local write points (ledger-dag-write.ts,
 * ledger-feature-write.ts, ledger-feature-split.ts) ask here before they write, with the version they are about to write.
 * Same check as the push: sharedLedgerDagVersion → sourceDagScrubView → scrubSharedLedger, untruncated then fitted, with the
 * mirror loop's scrub context (realScrub lives here now; the loop imports it). Only field paths leave this file, never text.
 * Switch = recovery key dagWriteScrub (default observe): off = no check; observe = write, the event data carries one line
 * 「这一版推不出去：<字段路径>」; on = the write is refused. A feature that is not a source mirror is never checked.
 * tests/dag-write-scrub*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { hostname, userInfo } from "node:os";
import type { DagNode, Feature } from "./ledger-feature.js";
import { getTask, LedgerError } from "./ledger-store.js";
import { STATE_DIR } from "./paths.js";
import { commitQuery, ghEnv, knownCommits } from "./peer-pr-github.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { REPO_ROOT } from "./repo-root.js";
import { parseSourceDagUpload, type SourceDagUpload } from "./shared-ledger-contract-source-dag.js";
import { fitSharedLedgerText, sharedLedgerExportLimits } from "./shared-ledger-export.js";
import { readSharedLedgerMirrors } from "./shared-ledger-mirror.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";
import { mirrorTaskHeads, type MirrorEntry } from "./shared-ledger-projector.js";
import { scrubSharedLedger, SharedLedgerScrubError, type SharedLedgerScrubContext } from "./shared-ledger-scrub.js";
import { sharedLedgerDagVersion, sourceDagScrubView } from "./shared-ledger-source-dag-push-version.js";

/** Heads already proven to be commits of the install repo; one cache for the mirror loop and the write check. */
const known = new Set<string>();
const contextOf = (heads: readonly string[]): SharedLedgerScrubContext =>
  ({ identity: { username: userInfo().username, hostname: hostname() }, commits: new Set(heads.filter((h) => known.has(h))) });

/** The mirror loop's scrub context: local identity plus the heads that are commits in the install repo. */
export async function realScrub(heads: readonly string[]): Promise<SharedLedgerScrubContext> {
  const want = heads.filter((h) => !known.has(h));
  for (let i = 0; i < want.length; i += 200) for (const sha of await knownCommits(REPO_ROOT, want.slice(i, i + 200))) known.add(sha);
  return contextOf(heads);
}

/** The same context for a write transaction, which cannot await: knownCommits' own query (commitQuery), run synchronously. */
function realScrubSync(heads: readonly string[]): SharedLedgerScrubContext {
  const want = heads.filter((h) => !known.has(h));
  for (let i = 0; i < want.length; i += 200) {
    const q = commitQuery(REPO_ROOT, want.slice(i, i + 200));
    if (!q.want.length) continue;
    const r = Bun.spawnSync(q.argv, { stdin: Buffer.from(q.stdin), stdout: "pipe", stderr: "pipe", env: ghEnv(), timeout: 10_000 });
    if (r.exitCode !== 0) continue; // Unreadable = none known: the check only gets stricter, as in knownCommits.
    for (const sha of q.parse(r.stdout.toString())) known.add(sha);
  }
  return contextOf(heads);
}

/** What a write point is about to write: the nodes exactly as they go into dag_versions.nodes. */
export interface PendingDagVersion { version: number; reasonText: string; nodes: readonly DagNode[] }
export interface DagWriteScrubDeps {
  stateDir?: string;
  /** Real: realScrubSync. */
  scrub?: (heads: readonly string[]) => SharedLedgerScrubContext;
  /** Real: recoveryPolicy (the file-backed one). */
  policy?: RecoveryPolicyPort;
}
/** Tests read the object the check scrubbed (it has to equal what buildSourceDagUpload reads back after the write). */
export const dagWriteScrubProbe: { view?: (view: unknown) => void } = {};

type Ids = Pick<MirrorEntry, "projectId" | "centerFeatureId" | "sourceInstanceId">;
/** The upload buildSourceDagUpload would build from this version once it is the current one (a new version has no bindings of its own). */
function pendingUpload(pending: PendingDagVersion, ids: Ids | undefined) {
  return { schemaVersion: 1 as const, projectId: ids?.projectId, featureId: ids?.centerFeatureId, sourceInstanceId: ids?.sourceInstanceId,
    dag: sharedLedgerDagVersion(pending, pending.nodes) };
}

const VERSION_PATH = "$.manifest.features[0].versions[0]";
/** Blocked field paths of one scrub pass, the scrub view's wrapper shortened to `dag`. */
function blockedBy(run: () => unknown): string[] {
  try { run(); return []; }
  catch (e) {
    if (!(e instanceof SharedLedgerScrubError)) throw e;
    return e.fields.map((p) => p.startsWith(VERSION_PATH) ? `dag${p.slice(VERSION_PATH.length)}` : p);
  }
}

/** Heads the push will know once this version is written: the feature's cards today plus the cards this version binds. */
function pendingHeads(db: Database, f: Pick<Feature, "id" | "project">, pending: PendingDagVersion): string[] {
  const bound = pending.nodes.flatMap((n) => { const h = n.taskId ? getTask(db, n.taskId)?.headSHA : null; return h ? [h.toLowerCase()] : []; });
  return [...new Set([...mirrorTaskHeads(db, f.id, f.project), ...bound])];
}

/**
 * Field paths the push would block in this version; [] when it would go out, or when the feature is not a source mirror
 * (authorityMode=source and mirror=true). Paths only, never the text.
 */
export function dagWriteBlocked(db: Database, f: Pick<Feature, "id" | "project">, pending: PendingDagVersion, deps: DagWriteScrubDeps = {}): string[] {
  const dir = deps.stateDir ?? STATE_DIR;
  let ids: Ids | undefined;
  try {
    const mode = readSharedLedgerMode(f.id, dir);
    if (mode.authorityMode !== "source" || mode.mirror !== true) return [];
    ids = readSharedLedgerMirrors(dir)[f.id];
  } catch { return []; } // Unverifiable authority or mirror state never uploads a DAG (pushSourceDagMirror), so nothing can be blocked.
  const scrub = (deps.scrub ?? realScrubSync)(pendingHeads(db, f, pending));
  const original = pendingUpload(pending, ids);
  dagWriteScrubProbe.view?.(sourceDagScrubView(original));
  const limit = sharedLedgerExportLimits();
  const fitted = { ...original, dag: { ...original.dag, reason: fitSharedLedgerText(original.dag.reason, limit.reason),
    nodes: original.dag.nodes.map((n) => ({ ...n, oneLine: fitSharedLedgerText(n.oneLine, limit.oneLine), estimate: fitSharedLedgerText(n.estimate, limit.estimate) })) } };
  // Without a mirror entry there are no upload ids to parse; the text passes still run.
  const parse = (v: unknown) => (ids ? parseSourceDagUpload(fitted as SourceDagUpload) : v);
  return [...new Set([...blockedBy(() => scrubSharedLedger(sourceDagScrubView(original), (v) => v, scrub)),
    ...blockedBy(() => scrubSharedLedger(sourceDagScrubView(fitted), parse, scrub))])].sort();
}

export const DAG_WRITE_SCRUB_HINT = "这一版推不出去：";
/** Marks the refusal so a caller can tell it from every other LedgerError (review-converge-followup.ts retries once on it). */
export const dagWriteRefused = (e: unknown): e is LedgerError => e instanceof LedgerError && Array.isArray(e.current?.dagWriteScrub);

/**
 * What a write point does with the check: `refuse` = on and blocked (the caller must not write), `data` = what the write
 * event's data gains (observe and blocked: one hint line; else nothing). off never reads the mode or runs git.
 */
export function checkDagWrite(db: Database, f: Pick<Feature, "id" | "project">, pending: PendingDagVersion,
  deps: DagWriteScrubDeps = {}): { refuse: LedgerError | null; data: { dagWriteScrub?: string } } {
  const mode = (deps.policy ?? recoveryPolicy)(f.project, "dagWriteScrub").mode;
  const fields = mode === "off" ? [] : dagWriteBlocked(db, f, pending, deps);
  if (!fields.length) return { refuse: null, data: {} };
  const hint = `${DAG_WRITE_SCRUB_HINT}${fields.join("、")}`;
  if (mode === "observe") return { refuse: null, data: { dagWriteScrub: hint } };
  return { refuse: new LedgerError("invalid", `${hint}（含不能外发的内容，没有写入；改掉这些字段的文字再写）`, { dagWriteScrub: fields }), data: {} };
}

/** checkDagWrite for a write that simply fails when refused; returns the event data to spread. */
export function guardDagWrite(db: Database, f: Pick<Feature, "id" | "project">, pending: PendingDagVersion, deps: DagWriteScrubDeps = {}): { dagWriteScrub?: string } {
  const r = checkDagWrite(db, f, pending, deps);
  if (r.refuse) throw r.refuse;
  return r.data;
}
