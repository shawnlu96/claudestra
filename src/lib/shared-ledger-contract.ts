/** Frozen V1 wire contract. Times are Unix milliseconds; revisions/sequences are safe integers.
 * C2 must authorize before reading snapshots, then check CAS, bindings and receipts in one transaction.
 * This module is independent of the local ledger and never grants local owner or PM privileges.
 * Parsers live in contract-validation/transfer/responses; contract-fixtures contains browser-safe wire examples.
 */
export const SHARED_LEDGER_SCHEMA_VERSION = 1 as const;
export const SHARED_LEDGER_MAX_BODY_BYTES = 1_048_576;
export const SHARED_LEDGER_MAX_IMPORT_BODY_BYTES = 8_388_608;
/** Match the entire raw path: queries, items and trailing characters retain the default cap. */
export function sharedLedgerBodyLimit(method: string, path: string): number {
  const match = /^\/v1\/teams\/[A-Za-z0-9_.:-]+\/imports$/.exec(path);
  return method === "POST" && match?.[0] === path ? SHARED_LEDGER_MAX_IMPORT_BODY_BYTES : SHARED_LEDGER_MAX_BODY_BYTES;
}
export const SHARED_LEDGER_STALE_MS = 30_000;
export const SHARED_LEDGER_COMMANDS = ["feature.new", "feature.set", "dag.init", "dag.rewrite"] as const;
export const SHARED_LEDGER_DISABLED_ACTIONS = ["task.new", "dag.bind", "stage", "approval", "scopeChange"] as const;

export const SHARED_LEDGER_ERROR_STATUS = {
  conflict: 409, execution_not_shared: 403, pending_proposal: 409, not_member: 403,
  forbidden: 403, bad_signature: 401, replayed: 409, expired: 401, payload_too_large: 413, invalid_field: 400,
} as const;
export type SharedLedgerErrorCode = keyof typeof SHARED_LEDGER_ERROR_STATUS;

export class SharedLedgerError extends Error {
  readonly status: number;
  constructor(readonly code: SharedLedgerErrorCode, message: string = code) {
    super(message);
    this.name = "SharedLedgerError";
    this.status = SHARED_LEDGER_ERROR_STATUS[code];
  }
}

export const SHARED_LEDGER_CAPABILITIES = {
  "feature.new": { enabled: true }, "feature.set": { enabled: true },
  "dag.init": { enabled: true }, "dag.rewrite": { enabled: true },
  "task.new": { enabled: false, code: "execution_not_shared", reason: "V1 仅共享规划，开卡仍在主场" },
  "dag.bind": { enabled: false, code: "execution_not_shared", reason: "V1 不允许共享绑卡，已绑节点原样保留" },
  stage: { enabled: false, code: "execution_not_shared", reason: "执行阶段仅由登记主场推进" },
  approval: { enabled: false, code: "execution_not_shared", reason: "审批仍在主场，成员身份不授予审批权" },
  scopeChange: { enabled: false, code: "execution_not_shared", reason: "V1 不接受范围变更提案" },
} as const;

export interface SharedLedgerNode {
  key: string;
  oneLine: string;
  deps: string[];
  fileGlobs: string[];
  estimate: string;
}

interface CommandBase { requestId: string; projectId: string }
interface FeatureMutation extends CommandBase { featureId: string; expectedRev: number }
export type SharedLedgerCommand =
  | (CommandBase & { type: "feature.new"; title: string; description: string; homeInstanceId: string })
  | (FeatureMutation & { type: "feature.set"; patch: { title?: string; description?: string } })
  | (FeatureMutation & { type: "dag.init" | "dag.rewrite"; baseVersion: number; nodes: SharedLedgerNode[]; reason: string });

/** POST bodies; retries keep payload/requestId and change attemptNonce and transport timestamp.
 * GET has an empty body; its nonce is signed in transport fields instead (no GET-body dependency).
 */
export interface SharedLedgerEnvelope<T> { attemptNonce: string; payload: T }
/** taskId is a central id in reads; imports use source task ids until C2 remaps the whole manifest. */
interface SharedLedgerBinding { nodeKey: string; taskId: string }
export interface SharedLedgerDag { version: number; nodes: SharedLedgerNode[]; bindings: SharedLedgerBinding[] }
interface SharedLedgerSource {
  sourceInstanceId: string;
  sourceSeq: number;
  observedAt: number;
  receivedAt: number;
}

export interface SharedLedgerFeature {
  id: string;
  projectId: string;
  title: string;
  description: string;
  rev: number;
  version: number;
  /** V1 rejects execution, including during imports. */
  authorityMode: "source" | "planning";
  homeInstanceId: string;
  executorInstanceIds: string[];
  status: "planned" | "active" | "done" | "blocked";
  counts: { total: number; completed: number; blocked: number; missing: number };
  updatedBy: string;
  updatedAt: number;
  projection: SharedLedgerSource | null;
}

