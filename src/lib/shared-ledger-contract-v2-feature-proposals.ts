/** Public N7 feature-proposal wire contract (schemaVersion 1). Parsers validate JSON only; they never authenticate.
 * Proposer and approver identity (person / service, instance) come from the center's signed credential and are never
 * accepted in a body. Default policy: only a project owner person approves. The V2 dag.propose/decide and
 * V2_COMMAND_POLICY stay untouched; this contract is the separate approval path for "new feature" and "revise DAG".
 */
import {
  SHARED_LEDGER_CAPABILITIES, SHARED_LEDGER_ERROR_STATUS, SharedLedgerError, type SharedLedgerDag, type SharedLedgerErrorCode,
  type SharedLedgerFeature,
} from "./shared-ledger-contract.js";
import { parseSharedLedgerResponse } from "./shared-ledger-contract-responses.js";
import { dagSchema, validateDag } from "./shared-ledger-contract-validation.js";
import { parseDag, parseNode } from "./shared-ledger-contract-v2-dag.js";
import { v2ObjectDigest } from "./shared-ledger-contract-v2-integrity.js";
import {
  array, bounded, choice, digest, fail, id, integer, literal, nullable, object, optional, positive, refine,
  text, timestamp, union, type Infer, type Schema,
} from "./shared-ledger-contract-v2-validation.js";

export const FEATURE_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const FEATURE_PROPOSAL_LIMITS = Object.freeze({
  maxBodyBytes: 262_144, maxNodes: 200, maxFileGlobsPerNode: 100, maxTtlMs: 7 * 24 * 3_600_000,
  title: 300, description: 16_000, ownerWords: 16_000, reason: 2_000,
});
const L = FEATURE_PROPOSAL_LIMITS;
const schemaVersion = literal(FEATURE_PROPOSAL_SCHEMA_VERSION);
const scopeFields = { schemaVersion, centerId: id, teamId: id, projectId: id };
const node = refine(parseNode, n => n.fileGlobs.length <= L.maxFileGlobsPerNode);
const contentFields = {
  ...scopeFields, operationId: id, title: text(L.title, 1), description: text(L.description),
  ownerWords: nullable(text(L.ownerWords)), nodes: array(node, L.maxNodes), homeInstanceId: id, expiresAt: timestamp,
};
const newShape = object({ ...contentFields, kind: literal("new") });
const reviseShape = object({
  ...contentFields, kind: literal("revise"), featureId: id, baseVersion: positive, expectedRev: positive, baseDigest: digest,
});
/** Version the approved DAG would carry: a new feature publishes version 1, a revision publishes baseVersion + 1. */
export function proposedVersion(p: { kind: "new" } | { kind: "revise"; baseVersion: number }): number {
  return p.kind === "new" ? 1 : p.baseVersion + 1;
}
/** Shape only (no clock). kind decides which fields exist; a new proposal carrying revise fields is an unknown field. */
const proposalShape = bounded(refine(union(newShape, reviseShape), p => {
  parseDag({ version: proposedVersion(p), nodes: p.nodes, bindings: [] });
  return true;
}), L.maxBodyBytes);
export type FeatureProposal = Infer<typeof proposalShape>;
export type FeatureProposalNew = Extract<FeatureProposal, { kind: "new" }>;
export type FeatureProposalRevise = Extract<FeatureProposal, { kind: "revise" }>;
/** Wire entry point: expiresAt must lie in (now, now + maxTtlMs]. */
export function parseFeatureProposal(value: unknown, now: number): FeatureProposal {
  timestamp(now);
  const p = proposalShape(value);
  return p.expiresAt > now && p.expiresAt - now <= L.maxTtlMs ? p : fail();
}
/** Canonical v2ObjectDigest over every parsed body field; key order never matters, any content change alters it.
 * Re-parses the shape (not the clock) so an unvalidated or identity-carrying object cannot be digested.
 */
export function proposalDigest(value: unknown): string {
  return v2ObjectDigest(proposalShape(value));
}

/** Planning fields only (allow-list): progress / projection fields and any field added later stay out of the digest. */
export const FEATURE_BASE_DIGEST_FIELDS = Object.freeze([
  "id", "projectId", "title", "description", "rev", "version", "authorityMode", "homeInstanceId",
] as const);
/** V1 parser errors become invalid_field; anything else propagates. */
function v1<T>(parse: Schema<T>): Schema<T> {
  return value => {
    try { return parse(value); } catch (e) { if (e instanceof SharedLedgerError) return fail(); throw e; }
  };
}
/** Reuses the V1 feature-list parser (the single-feature parser is not exported). */
const baseFeature = v1<SharedLedgerFeature>(value => parseSharedLedgerResponse("features", {
  schemaVersion: 1, teamId: "feature-base-digest", serverSeq: 0, capabilities: SHARED_LEDGER_CAPABILITIES, features: [value],
}).features[0]!);
/** V1 SharedLedgerDag domain (same checks as the feature-detail parser), not the stricter V2 proposal DAG parser. */
const baseDag = v1<SharedLedgerDag>(value => {
  const dag = dagSchema(value);
  validateDag(dag);
  return dag;
});
const baseDetail = object({ feature: baseFeature, dag: baseDag });
/** Revision base shared by center and clients: planning fields of the feature plus the whole dag (bindings included).
 * Progress pushes (executors, status, counts, projection, updatedBy/updatedAt) never move it. Invalid input throws.
 */
