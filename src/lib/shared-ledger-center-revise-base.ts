/** N7X3 center side of a replica revise, without the journal (the store injects it, so neither imports the other):
 * fixed texts, the bound-node rule, and rebasing a journaled intent onto a fresh center read (PM 定 2: never the replica cache).
 */
import type { DagNode } from "./ledger-feature.js";
import { LedgerError } from "./ledger-store.js";
import { instanceKeySync } from "./instance-key.js";
import { SharedLedgerClient } from "./shared-ledger-client.js";
import type { SharedLedgerFeatureDetail } from "./shared-ledger-contract.js";
import {
  FEATURE_PROPOSAL_SCHEMA_VERSION, parseFeatureProposal, proposalDigest, type FeatureProposal, type FeatureProposalRevise,
} from "./shared-ledger-contract-v2-feature-proposals.js";
import { centerReplicaBaseDigest } from "./shared-ledger-center-replica.js";
import type { CenterNode } from "./shared-ledger-center-replica-write.js";
import type { PendingProposal, ProposalDraft, ProposalRuntime, ProposalVia } from "./shared-ledger-feature-proposals-store.js";
import { resolveMirrorCredential } from "./shared-ledger-mirror.js";

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
  invalid: "修订内容不符合团队项目契约（节点 / 字段 / 大小），未提交",
  scope: "中心副本：带 scopeChange 的改图本机先拒（范围变更走中心 owner），未发请求",
  bound: "中心副本：已绑卡的节点不能在修订里改动、删除或取消，本机先拒，未发请求",
  notHome: "中心副本的主场已不是本实例，未提交",
});

/** The store's journal primitives, injected by the store. */
export interface ReviseJournal {
  mutate<T>(dir: string, fn: (ops: Record<string, PendingProposal>) => T): Promise<T>;
  contentKeyOf(draft: ProposalDraft, localProjectId: string, via: ProposalVia): string;
}

const sameNode = (a: CenterNode | DagNode, b: CenterNode) => a.oneLine === b.oneLine && a.estimate === b.estimate
  && JSON.stringify([...a.deps].sort()) === JSON.stringify([...b.deps].sort())
  && JSON.stringify([...(a.fileGlobs ?? [])].sort()) === JSON.stringify([...b.fileGlobs].sort());

/** Bound nodes stay exactly as they are (sent verbatim); any change / removal / cancel is refused. */
export function keepBound(nodes: CenterNode[], current: ReadonlyMap<string, CenterNode | DagNode>, bound: Iterable<string>, cancel: ReadonlyMap<string, string>): CenterNode[] {
  const out = [...nodes];
  for (const key of bound) {
    const i = out.findIndex((n) => n.key === key), cur = current.get(key);
    if (cancel.has(key) || i < 0 || !cur || !sameNode(cur, out[i]!)) throw new LedgerError("forbidden", `${REVISE_TEXT.bound}（${key}）`);
    out[i] = { key: cur.key, oneLine: cur.oneLine, deps: [...cur.deps], fileGlobs: [...(cur.fileGlobs ?? [])], estimate: cur.estimate };
  }
  return out;
}

export const REVISE_TERMINAL: readonly string[] = ["published", "rejected", "expired", "conflict"];
/** Base the center has now, from its detail; throws (fixed texts) when the center no longer allows this revision. */
function baseOn(detail: SharedLedgerFeatureDetail, instanceId: string, p: FeatureProposalRevise, cancel: string[], expiresAt: number, now: number): ProposalDraft {
  if (detail.feature.homeInstanceId !== instanceId) throw new LedgerError("forbidden", REVISE_TEXT.notHome);
  const centerNodes = new Map(detail.dag.nodes.map((n) => [n.key, n] as const));
  const nodes = keepBound(p.nodes, centerNodes, detail.dag.bindings.map((b) => b.nodeKey), new Map(cancel.map((k) => [k, ""])));
  const draft: ProposalDraft = {
    schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, centerId: p.centerId, teamId: p.teamId, projectId: p.projectId, kind: "revise",
    featureId: detail.feature.id, baseVersion: detail.dag.version, expectedRev: detail.feature.rev, baseDigest: centerReplicaBaseDigest(detail),
    title: detail.feature.title, description: detail.feature.description, ownerWords: p.ownerWords, nodes, homeInstanceId: detail.feature.homeInstanceId,
  };
  try { parseFeatureProposal({ ...draft, operationId: "op-check", expiresAt }, now); }
  catch { throw new LedgerError("invalid", REVISE_TEXT.invalid); }
  return draft;
}

/** Turns a journaled intent into the real kind=revise proposal from a fresh center read (service credential, as the replica
 * sync reads): in place (same operationId), or the record that already holds that content (the intent is dropped).
 * Center unreachable / no credential → the intent stays, with its issue. A refusal drops the intent (nothing was sent).
 * Called (as the store's rebaseProposal) by dag-rewrite and by syncOnce on resume, so a cached base is never used. */
export async function rebaseRevise(r: ProposalRuntime, intent: PendingProposal, journal: ReviseJournal): Promise<{ record: PendingProposal; refusal?: LedgerError }> {
  const { mutate, contentKeyOf } = journal;
  if (!intent.rebase || REVISE_TERMINAL.includes(intent.state)) return { record: intent };
  const p = intent.proposal as FeatureProposalRevise, id = intent.operationId;
  const mark = async (issue: PendingProposal["issue"]) => ({ record: await mutate(r.stateDir, (ops) => (ops[id] ? (ops[id] = { ...ops[id]!, issue, updatedAt: r.now() }) : intent)) });
  const credential = resolveMirrorCredential({ centerId: p.centerId, teamId: p.teamId, projectId: p.projectId }, r.stateDir);
  const key = (r.key ?? (() => instanceKeySync(r.stateDir)))();
  if (!credential || !key) return mark("no_credential");
  let detail: SharedLedgerFeatureDetail;
  try { detail = await new SharedLedgerClient(credential, key, { timeoutMs: 5000, ...(r.fetch ? { fetch: r.fetch } : {}) }).feature(p.featureId); }
  catch { return mark("unavailable"); }
  let draft: ProposalDraft;
  try { draft = baseOn(detail, credential.instanceId, p, intent.rebase.cancel, intent.expiresAt, r.now()); }
  catch (e) {
    await mutate(r.stateDir, (ops) => { if (ops[id]?.rebase) delete ops[id]; });
    return { record: { ...intent, state: "conflict", issue: null }, refusal: e instanceof LedgerError ? e : new LedgerError("invalid", REVISE_TEXT.invalid) };
  }
  return { record: await mutate(r.stateDir, (ops) => {
    const cur = ops[id], now = r.now();
    if (!cur?.rebase) return cur ?? intent; // rebased (or dropped) by a concurrent caller
    const contentKey = contentKeyOf(draft, cur.localProjectId, cur.via);
    // Same reuse rule as stageProposal: equal content (base included) keeps its operation.
    const same = Object.values(ops).find((x) => x.contentKey === contentKey && (x.state !== "unsynced" || x.attempts > 0 || x.expiresAt > now));
    if (same) { delete ops[id]; return same; }
    const proposal = { ...draft, operationId: id, expiresAt: cur.expiresAt } as FeatureProposal;
    const { rebase: _, ...rest } = cur;
    return (ops[id] = { ...rest, contentKey, proposal, proposalDigest: proposalDigest(proposal), issue: null, updatedAt: now });
  }) };
}