interface SharedLedgerSnapshotMeta {
  schemaVersion: 1;
  teamId: string;
  serverSeq: number;
  capabilities: typeof SHARED_LEDGER_CAPABILITIES;
}
/** One consistent snapshot; no pagination that can mix serverSeq values. Scope is credential-filtered. */
export interface SharedLedgerFeatureList extends SharedLedgerSnapshotMeta { features: SharedLedgerFeature[] }
export interface SharedLedgerFeatureDetail extends SharedLedgerSnapshotMeta {
  feature: SharedLedgerFeature;
  dag: SharedLedgerDag;
  /** Both ids are necessary to join central DAG bindings to source execution rows after import. */
  tasks: (SharedLedgerTaskProjection & { taskId: string })[];
}

/** Commit response is stored verbatim under (teamId, personId, instanceId, requestId).
 * Retries and GET receipts return this immutable result, never a freshly read latest version.
 */
export interface SharedLedgerCommandResult {
  schemaVersion: 1;
  requestId: string;
  commandDigest: string;
  serverSeq: number;
  committedAt: number;
  result: { featureId: string; rev: number; version: number };
}
export type SharedLedgerCommandReceipt =
  | { status: "committed"; receipt: SharedLedgerCommandResult }
  | { status: "unknown"; requestId: string };
export type SharedLedgerErrorResponse =
  | { code: "conflict"; status: 409; currentRev: number; currentVersion: number;
      latest: SharedLedgerFeatureDetail; modifiedBy: string; modifiedAt: number }
  | { code: Exclude<SharedLedgerErrorCode, "conflict">; status: number; message: string };

/** Projection data is read-only and redacted. Never a local task row or an arbitrary extra/event blob. */
export interface SharedLedgerTaskProjection {
  sourceTaskId: string;
  sourceRev: number;
  sourceSeq: number;
  stage: string;
  assigneeCode: string | null;
  executorInstanceId: string | null;
  pr: number | null;
  head: string | null;
  deps: string[];
  specSummary: string;
  specDigest: string | null;
  fullText: "home_only";
  steps: { sourceStepId: string; sourceRev: number; sourceSeq: number; state: string }[];
  asks: { kind: string; state: string; blocking: boolean }[];
}
export interface SharedLedgerProjection {
  projectId: string;
  featureId: string;
  sourceInstanceId: string;
  /** Delta requires previousSourceSeq == stored watermark; snapshot repairs gaps.
   * C2 atomically checks task/step revs separately; missing rows never imply deletion/completion.
   */
  mode: "snapshot" | "delta";
  previousSourceSeq: number;
  sourceSeq: number;
  observedAt: number;
  tasks: SharedLedgerTaskProjection[];
  events: { sourceSeq: number; sourceTaskId: string; type: string; at: number; summary: string }[];
}

interface SharedLedgerImportFeature {
  sourceFeatureId: string;
  title: string;
  description: string;
  rev: number;
  authorityMode: "source" | "planning";
  pendingProposal: false;
  versions: (SharedLedgerDag & { reason: string })[];
  projection: Omit<SharedLedgerProjection, "projectId" | "featureId" | "sourceInstanceId">;
}
export interface SharedLedgerImportManifest {
  projectId: string;
  sourceInstanceId: string;
  sourceSeq: number;
  features: SharedLedgerImportFeature[];
}
/** Hash is SHA-256 of canonicalJson(manifest); dry-run/commit share the same batchId and digest.
 * C2 requires explicit owner import authorization; commit is atomic over this entire manifest.
 */
export interface SharedLedgerImport {
  mode: "dry-run" | "commit";
  batchId: string;
  manifestDigest: string;
  manifest: SharedLedgerImportManifest;
}
export interface SharedLedgerImportResult {
  schemaVersion: 1;
  mode: "dry-run" | "commit";
  batchId: string;
  manifestDigest: string;
  serverSeq: number;
  mappings: { kind: "feature" | "task"; sourceInstanceId: string; sourceId: string; id: string }[];
}
export interface SharedLedgerImportControl {
  mode: "activate" | "revoke";
  batchId: string;
  projectId: string;
  manifestDigest: string;
}
export interface SharedLedgerImportVerification {
  features: number; versions: number; bindings: number; tasks: number;
  sourceSeq: number; manifestDigest: string;
}
export type SharedLedgerImportReceipt = { status: "unknown"; batchId: string } | {
  status: "staged" | "active" | "revoked";
  batchId: string; projectId: string; serverSeq: number;
  receipt: SharedLedgerImportResult;
  verification: SharedLedgerImportVerification | null;
};
export interface SharedLedgerProjectionResult {
  schemaVersion: 1;
  serverSeq: number;
  sourceInstanceId: string;
  sourceSeq: number;
  digest: string;
}
