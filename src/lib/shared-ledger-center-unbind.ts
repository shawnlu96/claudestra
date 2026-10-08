/**
 * N7X5 `ledger center-replica unbind <本机 featureId> <节点> --reason <原因>`: revokes a center home bind that never opened
 * locally — an orphan claim (start_node's local steps rolled back after the center bind) or a node the center bound to a card
 * this instance has no claim for (N7X4 boundElsewhere). The center side is N7X5C; a center without it answers 404.
 * Order: local checks, read only (a center replica homed here, node exists and has no local card, no pending / committed
 * claim on the node) → the start_node feature lock (shared-center-start-<id>.lock: never races a claim) → a pending unbind row
 * of this node is asked by op first (committed → finish, no resend; unknown → same op and body; GET failing → refused, stays
 * pending) → otherwise read the center live (5 s): same version as the replica, the node bound → T = its center task id →
 * pending row in shared-center-unbinds.json → POST unbinds.
 * - committed: the node's orphan claims become `released` (start_node then claims it afresh under a new op), then one sync
 *   of this feature (syncCenterReplicas, single feature).
 * - Definite rejections: 404 → unsupported; 400 / 403 / 409 conflict → conflict; 409 replayed → once more (new nonce).
 *   Claims never move on a rejection. 401 / unreachable / unconfirmed keep the row pending.
 * Center bodies and exception texts never reach the output or the records file; only the fixed texts below.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "./file-lock.js";
import { instanceIdSync } from "./instance-id.js";
import { instanceKeySync, type InstanceKey } from "./instance-key.js";
import { effectiveNodes, getDagVersion, getFeature } from "./ledger-feature.js";
import { STATE_DIR } from "./paths.js";
import { SharedLedgerClient, SharedLedgerRemoteError } from "./shared-ledger-client.js";
import type { SharedLedgerFeatureDetail } from "./shared-ledger-contract.js";
import { FEATURE_PROPOSAL_LIMITS, FEATURE_PROPOSAL_SCHEMA_VERSION, type FeatureHomeUnbind } from "./shared-ledger-contract-v2-feature-proposals.js";
import { readCenterClaims, setCenterClaimState } from "./shared-ledger-center-claims.js";
import { syncCenterReplicas } from "./shared-ledger-center-replica.js";
import { readCenterReplicas } from "./shared-ledger-center-replica-state.js";
import { putCenterUnbind, readCenterUnbinds, settleCenterUnbind, type CenterUnbind } from "./shared-ledger-center-unbind-records.js";
import { FeatureProposalRejected } from "./shared-ledger-feature-proposals.js";
import { homeUnbindDigest, SharedLedgerHomeUnbindClient } from "./shared-ledger-feature-proposals-unbinds.js";
import { readSharedLedgerMode, resolveSharedLedgerCredential, type SharedLedgerLocalCredential } from "./shared-ledger-mode.js";

/** Fixed texts only. */
export const CENTER_UNBIND_TEXT = Object.freeze({
  reason: "撤销中心绑定：要带 --reason <原因>（非空，不超过 2000 字）",
  notReplica: "撤销中心绑定：这个 feature 不是本实例主场的中心副本，未撤销",
  noNode: "撤销中心绑定：本机副本没有这个节点，未撤销",
  localCard: "撤销中心绑定：本机已有卡，不撤销",
  inFlight: "撤销中心绑定：这个节点在开卡途中，用 start_node 续上，不撤销",
  records: "撤销中心绑定：本机认领或撤销记录不可读，未撤销",
  noCredential: "撤销中心绑定：本机没有可用的 service 凭据（owner:self、kind=service、project 权限、实例与本机一致），未撤销",
  busy: "撤销中心绑定：另一个 start_node / unbind 正占用这个 feature（锁不可用），未撤销；稍后重试",
  unreachable: "撤销中心绑定：中心不可达或回包与本机请求对不上（5 秒超时），未撤销；撤销记录留在本机，再跑同一命令先向中心核对",
  unconfirmed: "撤销中心绑定：上次的撤销结果不明，向中心核对失败，撤销记录保持 pending；稍后再跑同一命令",
  unauthorized: "撤销中心绑定：中心拒绝了本机凭据（签名或凭据失效），未撤销",
  notHome: "撤销中心绑定：中心记录的主场不是本实例，不能在本机撤销",
  versionChanged: "撤销中心绑定：中心版本已变，先 sync",
  notBound: "撤销中心绑定：中心这个节点没有绑定，先 sync",
  unsupported: "中心还不支持撤销绑定（404）",
  invalid: "撤销中心绑定：中心认为请求不符合契约（400），未撤销",
  forbidden: "撤销中心绑定：中心拒绝撤销（无权，或不在共享范围）（403），未撤销",
  conflict: "撤销中心绑定：中心拒绝撤销（版本或绑定已变，或这张卡已开工）（409），未撤销；先 sync 再看",
  local: "撤销中心绑定：撤销记录写入失败，未撤销",
  release: "撤销中心绑定：中心已撤销，但本机孤儿认领未能转 released；再跑同一命令补上",
  sync: "中心已撤销；随后的 center-replica sync 未完成，再跑 sync",
});

