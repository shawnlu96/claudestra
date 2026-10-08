/**
 * N7X3 rewrite of a center replica → kind=revise feature proposal (阶段一). manager `ledger dag-rewrite` asks this first,
 * so rewrite_dag, plan_feature on an existing feature and the CLI all land here; a non-replica gets null (old path).
 * - Never writes the local ledger: the replica only moves when the center publishes and the next replica sync replays it.
 * - Refused locally, before any request: scopeChange, and changing / removing / cancelling a bound node.
 * - featureId / baseVersion / expectedRev / baseDigest / title / home come from a fresh center read, never the replica cache;
 *   baseDigest is the shared featureBaseDigest (centerReplicaBaseDigest). Local-only node fields are dropped.
 * - Journal, resend and drift are N7B's (shared-ledger-feature-proposals-store.ts): equal content reuses the operationId,
 *   a moved base or other content gets a new one; a drifted proposal is kept and queried, never resent automatically.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { instanceKeySync } from "./instance-key.js";
import { getDagVersion, type DagNode, type Feature } from "./ledger-feature.js";
import { requireManager } from "./ledger-feature-write.js";
import { LedgerError } from "./ledger-store.js";
import { STATE_DIR } from "./paths.js";
import { SharedLedgerClient } from "./shared-ledger-client.js";
import type { SharedLedgerFeatureDetail } from "./shared-ledger-contract.js";
import { FEATURE_PROPOSAL_SCHEMA_VERSION, parseFeatureProposal } from "./shared-ledger-contract-v2-feature-proposals.js";
import { centerReplicaBaseDigest } from "./shared-ledger-center-replica.js";
import { checkReplicaNodes, replicaBoundNodes, type CenterNode } from "./shared-ledger-center-replica-write.js";
import {
  PROPOSAL_DEFAULT_TTL_MS, stageProposal, syncProposal, type PendingProposal, type ProposalDraft, type ProposalRuntime,
} from "./shared-ledger-feature-proposals-store.js";
import { resolveMirrorCredential } from "./shared-ledger-mirror.js";
import { readSharedLedgerMode } from "./shared-ledger-mode.js";

/** Fixed texts only: center bodies and exception messages never reach the caller. */
export const REVISE_TEXT = Object.freeze({
  pending_approval: "中心副本：改图已作为修订提案提交，待项目 owner 批准；本机 DAG 未改，中心发布后由副本同步重放",
  approved: "中心副本：修订提案已批准，等中心发布；本机 DAG 未改",
  published: "中心副本：修订已在中心发布；下一次副本同步重放到本机",
  drift: "修订提案与中心当前版本漂移（中心仍待审）：不自动重交；按中心新版本重新改图会换新的 operationId",
  pending_sync: "待同步，结果未确认：中心暂不可达，已留待同步记录，恢复后先查后交",
  rejected: "修订提案被拒绝，本机 DAG 未改",
  expired: "修订提案已过期，本机 DAG 未改",
  conflict: "修订提案冲突（409）：本机 DAG 未改；按中心当前版本重新改图",
  unsupported: "中心提案协议版本不受支持，未提交成功",
  no_credential: "本机没有该团队项目可用的凭据（owner:self、service、plan / project 权限、实例一致），未提交",
  forbidden: "中心拒绝了本机凭据，未提交",
  read: "中心不可达或回包无效：修订的基准要现读中心，未提交、未留记录；恢复后重调",
  invalid: "修订内容不符合团队项目契约（节点 / 字段 / 大小），未提交",
  scope: "中心副本：带 scopeChange 的改图本机先拒（范围变更走中心 owner），未发请求",
  bound: "中心副本：已绑卡的节点不能在修订里改动、删除或取消，本机先拒，未发请求",
  notHome: "中心副本的主场已不是本实例，未提交",
});

let runtime: Partial<ProposalRuntime> | null = null;
/** Test injection (temp state dir, clock, instance id, fake center fetch); undefined goes back to live. */
export function configureCenterRevise(rt: Partial<ProposalRuntime> | undefined): void { runtime = rt ?? null; }
const rt = (): ProposalRuntime => ({ stateDir: STATE_DIR, now: Date.now, newOperationId: () => `op-${randomUUID()}`, ttlMs: PROPOSAL_DEFAULT_TTL_MS, ...runtime });

export interface ReviseInput {
  rev: number; nodes: unknown; reason: string; cancel: ReadonlyMap<string, string>; scope: boolean; actor: string;
}

/** Center wire node: only the five planning fields, whatever local fields (taskId, status, …) the caller carried. */
function wireNodes(nodes: unknown): CenterNode[] {
  if (!Array.isArray(nodes)) throw new LedgerError("invalid", REVISE_TEXT.invalid);
  return nodes.map((n) => {
    const o = (n ?? {}) as Record<string, unknown>, list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    if (typeof o.key !== "string") throw new LedgerError("invalid", REVISE_TEXT.invalid);
    return { key: o.key, oneLine: typeof o.oneLine === "string" ? o.oneLine : "", deps: list(o.deps), fileGlobs: list(o.fileGlobs), estimate: typeof o.estimate === "string" ? o.estimate : "" };
  });
}
const sameNode = (a: CenterNode | DagNode, b: CenterNode) => a.oneLine === b.oneLine && a.estimate === b.estimate
  && JSON.stringify([...a.deps].sort()) === JSON.stringify([...b.deps].sort())
  && JSON.stringify([...(a.fileGlobs ?? [])].sort()) === JSON.stringify([...b.fileGlobs].sort());

