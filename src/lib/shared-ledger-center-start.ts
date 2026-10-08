/**
 * N7X2 start_node on a center replica: claim the node at the center first, open the local card only after the claim committed.
 * src/bridge/dag-tools.ts runs preflightStart through centerPreflight: the claim comes first (X1's preflight refuses a replica node
 * without a committed claim, shared-ledger-gate.ts requireSharedLedgerStart); non-replica features go straight to the original
 * preflight with zero center requests.
 * Order: local checks (incl. the card id: valid and free, read only) → feature-level file lock → read the center live (same
 * version as the replica, node unchanged, not bound; a newer center version is refused, never synced here, so a failed claim
 * leaves the ledger untouched) → pending claim (0600 shared-center-binds.json, never the ledger) → POST binds → committed →
 * the original preflight and runStart.
 * - Lost reply / unknown: the pending claim stays; the next start_node asks GET binds/{op} first, committed resumes with the
 *   claim's card id, unknown (also after a center rollback) resends the same op and body. A GET that fails (unreachable, 401,
 *   403, 404 …) proves nothing: the claim stays pending. Only a definite POST rejection settles it conflict.
 * - A committed claim whose card is not opened yet is not a local licence: every start_node asks GET binds/{op} again (committed
 *   → go on, unknown → resend the same op and body, any failure → refused, zero local steps).
 * - Resuming (pending or committed) re-reads the center's latest DAG after the receipt: a newer version or a changed node is
 *   refused with zero local writes (the claim stays committed under its op), only this claim's own bind on the node is allowed.
 * - 409 replayed: once more (new nonce). 409 conflict: GET binds/{op}, then re-read the center; node still unbound and version
 *   still the one first sent → one retry with a new op, otherwise refused. 400 / 401 / 403 / 404: fixed text, no retry.
 * - Preflight failing after the claim committed: the claim stays committed with its card id, the refusal names that card, and the
 *   next start_node reuses it once the cause is fixed; a card that got taken meanwhile can never open, so the claim is orphaned.
 * - Local steps failing after the claim (runStart rolled back) orphan the claim; that node is then always refused until the
 *   center bind is revoked (separate node), never re-claimed under another card id.
 * Center bodies and exception texts never reach the caller or the claims file; only the fixed texts below.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { laneNodes } from "./dag-tools-lanes.js";
import { acquireLock } from "./file-lock.js";
import { instanceIdSync } from "./instance-id.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { cardNames } from "./ledger-card-names.js";
import { effectiveNodes, getDagVersion, getFeature, projectNodes, type Feature } from "./ledger-feature.js";
import { getTask } from "./ledger-store.js";
import type { Preflight, StartArgs } from "./dag-tools-start.js";
import { STATE_DIR } from "./paths.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "./shared-ledger-client.js";
import type { SharedLedgerFeatureDetail } from "./shared-ledger-contract.js";
import { FEATURE_PROPOSAL_SCHEMA_VERSION, type FeatureHomeBind } from "./shared-ledger-contract-v2-feature-proposals.js";
import { readCenterClaims, putCenterClaim, setCenterClaimState, type CenterClaim } from "./shared-ledger-center-claims.js";
import { readCenterReplicas } from "./shared-ledger-center-replica-state.js";
import { FeatureProposalRejected } from "./shared-ledger-feature-proposals.js";
import { homeBindDigest, SharedLedgerHomeBindClient } from "./shared-ledger-feature-proposals-binds.js";
import { readSharedLedgerMode, resolveSharedLedgerCredential, type SharedLedgerLocalCredential, type SharedLedgerMode } from "./shared-ledger-mode.js";

type CenterPlanned = NonNullable<SharedLedgerMode["centerPlanned"]>;

/** Fixed texts only. */
export const CENTER_START_TEXT = Object.freeze({
  noCredential: "中心副本：本机没有可用的 service 凭据（owner:self、kind=service、project 权限、实例与本机一致），未向中心认领，未开工",
  claims: "中心副本：本机认领记录不可读，未开工",
  busy: "中心副本：另一个 start_node 正在认领这个 feature（锁不可用），未开工；稍后重试",
  unreachable: "中心副本：中心不可达或回包与本机请求对不上（5 秒超时），未开工；认领记录留在本机，下次 start_node 先向中心核对",
  unsupported: "中心副本：中心不支持认领绑定或不认识本机契约版本，未开工",
  forbidden: "中心副本：中心拒绝认领（无权，或不在共享范围），未开工",
  unauthorized: "中心副本：中心拒绝了本机凭据（签名或凭据失效），未开工",
  invalid: "中心副本：认领请求不符合中心契约，未开工",
  notFound: "中心副本：中心没有这个 feature 或认领接口，未开工",
  conflict: "中心副本：节点在中心已被绑定，或中心版本 / 节点已变，未开工；先 center-replica sync 再看",
  boundElsewhere: "中心副本：这个节点在中心已被绑定到本机没有认领记录的卡，sync 解决不了；需要撤销中心绑定（N7X5），未开工",
  stale: "中心副本：中心版本与本机副本对不上，未按旧版本认领，未开工",
  newer: "中心副本：中心有比本机副本新的版本，未按旧版本认领，本机台账未改，未开工；先 ledger center-replica sync 再 start_node",
  lapsed: "中心副本：本机记录已认领，但中心查不到这次绑定且原请求重交被拒，未开工；需核对中心绑定",
  cardTaken: "中心副本：卡号不合法或已被占用，未向中心认领，未开工；换一个 taskId",
  notHome: "中心副本：中心记录的主场不是本实例，不能在本机认领",
  orphan: "中心副本：这个节点的认领已成孤儿绑定（中心已绑、本机开工失败已回滚），不会换卡号重新认领；先撤销中心绑定（另开节点处理）",
  local: "中心副本：认领记录写入失败，未开工",
});