export interface CenterUnbindRuntime {
  stateDir: string; timeoutMs: number; newOperationId: () => string;
  fetch?: typeof fetch; key?: () => InstanceKey | null; instanceId?: () => string;
}
let runtime: Partial<CenterUnbindRuntime> | null = null;
/** Test injection (temporary state dir, fake center fetch); undefined goes back to live. */
export function configureCenterUnbind(rt: Partial<CenterUnbindRuntime> | undefined): void { runtime = rt ?? null; }
const rt = (): CenterUnbindRuntime => ({ stateDir: STATE_DIR, timeoutMs: 5000, newOperationId: () => `unbind-${randomUUID()}`, ...runtime });

export type UnbindOutcome = { ok: false; code: string; error: string } | ({ ok: true } & Record<string, unknown>);
const no = (code: string, error: string): UnbindOutcome => ({ ok: false, code, error });
const status = (e: unknown) => e instanceof SharedLedgerRemoteError ? e.status : null;
const replayed = (e: unknown) => e instanceof FeatureProposalRejected && e.status === 409 && e.error?.code === "replayed";
async function onceMoreIfReplayed<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (e) { if (replayed(e)) return call(); throw e; }
}
/** A failed center read (feature detail): nothing was sent, nothing recorded. */
function readRefusal(e: unknown): UnbindOutcome {
  const s = status(e);
  if (s === 401) return no("forbidden", CENTER_UNBIND_TEXT.unauthorized);
  if (s === 403) return no("forbidden", CENTER_UNBIND_TEXT.notReplica);
  return no("unavailable", CENTER_UNBIND_TEXT.unreachable);
}

function credentialFor(cp: { centerId: string; teamId: string; projectId: string }, r: CenterUnbindRuntime): SharedLedgerLocalCredential | null {
  let c: SharedLedgerLocalCredential | null;
  try { c = resolveSharedLedgerCredential("owner:self", "service", cp.centerId, cp.teamId, cp.projectId, "project", r.stateDir); } catch { return null; }
  const me = (r.instanceId ?? (() => instanceIdSync(r.stateDir)))();
  return c && c.kind === "service" && me && c.instanceId === me ? c : null;
}

/** The replica this local feature is, or null: mode says center-planned and the replica state names this local id. */
export function centerReplicaOf(localFeatureId: string, dir = rt().stateDir) {
  let cp;
  try { cp = readSharedLedgerMode(localFeatureId, dir).centerPlanned; } catch { return null; }
  if (!cp) return null;
  let entry;
  try { entry = readCenterReplicas(dir).replicas[cp.centerFeatureId]; } catch { return null; }
  return entry && entry.localFeatureId === localFeatureId ? { cp, entry } : null;
}