/** Bound nodes stay exactly as they are (sent verbatim); any change / removal / cancel is refused. */
function keepBound(nodes: CenterNode[], current: ReadonlyMap<string, CenterNode | DagNode>, bound: Iterable<string>, cancel: ReadonlyMap<string, string>): CenterNode[] {
  const out = [...nodes];
  for (const key of bound) {
    const i = out.findIndex((n) => n.key === key), cur = current.get(key);
    if (cancel.has(key) || i < 0 || !cur || !sameNode(cur, out[i]!)) throw new LedgerError("forbidden", `${REVISE_TEXT.bound}（${key}）`);
    out[i] = { key: cur.key, oneLine: cur.oneLine, deps: [...cur.deps], fileGlobs: [...(cur.fileGlobs ?? [])], estimate: cur.estimate };
  }
  return out;
}

function outcome(r: PendingProposal) {
  const base = { operationId: r.operationId, state: r.state, proposalId: r.proposalId, kind: "revise" as const };
  const ok = (message: string) => ({ ok: true, applied: false, version: null, proposal: base, next: message, message });
  const no = (code: string, error: string) => ({ ok: false, code, error, proposal: base });
  if (r.state === "published") return ok(REVISE_TEXT.published);
  if (r.state === "rejected" || r.state === "expired" || r.state === "conflict") return no(`proposal_${r.state}`, REVISE_TEXT[r.state]);
  if (r.issue === "drift") return no("proposal_drift", REVISE_TEXT.drift);
  if (r.issue === "unsupported") return no("unsupported", REVISE_TEXT.unsupported);
  if (r.issue === "no_credential") return no("forbidden", REVISE_TEXT.no_credential);
  if (r.issue === "forbidden") return no("forbidden", REVISE_TEXT.forbidden);
  if (r.issue === null && (r.state === "pending_approval" || r.state === "approved")) return ok(REVISE_TEXT[r.state]);
  return no("pending_sync", `${REVISE_TEXT.pending_sync}（operationId ${r.operationId}）`);
}

/** manager dagRewrite hook: null = not a center replica (old path); otherwise the revise outcome. Zero local ledger writes. */
export async function reviseCenterReplica(db: Database, f: Feature, input: ReviseInput): Promise<Record<string, unknown> | null> {
  const r = rt();
  const planned = readSharedLedgerMode(f.id, r.stateDir).centerPlanned;
  if (!planned) return null;
  requireManager(db, input.actor, f.project);
  if (f.rev !== input.rev) throw new LedgerError("conflict", `feature ${f.id} 已被改过：当前 rev ${f.rev}，你带的是 ${input.rev}`, { rev: f.rev });
  // Local refusals first: nothing is sent for these.
  if (input.scope) throw new LedgerError("forbidden", REVISE_TEXT.scope);
  const cur = f.currentVersion ? getDagVersion(db, f.id, f.currentVersion) : null;
  const local = new Map((cur?.nodes ?? []).map((n) => [n.key, n] as const)), bound = replicaBoundNodes(db, f);
  let nodes = keepBound(wireNodes(input.nodes), local, bound.keys(), input.cancel);
  checkReplicaNodes(db, { localFeatureId: f.id, localProject: f.project, nodes }, bound); // the replica must be able to replay it
  // Base comes from a fresh center read (service credential, as the replica sync reads).
  const scope = { centerId: planned.centerId, teamId: planned.teamId, projectId: planned.projectId };
  const credential = resolveMirrorCredential(scope, r.stateDir), key = (r.key ?? (() => instanceKeySync(r.stateDir)))();
  if (!credential || !key) throw new LedgerError("forbidden", REVISE_TEXT.no_credential);
  let detail: SharedLedgerFeatureDetail;
  try { detail = await new SharedLedgerClient(credential, key, { timeoutMs: 5000, ...(r.fetch ? { fetch: r.fetch } : {}) }).feature(planned.centerFeatureId); }
  catch { return { ok: false, code: "unavailable", error: REVISE_TEXT.read }; }
  if (detail.feature.homeInstanceId !== credential.instanceId) throw new LedgerError("forbidden", REVISE_TEXT.notHome);
  const centerNodes = new Map(detail.dag.nodes.map((n) => [n.key, n] as const));
  nodes = keepBound(nodes, centerNodes, detail.dag.bindings.map((b) => b.nodeKey), input.cancel);
  const draft: ProposalDraft = {
    schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, ...scope, kind: "revise", featureId: detail.feature.id, baseVersion: detail.dag.version,
    expectedRev: detail.feature.rev, baseDigest: centerReplicaBaseDigest(detail), title: detail.feature.title, description: detail.feature.description,
    ownerWords: input.reason, nodes, homeInstanceId: detail.feature.homeInstanceId,
  };
  const now = r.now();
  try { parseFeatureProposal({ ...draft, operationId: "op-check", expiresAt: now + Math.min(r.ttlMs, 7 * 24 * 3_600_000) }, now); }
  catch { throw new LedgerError("invalid", REVISE_TEXT.invalid); }
  const record = await stageProposal(r, draft, f.project, "service");
  return outcome(await syncProposal(r, record.operationId));
}