export interface CenterStartRuntime {
  stateDir: string; timeoutMs: number; newOperationId: () => string;
  fetch?: typeof fetch; key?: () => InstanceKey | null; instanceId?: () => string;
}
let runtime: Partial<CenterStartRuntime> | null = null;
/** Test injection (temporary state dir, fake center fetch); undefined goes back to live. */
export function configureCenterStart(rt: Partial<CenterStartRuntime> | undefined): void { runtime = rt ?? null; }
const rt = (): CenterStartRuntime => ({ stateDir: STATE_DIR, timeoutMs: 5000, newOperationId: () => `bind-${randomUUID()}`, ...runtime });

export type ClaimOutcome = { ok: true; taskId?: string } | { ok: false; code: string; error: string };
const no = (code: string, error: string): ClaimOutcome => ({ ok: false, code, error });
const remote = (e: unknown) => e instanceof FeatureProposalRejected || (e instanceof SharedLedgerRemoteError && e.status > 0) ? e as SharedLedgerRemoteError : null;
const code = (e: unknown) => e instanceof FeatureProposalRejected ? e.error?.code ?? null : null;
function refusal(e: unknown): ClaimOutcome {
  const r = remote(e);
  if (!r) return no(e instanceof SharedLedgerRemoteError ? "unsupported" : "unavailable", e instanceof SharedLedgerRemoteError ? CENTER_START_TEXT.unsupported : CENTER_START_TEXT.unreachable);
  if (r.status === 401) return no("forbidden", CENTER_START_TEXT.unauthorized);
  if (r.status === 403) return no("forbidden", CENTER_START_TEXT.forbidden);
  if (r.status === 404) return no("unsupported", CENTER_START_TEXT.notFound);
  if (r.status === 409) return no("conflict", CENTER_START_TEXT.conflict);
  return no("invalid", CENTER_START_TEXT.invalid);
}
/** 409 replayed: the same request once more (the transport signs a new nonce). */
async function onceMoreIfReplayed<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (e) {
    if (e instanceof FeatureProposalRejected && e.status === 409 && code(e) === "replayed") return call();
    throw e;
  }
}