export async function unbindCenterNode(db: Database, localFeatureId: string, key: string, reason: string): Promise<UnbindOutcome> {
  const r = rt();
  if (reason.length === 0 || reason.length > FEATURE_PROPOSAL_LIMITS.reason) return no("invalid", CENTER_UNBIND_TEXT.reason);
  const replica = centerReplicaOf(localFeatureId, r.stateDir);
  if (!replica) return no("forbidden", CENTER_UNBIND_TEXT.notReplica);
  const credential = credentialFor(replica.cp, r);
  const instanceKey = (r.key ?? (() => instanceKeySync(r.stateDir)))();
  if (!credential || !instanceKey) return no("forbidden", CENTER_UNBIND_TEXT.noCredential);
  mkdirSync(r.stateDir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(r.stateDir, `shared-center-start-${localFeatureId}.lock`), 15_000);
  if (!lock) return no("busy", CENTER_UNBIND_TEXT.busy);
  try {
    const transport = { timeoutMs: r.timeoutMs, ...(r.fetch ? { fetch: r.fetch } : {}) };
    return await new UnbindRun(db, r, replica, localFeatureId, key, reason, credential.instanceId, new SharedLedgerClient(credential, instanceKey, transport),
      new SharedLedgerHomeUnbindClient(credential, instanceKey, transport), instanceKey).run();
  } finally { lock.release(); }
}

class UnbindRun {
  constructor(private db: Database, private r: CenterUnbindRuntime, private replica: NonNullable<ReturnType<typeof centerReplicaOf>>,
    private featureId: string, private key: string, private reason: string, private home: string, private center: SharedLedgerClient,
    private unbinds: SharedLedgerHomeUnbindClient, private instanceKey: InstanceKey) {}

  async run(): Promise<UnbindOutcome> {
    // Local, read only, under the lock.
    const f = getFeature(this.db, this.featureId);
    const v = f?.currentVersion ? getDagVersion(this.db, f.id, f.currentVersion) : null;
    const local = v ? effectiveNodes(this.db, v).find((n) => n.key === this.key) : undefined;
    if (!local) return no("not_found", CENTER_UNBIND_TEXT.noNode);
    if (local.taskId) return no("conflict", CENTER_UNBIND_TEXT.localCard);
    let rows: CenterUnbind[];
    try {
      const claims = readCenterClaims(this.r.stateDir).filter((c) => c.localFeatureId === this.featureId && c.key === this.key);
      if (claims.some((c) => c.state === "pending" || c.state === "committed")) return no("conflict", CENTER_UNBIND_TEXT.inFlight);
      rows = readCenterUnbinds(this.r.stateDir).filter((u) => u.localFeatureId === this.featureId && u.key === this.key);
    } catch { return no("forbidden", CENTER_UNBIND_TEXT.records); }
    const pending = rows.find((u) => u.state === "pending");
    if (pending) return this.resume(pending);
    // A committed unbind whose release step failed: finish it, no center request.
    const done = rows.find((u) => u.state === "committed");
    if (done && this.orphans().length) return this.finish(done);
    return this.fresh();
  }

  private orphans(): string[] {
    return readCenterClaims(this.r.stateDir).filter((c) => c.localFeatureId === this.featureId && c.key === this.key && c.state === "orphan").map((c) => c.op);
  }

  /** Lost reply: the center decides. committed → finish without resending; unknown → the same op and body; GET failing proves nothing. */
  private async resume(u: CenterUnbind): Promise<UnbindOutcome> {
    let got;
    try { got = await onceMoreIfReplayed(() => this.unbinds.status(u.body as FeatureHomeUnbind)); }
    catch { return no("unavailable", CENTER_UNBIND_TEXT.unconfirmed); }
    return got ? this.settled(u) : this.post(u);
  }