export function featureBaseDigest(detail: { feature: SharedLedgerFeature; dag: SharedLedgerDag }): string {
  const { feature, dag } = baseDetail(detail);
  return v2ObjectDigest({ feature: Object.fromEntries(FEATURE_BASE_DIGEST_FIELDS.map(k => [k, feature[k]])), dag });
}

const decisionShape = object({
  schemaVersion, proposalId: id, decision: choice(["approve", "reject"]), proposalDigest: digest, proposalRev: positive,
  homeInstanceId: optional(id), reason: text(L.reason),
});
/** A rewrite of homeInstanceId exists only on approval; rejection carries a non-empty reason. */
export const parseProposalDecision = bounded(refine(decisionShape, d => d.decision === "approve"
  ? true : d.homeInstanceId === undefined && d.reason.length > 0), L.maxBodyBytes);
export type ProposalDecision = Infer<typeof parseProposalDecision>;
/** Digest the publish step binds: the proposal digest plus the effective home (decision rewrite wins). */
export function proposalApprovalDigest(proposal: unknown, decision: unknown): string {
  const p = proposalShape(proposal), d = parseProposalDecision(decision), pd = v2ObjectDigest(p);
  if (d.decision !== "approve" || d.proposalDigest !== pd) fail();
  return v2ObjectDigest({
    schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, proposalId: d.proposalId, proposalRev: d.proposalRev, proposalDigest: pd,
    homeInstanceId: d.homeInstanceId ?? p.homeInstanceId,
  });
}

export const PROPOSAL_APPROVERS = ["project_owner", "member_self_publish"] as const;
/** Relaxation is recorded with the owner who signed it; the center verifies that person is a project owner. */
export const parseProposalPolicy = refine(object({
  ...scopeFields, approvers: choice(PROPOSAL_APPROVERS), setBy: nullable(id), rev: integer, updatedAt: timestamp,
}), p => p.approvers === "project_owner" ? (p.setBy === null) === (p.rev === 0) : p.setBy !== null && p.rev > 0);
export type ProposalPolicy = Infer<typeof parseProposalPolicy>;
/** Absent policy row = this default (rev 0, nobody set it). */
export function defaultProposalPolicy(scope: { centerId: string; teamId: string; projectId: string }): ProposalPolicy {
  return parseProposalPolicy({ schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, ...scope, approvers: "project_owner", setBy: null, rev: 0, updatedAt: 0 });
}

export const PROPOSAL_OPERATION_STATES = ["pending_approval", "approved", "published", "rejected", "expired", "conflict"] as const;
export const parseProposalOperation = refine(object({
  ...scopeFields, operationId: id, proposalDigest: digest, state: choice(PROPOSAL_OPERATION_STATES),
  proposalId: nullable(id), featureId: nullable(id), version: nullable(positive), updatedAt: timestamp,
}), o => o.state === "conflict" || (o.proposalId !== null
  && (o.state === "published" ? o.featureId !== null && o.version !== null : o.version === null)));
export type ProposalOperation = Infer<typeof parseProposalOperation>;
/** Idempotency rule: same operationId + same digest replays, a different digest is a conflict. */
export function classifyProposalOperation(existing: unknown, incomingDigest: string): "new" | "replay" | "conflict" {
  digest(incomingDigest);
  if (existing === null) return "new";
  return parseProposalOperation(existing).proposalDigest === incomingDigest ? "replay" : "conflict";
}

/** Stage one (N7CB): binds an approved node to the task already open on the home instance. */
export const parseFeatureHomeBind = bounded(object({
  schemaVersion, featureId: id, expectedRev: positive, version: positive, nodeKey: id, sourceTaskId: id, operationId: id,
}), L.maxBodyBytes);
export type FeatureHomeBind = Infer<typeof parseFeatureHomeBind>;

/** V1 status table, fixed reason text; reasons never echo input. */
export const FEATURE_PROPOSAL_ERROR_REASONS: Readonly<Record<SharedLedgerErrorCode, string>> = Object.freeze({
  conflict: "提案与当前版本或同一操作的已有摘要冲突",
  execution_not_shared: "该操作不在共享范围内",
  pending_proposal: "已有待审批提案",
  not_member: "不是项目成员",
  forbidden: "无权提案或审批",
  bad_signature: "签名无效",
  replayed: "请求重放",
  expired: "提案或凭据已过期",
  payload_too_large: "请求体过大",
  invalid_field: "请求字段不合法",
});
const errorCodes = Object.keys(SHARED_LEDGER_ERROR_STATUS) as SharedLedgerErrorCode[];
const errorShape = object({ schemaVersion, code: choice(errorCodes), status: integer, reason: text(L.reason, 1) });
export type FeatureProposalError = Infer<typeof errorShape>;
export function featureProposalError(code: SharedLedgerErrorCode): FeatureProposalError {
  return { schemaVersion: FEATURE_PROPOSAL_SCHEMA_VERSION, code, status: SHARED_LEDGER_ERROR_STATUS[code], reason: FEATURE_PROPOSAL_ERROR_REASONS[code] };
}
/** HTTP status must match the V1 table and reason must be the fixed text for that code. */
export const parseFeatureProposalError: Schema<FeatureProposalError> = v => {
  const e = errorShape(v);
  return e.status === SHARED_LEDGER_ERROR_STATUS[e.code] && e.reason === FEATURE_PROPOSAL_ERROR_REASONS[e.code] ? e : fail();
};