function centerPlannedOf(featureId: string, dir: string): CenterPlanned | null {
  try { return readSharedLedgerMode(featureId, dir).centerPlanned ?? null; } catch { return null; } // unreadable: preflight refuses
}
function credentialFor(cp: CenterPlanned, r: CenterStartRuntime): SharedLedgerLocalCredential | null {
  let c: SharedLedgerLocalCredential | null;
  try { c = resolveSharedLedgerCredential("owner:self", "service", cp.centerId, cp.teamId, cp.projectId, "project", r.stateDir); } catch { return null; }
  const me = (r.instanceId ?? (() => instanceIdSync(r.stateDir)))();
  return c && c.kind === "service" && me && c.instanceId === me ? c : null;
}
function localNode(db: Database, featureId: string, key: string) {
  const f = getFeature(db, featureId);
  const v = f?.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  if (!f || !v) return null;
  const views = projectNodes(db, effectiveNodes(db, v)), lane = laneNodes(views).find((n) => n.key === key);
  const node = views.find((n) => n.key === key);
  return node && lane ? { f, version: v.version, node, depsMet: lane.depsMet } : null;
}
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/; // dag-tools-start.ts preflightStart's own rule
/** Read only, before any claim: the card id must be one preflight would accept as free (same rule, case-insensitive). */
function cardFree(db: Database, taskId: string): boolean {
  return TASK_ID.test(taskId) && !db.query("SELECT id FROM tasks WHERE id = ? COLLATE NOCASE").get(taskId);
}
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Committed claim whose card was rolled back (cancelled) and never bound: the local steps failed after the center bind. */
function rolledBack(db: Database, c: CenterClaim): boolean {
  const n = localNode(db, c.localFeatureId, c.key);
  return !!n && !n.node.taskId && getTask(db, c.taskId)?.stage === "cancelled";
}

/** Best effort: a failed mark is retried by the next start_node / tick, which re-detect the rolled-back card. */
async function orphan(op: string, dir: string): Promise<void> {
  try { await setCenterClaimState(op, "orphan", dir); } catch { console.warn("center claim orphan mark failed; retried on the next start_node"); }
}

export async function claimCenterNode(db: Database, f: Pick<Feature, "id">, key: string, requested?: string): Promise<ClaimOutcome> {
  const r = rt(), cp = centerPlannedOf(f.id, r.stateDir);
  if (!cp) return { ok: true };
  const here = localNode(db, f.id, key);
  if (!here) return { ok: true }; // no such node: the original preflight answers
  let mine: CenterClaim[];
  try { mine = readCenterClaims(r.stateDir).filter((c) => c.localFeatureId === f.id && c.key === key); } catch { return no("forbidden", CENTER_START_TEXT.claims); }
  if (mine.some((c) => c.state === "orphan")) return no("forbidden", CENTER_START_TEXT.orphan);
  if (here.node.taskId) return { ok: true }; // already bound: preflight answers "duplicate"
  const done = mine.find((c) => c.state === "committed");
  if (done && rolledBack(db, done)) {
    await orphan(done.op, r.stateDir);
    return no("forbidden", CENTER_START_TEXT.orphan);
  }
  if (!done) {
    if (!here.depsMet || !here.node.fileGlobs?.length) return { ok: true }; // deps / globs: the original preflight's own text, nothing claimed
    if (!mine.some((c) => c.state === "pending") && !cardFree(db, requested ?? cardNames(db, here.f, key).taskId)) return no("conflict", CENTER_START_TEXT.cardTaken);
  }
  const credential = credentialFor(cp, r);
  const instanceKey = (r.key ?? (() => instanceKeySync(r.stateDir)))();
  if (!credential || !instanceKey) return no("forbidden", CENTER_START_TEXT.noCredential);
  mkdirSync(r.stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(r.stateDir, `shared-center-start-${f.id}.lock`), 15_000);
  if (!lock) return no("busy", CENTER_START_TEXT.busy);
  try {
    const transport = { timeoutMs: r.timeoutMs, ...(r.fetch ? { fetch: r.fetch } : {}) };
    const run = new ClaimRun(db, r, cp, f.id, key, new SharedLedgerClient(credential, instanceKey, transport),
      new SharedLedgerHomeBindClient(credential, instanceKey, transport), credential.instanceId);
    return await run.claim(requested);
  } finally { lock.release(); }
}