  private async fresh(): Promise<UnbindOutcome> {
    let d: SharedLedgerFeatureDetail;
    try { d = await this.center.feature(this.replica.cp.centerFeatureId); } catch (e) { return readRefusal(e); }
    if (d.feature.authorityMode !== "planning" || d.feature.projectId !== this.replica.cp.projectId) return no("forbidden", CENTER_UNBIND_TEXT.notReplica);
    if (d.feature.homeInstanceId !== this.home) return no("forbidden", CENTER_UNBIND_TEXT.notHome);
    if (d.dag.version !== this.replica.entry.version) return no("conflict", CENTER_UNBIND_TEXT.versionChanged);
    const bound = d.dag.bindings.find((b) => b.nodeKey === this.key);
    if (!bound) return no("conflict", CENTER_UNBIND_TEXT.notBound);
    const body: FeatureHomeUnbind = { schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, featureId: this.replica.cp.centerFeatureId, expectedRev: d.feature.rev,
      version: d.dag.version, nodeKey: this.key, taskId: bound.taskId, operationId: this.r.newOperationId(), reason: this.reason };
    let u: CenterUnbind;
    try {
      u = await putCenterUnbind({ op: body.operationId, body: { ...body }, digest: homeUnbindDigest(body), localFeatureId: this.featureId, key: this.key,
        taskId: bound.taskId, state: "pending" }, this.r.stateDir);
    } catch { return no("forbidden", CENTER_UNBIND_TEXT.local); }
    return this.post(u);
  }

  private async post(u: CenterUnbind): Promise<UnbindOutcome> {
    try { await onceMoreIfReplayed(() => this.unbinds.unbind(u.body as FeatureHomeUnbind)); }
    catch (e) {
      const s = status(e);
      // Unreachable / unconfirmed / credential refused: the row stays pending, the next run asks the center by op.
      if (s === null || s === 401) return no(s === 401 ? "forbidden" : "unavailable", s === 401 ? CENTER_UNBIND_TEXT.unauthorized : CENTER_UNBIND_TEXT.unreachable);
      const out = s === 404 || s === 0 ? no("unsupported", CENTER_UNBIND_TEXT.unsupported)
        : s === 403 ? no("forbidden", CENTER_UNBIND_TEXT.forbidden)
        : s === 409 ? no("conflict", CENTER_UNBIND_TEXT.conflict)
        : no("invalid", CENTER_UNBIND_TEXT.invalid);
      try { await settleCenterUnbind(u.op, out.ok === false && out.code === "unsupported" ? "unsupported" : "conflict", this.r.stateDir); } catch { /* the refusal stands */ }
      return out;
    }
    return this.settled(u);
  }

  private async settled(u: CenterUnbind): Promise<UnbindOutcome> {
    let row: CenterUnbind;
    try { row = await settleCenterUnbind(u.op, "committed", this.r.stateDir); } catch { return no("forbidden", CENTER_UNBIND_TEXT.local); }
    return this.finish(row);
  }

  /** The center bind is gone: release this node's orphan claims, then re-sync this feature. */
  private async finish(u: CenterUnbind): Promise<UnbindOutcome> {
    const released: string[] = [];
    try {
      for (const op of this.orphans()) { await setCenterClaimState(op, "released", this.r.stateDir); released.push(op); }
    } catch { return no("forbidden", CENTER_UNBIND_TEXT.release); }
    const { cp, entry } = this.replica;
    let sync: unknown;
    try {
      sync = await syncCenterReplicas(this.db, { stateDir: this.r.stateDir, localProject: entry.localProject, centerFeatureId: cp.centerFeatureId,
        ...(this.r.fetch ? { fetch: this.r.fetch } : {}), key: () => this.instanceKey });
    } catch { sync = { ok: false, error: CENTER_UNBIND_TEXT.sync }; }
    return { ok: true, op: u.op, localFeatureId: this.featureId, key: this.key, taskId: u.taskId, released, sync };
  }
}
