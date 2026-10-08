/**
 * N7X1 center replicas (阶段一): a feature the center published from an N7 "new" proposal whose home is this instance
 * lands here as a local planning-mode copy, and only this sync job may replay later center versions onto it.
 * - Discovery: service credential (owner:self, kind=service, `project`) per bound center project → proposal list
 *   (kind=new, state=published) → V1 feature detail; only home = this credential's instance, authorityMode=planning.
 * - The snapshot is always read from the center inside this process (5 s timeout); callers cannot pass one in.
 * - Per local id the identity check and every write run under one cross-process lock (uuid-prefix collisions).
 * - Write order: mirror entry → mode {planning, centerPlanned} → ledger (replica-write.ts) → replica state. A crash
 *   leaves the gate closed (mode first) and a pusher entry that fails closed on a missing feature.
 * - Anything over the local limits is refused before any write, with a fixed reason in `center-replica status`.
 */
import type { Database } from "bun:sqlite";
import { STATE_DIR } from "./paths.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { getFeature } from "./ledger-feature.js";
import { resourceKey } from "./ledger-scheduler.js";
import { LedgerError } from "./ledger-store.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "./shared-ledger-client.js";
import { featureBaseDigest } from "./shared-ledger-contract-v2-feature-proposals.js";
import type { SharedLedgerFeatureDetail } from "./shared-ledger-contract.js";
import { SharedLedgerFeatureProposalClient } from "./shared-ledger-feature-proposals.js";
import type { MirrorEntry } from "./shared-ledger-projector.js";
import { readSharedLedgerBindings } from "./shared-ledger-gate-bindings.js";
import { resolveMirrorCredential, updateSharedLedgerMirrors } from "./shared-ledger-mirror.js";
import { readSharedLedgerMode, writeSharedLedgerMode, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";
import { checkReplicaNodes, REPLICA_ACTOR, REPLICA_ID_CLAIMED, replicaBoundNodes, writeCenterReplica, type CenterNode } from "./shared-ledger-center-replica-write.js";
import { readCenterClaims } from "./shared-ledger-center-claims.js";
import { readCenterReplicas, scopeKey, updateCenterReplicas, withCenterReplicaLock, type ReplicaScope } from "./shared-ledger-center-replica-state.js";

const CENTER_TIMEOUT_MS = 5000;
/** Fixed texts only: center bodies and exception messages never reach state files or CLI output. */
export const REPLICA_REASONS = Object.freeze({
  noCredential: "本机没有可用的 service 凭据（owner:self、kind=service、带 project 权限）",
  noKey: "本机实例密钥不可用，无法签名读中心",
  credentialRejected: "凭据无效：中心拒绝了本机 service 凭据",
  unreachable: "中心不可达或回包无效（5 秒超时）",
  notHome: "主场不是本实例，不落副本",
  notPlanned: "不是中心规划（N7 新建发布）的 feature，不落副本",
  title: "超出本机限制：标题超过 60 字或不是单行",
  oneLine: "超出本机限制：节点一句话超过 60 字或不是单行",
  key: "超出本机限制：节点代号超过 40 位或含本机不收的字符（如冒号）",
  globs: "超出本机限制：fileGlobs 超过 50 条或含本机不认的文件范围",
  estimate: "超出本机限制：粗估超过 20 字或不是单行",
  nodes: "超出本机限制：中心 DAG 本机校验不通过",
  badId: "中心 feature id 不是 uuid，算不出本机 id",
  idTaken: "本机 id 撞名：已有别的 feature 用这个 id",
  ledger: "本机台账写入失败，副本未变",
  busy: "另一个同步正占用这个本机 id（锁不可用），未改动；稍后重跑",
});
const OWN_CONFLICTS = new Set(["本机项目里已有同名 feature", "副本所在的本机项目变了", "中心版本比本机副本旧",
  "中心新版本移出了本机已绑卡的节点", "中心同一版本的内容与本机副本不一致"]);
const BIND_MISSING = "中心没有本机已绑节点的绑定", BIND_MISMATCH = "中心绑定与本机已绑的卡不一致";
/** N7X4: the center bound nodes to cards this instance never claimed; sync cannot fix it, only revoking the center bind (N7X5). */
const boundElsewhereText = (keys: readonly string[]) =>
  `中心已把节点 ${keys.join("、")} 绑到本机没有认领记录的卡，本机不能开工；需要撤销中心绑定（N7X5）`;

/** `n7-` + the first 10 hex of the center uuid without hyphens; null when the id is not uuid-shaped. */
export function centerReplicaLocalId(centerFeatureId: string): string | null {
  const hex = centerFeatureId.replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? `n7-${hex.slice(0, 10)}` : null;
}
/** Center revision base (featureBaseDigest, same as the center); a revise proposal recomputes it from a fresh read. */
export function centerReplicaBaseDigest(detail: Pick<SharedLedgerFeatureDetail, "feature" | "dag">): string {
  return featureBaseDigest({ feature: detail.feature, dag: detail.dag });
}

const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const oneLine = (s: string, max: number, required: boolean) => s === s.trim() && (!required || s.length > 0)
  && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(s) && [...s].length <= max;
/** Local limits are stricter than the center contract (ledger-feature-write.ts vs contract-v2-dag.ts). */
function centerReplicaLimitReason(detail: Pick<SharedLedgerFeatureDetail, "feature" | "dag">): string | null {
  if (!oneLine(detail.feature.title, 60, true)) return REPLICA_REASONS.title;
  if (detail.dag.nodes.length === 0 || detail.dag.nodes.length > 200) return REPLICA_REASONS.nodes;
  for (const n of detail.dag.nodes) {
    if (!KEY.test(n.key) || n.deps.some((d) => !KEY.test(d))) return REPLICA_REASONS.key;
    if (!oneLine(n.oneLine, 60, true)) return REPLICA_REASONS.oneLine;
    if (n.fileGlobs.length > 50 || n.fileGlobs.some((g) => resourceKey(g) === null)) return REPLICA_REASONS.globs;
    if (!oneLine(n.estimate, 20, false)) return REPLICA_REASONS.estimate;
  }
  return null;
}

export interface CenterReplicaSyncOptions {
  stateDir?: string;
  /** Only bindings whose local project is this one (CLI: the PM's project). */
  localProject?: string;
  /** Only this center feature (start_node / rewrite in N7X2 / N7X3). */
  centerFeatureId?: string;
  now?: () => number;
  /** Transport for the real clients (tests: a fake center). Never a snapshot. */
  fetch?: typeof fetch;
  key?: () => InstanceKey | null;
}
export type ReplicaResult =
  | { centerFeatureId: string; result: "created" | "replayed" | "unchanged"; localFeatureId: string; version: number }
  | { centerFeatureId: string; result: "skipped" | "refused" | "failed"; reason: string; localFeatureId?: string };
interface ScopeResult extends ReplicaScope { localProject: string; error: string | null }

const errorText = (e: unknown) => e instanceof SharedLedgerRemoteError && [401, 403].includes(e.status)
  ? REPLICA_REASONS.credentialRejected : REPLICA_REASONS.unreachable;

export async function syncCenterReplicas(db: Database, opts: CenterReplicaSyncOptions = {}) {
  const dir = opts.stateDir ?? STATE_DIR, now = opts.now ?? Date.now;
  const scopes: ScopeResult[] = [], features: ReplicaResult[] = [];
  const bindings = readSharedLedgerBindings(dir).map((b) => ({ centerId: b.centerId, teamId: b.teamId, projectId: b.projectId,
    localProject: b.localProjectId ?? b.projectId })).filter((b) => !opts.localProject || b.localProject === opts.localProject);
  for (const b of bindings) {
    const scope = { centerId: b.centerId, teamId: b.teamId, projectId: b.projectId };
    const fail = async (error: string) => {
      scopes.push({ ...scope, localProject: b.localProject, error });
      await updateCenterReplicas(dir, (s) => { s.scopes[scopeKey(scope)] = { ...(s.scopes[scopeKey(scope)] ?? { syncedAt: null }), lastError: error, lastErrorAt: now() }; });
    };
    const credential = resolveMirrorCredential(scope, dir);
    if (!credential) { await fail(REPLICA_REASONS.noCredential); continue; }
    const key = (opts.key ?? (() => instanceKeySync(dir)))();
    if (!key) { await fail(REPLICA_REASONS.noKey); continue; }
    const transport = { timeoutMs: CENTER_TIMEOUT_MS, ...(opts.fetch ? { fetch: opts.fetch } : {}) };
    let ids: string[];
    try {
      const list = await new SharedLedgerFeatureProposalClient(credential, key, transport).listProject(scope);
      ids = [...new Set(list.proposals.flatMap((r) => r.proposal.kind === "new" && r.operation.state === "published" && r.operation.featureId
        ? [r.operation.featureId] : []))].filter((id) => !opts.centerFeatureId || id === opts.centerFeatureId);
    } catch (e) { await fail(errorText(e)); continue; }
    const client = new SharedLedgerClient(credential, key, transport);
    for (const id of ids) features.push(await syncOne(db, dir, now, client, credential, { ...scope, localProject: b.localProject }, id));
    scopes.push({ ...scope, localProject: b.localProject, error: null });
    await updateCenterReplicas(dir, (s) => { s.scopes[scopeKey(scope)] = { syncedAt: now(), lastError: null, lastErrorAt: null }; });
  }
  return { ok: true, scopes, features };
}

async function syncOne(db: Database, dir: string, now: () => number, client: SharedLedgerClient, credential: SharedLedgerLocalCredential,
  scope: ReplicaScope & { localProject: string }, centerFeatureId: string): Promise<ReplicaResult> {
  const { localProject, ...where } = scope;
  const prior = readCenterReplicas(dir).replicas[centerFeatureId];
  const failed = async (reason: string, localFeatureId?: string): Promise<ReplicaResult> => {
    if (prior) await updateCenterReplicas(dir, (s) => { const e = s.replicas[centerFeatureId]; if (e) s.replicas[centerFeatureId] = { ...e, lastError: reason, lastErrorAt: now() }; });
    return { centerFeatureId, result: "failed", reason, ...(localFeatureId ? { localFeatureId } : {}) };
  };
  const refused = async (reason: string): Promise<ReplicaResult> => {
    await updateCenterReplicas(dir, (s) => { s.refused[centerFeatureId] = { ...where, reason, at: now() }; });
    return { centerFeatureId, result: "refused", reason };
  };
  let detail: SharedLedgerFeatureDetail;
  try { detail = await client.feature(centerFeatureId); }
  catch (e) { return failed(errorText(e)); }
  if (detail.feature.projectId !== scope.projectId || detail.feature.authorityMode !== "planning") return { centerFeatureId, result: "skipped", reason: REPLICA_REASONS.notPlanned };
  if (detail.feature.homeInstanceId !== credential.instanceId) return { centerFeatureId, result: "skipped", reason: REPLICA_REASONS.notHome };
  const localFeatureId = centerReplicaLocalId(centerFeatureId);
  if (!localFeatureId) return refused(REPLICA_REASONS.badId);
  const limit = centerReplicaLimitReason(detail);
  if (limit) return refused(limit);
  // Identity check through state update run under the per-id lock: a colliding center feature syncing concurrently waits,
  // then sees this replica's mode / rows and is refused.
  const landed = await withCenterReplicaLock(dir, localFeatureId, () => land(db, dir, now, credential, scope, detail, centerFeatureId, localFeatureId, failed, refused));
  return landed ?? failed(REPLICA_REASONS.busy, localFeatureId);
}

async function land(db: Database, dir: string, now: () => number, credential: SharedLedgerLocalCredential, scope: ReplicaScope & { localProject: string },
  detail: SharedLedgerFeatureDetail, centerFeatureId: string, localFeatureId: string, failed: (reason: string, localFeatureId?: string) => Promise<ReplicaResult>,
  refused: (reason: string) => Promise<ReplicaResult>): Promise<ReplicaResult> {
  const { localProject, ...where } = scope;
  let mode;
  try { mode = readSharedLedgerMode(localFeatureId, dir); } catch { return failed(REPLICA_REASONS.ledger, localFeatureId); }
  const ours = mode.centerPlanned?.centerFeatureId === centerFeatureId && mode.centerPlanned.centerId === scope.centerId
    && mode.centerPlanned.teamId === scope.teamId && mode.centerPlanned.projectId === scope.projectId;
  const existing = getFeature(db, localFeatureId);
  if ((existing || mode.centerPlanned || mode.sharedPlanning || mode.authorityMode !== "source") && !ours) return refused(REPLICA_REASONS.idTaken);
  const nodes: CenterNode[] = detail.dag.nodes;
  const write = { localFeatureId, localProject, centerFeatureId, title: detail.feature.title, version: detail.dag.version, nodes };
  if (!existing) {
    try { checkReplicaNodes(db, write); } catch { return refused(REPLICA_REASONS.nodes); }
  } else {
    for (const [k, taskId] of replicaBoundNodes(db, existing)) {
      const bound = detail.dag.bindings.find((x) => x.nodeKey === k);
      if (!bound) return failed(BIND_MISSING, localFeatureId);
      const source = detail.tasks.find((t) => t.taskId === bound.taskId)?.sourceTaskId;
      if (source !== undefined && source !== taskId) return failed(BIND_MISMATCH, localFeatureId);
    }
  }
  // Pusher entry first (inert until the mode says pushable), then the gate closes, then the ledger rows appear.
  const prior: { wrote: boolean; entry?: MirrorEntry } = { wrote: false };
  await updateSharedLedgerMirrors(dir, (m) => {
    if (m[localFeatureId]?.enabled && m[localFeatureId]!.centerFeatureId === centerFeatureId) return;
    Object.assign(prior, { wrote: true, entry: m[localFeatureId] });
    m[localFeatureId] = { enabled: true, batchId: "center-replica", ...where, centerFeatureId, sourceInstanceId: credential.instanceId, localProject,
      watermark: 0, snapshot: true, fingerprints: {}, taskMeta: {}, lastPushAt: null, lastPushSeq: null, lastError: null, lastErrorAt: null, failures: 0, nextAttemptAt: 0 };
  });
  if (!ours) {
    await writeSharedLedgerMode(localFeatureId, { authorityMode: "planning", sharedPlanning: true,
      centerPlanned: { centerId: scope.centerId, teamId: scope.teamId, projectId: scope.projectId, centerFeatureId } }, dir, db.filename);
  }
  let out;
  try { out = writeCenterReplica(db, { actor: REPLICA_ACTOR, now: now() }, write); }
  catch (e) {
    // Undo only the pusher entry this run wrote (the closed mode stays: fail closed); anything else is left as found.
    if (prior.wrote) await updateSharedLedgerMirrors(dir, (m) => {
      if (m[localFeatureId]?.centerFeatureId !== centerFeatureId) return;
      if (prior.entry) m[localFeatureId] = prior.entry; else delete m[localFeatureId];
    });
    if (e instanceof LedgerError && e.message === REPLICA_ID_CLAIMED) return refused(REPLICA_REASONS.idTaken);
    return failed(e instanceof LedgerError && OWN_CONFLICTS.has(e.message) ? e.message : REPLICA_REASONS.ledger, localFeatureId);
  }
  const elsewhere = boundElsewhere(db, dir, detail, localFeatureId), at = now();
  await updateCenterReplicas(dir, (s) => {
    delete s.refused[centerFeatureId];
    s.replicas[centerFeatureId] = { ...where, centerFeatureId, localFeatureId, localProject, version: detail.dag.version, rev: detail.feature.rev,
      baseDigest: centerReplicaBaseDigest(detail), syncedAt: at, lastError: elsewhere.length ? boundElsewhereText(elsewhere) : null,
      lastErrorAt: elsewhere.length ? at : null, boundElsewhere: elsewhere };
  });
  return { centerFeatureId, result: out.kind, localFeatureId, version: out.version };
}

/**
 * Center-bound nodes this instance cannot start: no local card on the node and no claim of this (feature, node) other than a
 * settled `conflict` (a conflict claim never bound at the center, so the center's bind is someone else's). Read only; an
 * unreadable claims file reports nothing (start_node refuses on it anyway).
 */
function boundElsewhere(db: Database, dir: string, detail: SharedLedgerFeatureDetail, localFeatureId: string): string[] {
  const f = getFeature(db, localFeatureId);
  if (!f) return [];
  let claimed: Set<string>;
  try { claimed = new Set(readCenterClaims(dir).filter((c) => c.localFeatureId === localFeatureId && c.state !== "conflict").map((c) => c.key)); }
  catch { return []; }
  const bound = replicaBoundNodes(db, f);
  return [...new Set(detail.dag.bindings.map((b) => b.nodeKey))].filter((k) => !bound.has(k) && !claimed.has(k));
}

/** `center-replica status`: replicas with their local mode and claims summary, refusals with fixed reasons, scope errors. */
export function centerReplicaStatus(dir = STATE_DIR) {
  const state = readCenterReplicas(dir), at = (t: number | null) => (t ? new Date(t).toISOString() : null);
  return {
    ok: true,
    replicas: Object.values(state.replicas).map((e) => {
      let mode: string;
      try { const m = readSharedLedgerMode(e.localFeatureId, dir); mode = m.centerPlanned?.centerFeatureId === e.centerFeatureId ? "planning" : "mismatch"; }
      catch { mode = "unverifiable"; }
      return { ...e, boundElsewhere: e.boundElsewhere ?? [], mode, syncedAt: at(e.syncedAt), lastErrorAt: at(e.lastErrorAt) };
    }),
    refused: Object.entries(state.refused).map(([centerFeatureId, r]) => ({ centerFeatureId, ...r, at: at(r.at) })),
    scopes: Object.entries(state.scopes).map(([scope, s]) => ({ scope, ...s, syncedAt: at(s.syncedAt), lastErrorAt: at(s.lastErrorAt) })),
  };
}