class ClaimRun {
  constructor(private db: Database, private r: CenterStartRuntime, private cp: CenterPlanned, private featureId: string, private key: string,
    private center: SharedLedgerClient, private binds: SharedLedgerHomeBindClient, private home: string) {}

  async claim(requested?: string): Promise<ClaimOutcome> {
    // Re-read under the lock: a concurrent start_node of the same node may have settled it meanwhile.
    let mine: CenterClaim[];
    try { mine = readCenterClaims(this.r.stateDir).filter((c) => c.localFeatureId === this.featureId && c.key === this.key); }
    catch { return no("forbidden", CENTER_START_TEXT.claims); }
    if (mine.some((c) => c.state === "orphan")) return no("forbidden", CENTER_START_TEXT.orphan);
    const done = mine.find((c) => c.state === "committed");
    if (done) return this.confirm(done);
    const pending = mine.find((c) => c.state === "pending");
    return pending ? this.resume(pending) : this.fresh(requested, true);
  }

  /** Lost reply or crash: the center decides; committed resumes, unknown resends the same op and body; an unanswered GET keeps it pending. */
  private async resume(c: CenterClaim): Promise<ClaimOutcome> {
    let got;
    try { got = await onceMoreIfReplayed(() => this.binds.status(c.body as FeatureHomeBind)); } catch (e) { return refusal(e); }
    const out = got ? await this.settle(c, "committed") : await this.post(c, true);
    return out.ok ? this.latest(out) : out;
  }

  /** Committed here but the card is not opened yet: the center must still hold the bind (a rollback may have dropped it). */
  private async confirm(c: CenterClaim): Promise<ClaimOutcome> {
    let got;
    try { got = await onceMoreIfReplayed(() => this.binds.status(c.body as FeatureHomeBind)); } catch (e) { return refusal(e); }
    if (got) return this.latest({ ok: true, taskId: c.taskId });
    // unknown: same op, same body. committed cannot move back, so a definite rejection leaves it committed and asked again next time.
    try { await onceMoreIfReplayed(() => this.binds.bind(c.body as FeatureHomeBind)); } catch (e) { return remote(e) ? no("conflict", CENTER_START_TEXT.lapsed) : refusal(e); }
    return this.latest({ ok: true, taskId: c.taskId });
  }

  /**
   * A receipt only proves the op committed at the version it was sent at, not that the center is still there: before any local
   * step the center's latest DAG must match the replica and the node (its own bind allowed). Newer / changed → refused, zero
   * local writes; the claim stays committed, so after a sync the next start_node asks the same op again.
   */
  private async latest(out: ClaimOutcome): Promise<ClaimOutcome> {
    const d = await this.current(true);
    return "ok" in d ? d : out;
  }

  /** Reads the center live and checks it against the replica: same version (newer → sync first), node unchanged and unbound (own: this claim's bind is there). */
  private async current(own = false): Promise<SharedLedgerFeatureDetail | ClaimOutcome> {
    let d: SharedLedgerFeatureDetail;
    try { d = await this.center.feature(this.cp.centerFeatureId); } catch (e) { return refusal(e); }
    if (d.feature.authorityMode !== "planning" || d.feature.projectId !== this.cp.projectId) return no("forbidden", CENTER_START_TEXT.stale);
    if (d.feature.homeInstanceId !== this.home) return no("forbidden", CENTER_START_TEXT.notHome);
    const replica = this.replicaVersion();
    // Newer at the center: refused, not synced here — a sync writes the ledger and the claim after it may still fail.
    if (replica !== null && d.dag.version > replica) return no("conflict", CENTER_START_TEXT.newer);
    if (replica === null || d.dag.version !== replica) return no("conflict", CENTER_START_TEXT.stale);
    const local = localNode(this.db, this.featureId, this.key), remoteNode = d.dag.nodes.find((n) => n.key === this.key);
    if (!local || local.version !== d.dag.version || !remoteNode || local.node.taskId) return no("conflict", CENTER_START_TEXT.conflict);
    if (!same(remoteNode.deps, local.node.deps) || !same(remoteNode.fileGlobs, local.node.fileGlobs ?? [])) return no("conflict", CENTER_START_TEXT.conflict);
    // Not own: claim() only gets here without a pending / committed / orphan claim and the local node unbound, so the center's
    // bind belongs to a card this instance never claimed; a sync cannot change that (N7X4), only revoking it at the center (N7X5).
    if (!own && d.dag.bindings.some((b) => b.nodeKey === this.key)) return no("conflict", CENTER_START_TEXT.boundElsewhere);
    return d;
  }
  private replicaVersion(): number | null {
    try {
      const e = readCenterReplicas(this.r.stateDir).replicas[this.cp.centerFeatureId];
      return e && e.localFeatureId === this.featureId ? e.version : null;
    } catch { return null; }
  }

  /** sameVersion: the 409-conflict retry, allowed only while the center is still at the version first sent (only the rev moved). */
  private async fresh(requested: string | undefined, retry: boolean, sameVersion?: number): Promise<ClaimOutcome> {
    const d = await this.current();
    if ("ok" in d) return d;
    if (sameVersion !== undefined && d.dag.version !== sameVersion) return no("conflict", CENTER_START_TEXT.conflict);
    const local = localNode(this.db, this.featureId, this.key);
    const taskId = requested ?? (local ? cardNames(this.db, local.f, this.key).taskId : null);
    if (!taskId) return no("conflict", CENTER_START_TEXT.conflict);
    const body: FeatureHomeBind = { schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, featureId: this.cp.centerFeatureId, expectedRev: d.feature.rev,
      version: d.dag.version, nodeKey: this.key, sourceTaskId: taskId, operationId: this.r.newOperationId() };
    let c: CenterClaim;
    try {
      c = await putCenterClaim({ op: body.operationId, body: { ...body }, digest: homeBindDigest(body), localFeatureId: this.featureId, key: this.key,
        taskId, state: "pending" }, this.r.stateDir);
    } catch { return no("forbidden", CENTER_START_TEXT.local); }
    return this.post(c, retry);
  }

  private async post(c: CenterClaim, retry: boolean): Promise<ClaimOutcome> {
    try { await onceMoreIfReplayed(() => this.binds.bind(c.body as FeatureHomeBind)); }
    catch (e) {
      if (!(e instanceof FeatureProposalRejected && e.status === 409 && code(e) === "conflict")) return this.rejected(c, e);
      // Conflict: make sure this op did not commit, then decide on a fresh center read.
      let got;
      try { got = await onceMoreIfReplayed(() => this.binds.status(c.body as FeatureHomeBind)); } catch (e2) { return refusal(e2); } // unconfirmed: stays pending
      if (got) return this.settle(c, "committed");
      const settled = await this.settle(c, "conflict");
      return retry && settled.ok === false && settled.code === "conflict" ? this.fresh(c.taskId, false, (c.body as FeatureHomeBind).version) : settled;
    }
    return this.settle(c, "committed");
  }

  /** POST only. Unreachable / unconfirmed keeps the claim pending (the next run asks the center); a definite rejection settles it. */
  private async rejected(c: CenterClaim, e: unknown): Promise<ClaimOutcome> {
    const out = refusal(e);
    if (remote(e)) {
      try { await setCenterClaimState(c.op, "conflict", this.r.stateDir); } catch { /* the refusal text stands */ }
    }
    return out;
  }

  private async settle(c: CenterClaim, state: "committed" | "conflict"): Promise<ClaimOutcome> {
    try { await setCenterClaimState(c.op, state, this.r.stateDir); } catch { return no("forbidden", CENTER_START_TEXT.local); }
    return state === "committed" ? { ok: true, taskId: c.taskId } : no("conflict", CENTER_START_TEXT.conflict);
  }
}

/**
 * start_node's preflight on any feature (src/bridge/dag-tools.ts): a replica node is claimed first, then `run` (the original
 * preflightStart, X1's gate untouched) sees the committed claim's card id. Non-replica: `run` alone, no center request.
 */
export async function centerPreflight(db: Database, f: Pick<Feature, "id">, key: string, input: StartArgs, run: () => Promise<Preflight>): Promise<Preflight> {
  const won = await claimCenterNode(db, f, key, input.taskId);
  if (!won.ok) return won;
  if (!won.taskId) return run();
  input.taskId = won.taskId;
  const pre = await run();
  if (pre.ok) return pre;
  // The card got taken after the claim: the center binds a card this instance can never open — orphan, revoke separately.
  if (db.query("SELECT id FROM tasks WHERE id = ? COLLATE NOCASE").get(won.taskId)) {
    await centerStartFailed(f.id, key);
    return no("forbidden", CENTER_START_TEXT.orphan) as Preflight;
  }
  return { ...pre, error: `${pre.error}（中心已按卡号 ${won.taskId} 认领；处理好后再 start_node 会沿用这个卡号）` };
}

/** start_node's local steps failed after the claim (runStart rolled back): orphan the committed claim of this node, if any. */
export async function centerStartFailed(featureId: string, key: string): Promise<void> {
  const r = rt();
  if (!centerPlannedOf(featureId, r.stateDir)) return;
  try {
    for (const c of readCenterClaims(r.stateDir)) {
      if (c.localFeatureId === featureId && c.key === key && c.state === "committed") await setCenterClaimState(c.op, "orphan", r.stateDir);
    }
  } catch { /* unreadable: the next start_node refuses on the claims file anyway */ }
}

/**
 * 5-minute tick (local-api/shared-feature-proposals.ts): settles what start_node left open. A pending claim is asked by op
 * (committed → committed, otherwise left for the next start_node to resend); a committed claim whose card was rolled back
 * and never bound becomes orphan. Never posts a bind.
 */
export async function reconcileCenterClaims(db: Database | null = null): Promise<void> {
  const r = rt();
  let claims: CenterClaim[];
  try { claims = readCenterClaims(r.stateDir); } catch { return; }
  for (const c of claims) {
    if (c.state === "committed" && db && rolledBack(db, c)) { await orphan(c.op, r.stateDir); continue; }
    if (c.state !== "pending") continue;
    const cp = centerPlannedOf(c.localFeatureId, r.stateDir);
    const credential = cp ? credentialFor(cp, r) : null, instanceKey = (r.key ?? (() => instanceKeySync(r.stateDir)))();
    if (!credential || !instanceKey) continue;
    const lock = await acquireLock(join(r.stateDir, `shared-center-start-${c.localFeatureId}.lock`), 0);
    if (!lock) continue; // a start_node holds this feature: it settles the claim itself
    const client = new SharedLedgerHomeBindClient(credential, instanceKey, { timeoutMs: r.timeoutMs, ...(r.fetch ? { fetch: r.fetch } : {}) });
    try { if (await onceMoreIfReplayed(() => client.status(c.body as FeatureHomeBind))) await setCenterClaimState(c.op, "committed", r.stateDir); }
    catch { /* stays pending */ }
    finally { lock.release(); }
  }
}
