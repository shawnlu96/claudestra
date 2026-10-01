/** Data-only fixtures: safe for browser consumers; no auth, crypto, storage or network imports. */
import {
  SHARED_LEDGER_CAPABILITIES, type SharedLedgerCommand, type SharedLedgerEnvelope, type SharedLedgerFeatureDetail,
  type SharedLedgerFeatureList, type SharedLedgerCommandResult, type SharedLedgerCommandReceipt, type SharedLedgerErrorResponse,
  type SharedLedgerImport, type SharedLedgerImportResult, type SharedLedgerProjection, type SharedLedgerProjectionResult,
} from "./shared-ledger-contract.js";

const now = 1_790_000_000_000;
const nonce = "0123456789abcdef0123456789abcdef";
const nodes = [{ key: "C1", oneLine: "冻结共享契约", deps: [], fileGlobs: ["src/lib/shared-ledger-*.ts"], estimate: "2h" }];

export const SHARED_LEDGER_COMMAND_FIXTURES: SharedLedgerEnvelope<SharedLedgerCommand>[] = [
  { attemptNonce: nonce, payload: { type: "feature.new", requestId: "request-new", projectId: "project-a",
    title: "团队共享台账", description: "共享规划与只读执行投影", homeInstanceId: "instance-a" } },
  { attemptNonce: nonce, payload: { type: "feature.set", requestId: "request-set", projectId: "project-a",
    featureId: "feature-a", expectedRev: 7, patch: { description: "补充规划说明" } } },
  { attemptNonce: nonce, payload: { type: "dag.init", requestId: "request-init", projectId: "project-a",
    featureId: "feature-a", expectedRev: 1, baseVersion: 0, nodes, reason: "建立规划" } },
  { attemptNonce: nonce, payload: { type: "dag.rewrite", requestId: "request-rewrite", projectId: "project-a",
    featureId: "feature-a", expectedRev: 7, baseVersion: 1, nodes: [...nodes,
      { key: "C2", oneLine: "实现中心服务", deps: ["C1"], fileGlobs: ["src/shared-ledger/**"], estimate: "3h" }], reason: "补充服务节点" } },
];

export const SHARED_LEDGER_PROJECTION_FIXTURE: SharedLedgerEnvelope<SharedLedgerProjection> = {
  attemptNonce: nonce, payload: {
    projectId: "project-a", featureId: "feature-a", sourceInstanceId: "instance-a", mode: "snapshot",
    previousSourceSeq: 0, sourceSeq: 30, observedAt: now,
    tasks: [{ sourceTaskId: "task-a", sourceRev: 3, sourceSeq: 30, stage: "write", assigneeCode: "worker-a",
      executorInstanceId: "instance-b", pr: null, head: null, deps: [], specSummary: "契约冻结", specDigest: null, fullText: "home_only",
      steps: [{ sourceStepId: "step-a", sourceRev: 2, sourceSeq: 29, state: "active" }], asks: [] }],
    events: [{ sourceSeq: 30, sourceTaskId: "task-a", type: "stage", at: now, summary: "进入实现阶段" }],
  },
};

export const SHARED_LEDGER_FEATURE_FIXTURE: SharedLedgerFeatureDetail = {
  schemaVersion: 1, teamId: "team-a", serverSeq: 40, capabilities: SHARED_LEDGER_CAPABILITIES,
  feature: { id: "feature-a", projectId: "project-a", title: "团队共享台账", description: "共享规划与只读执行投影",
    rev: 7, version: 1, authorityMode: "planning", homeInstanceId: "instance-a", executorInstanceIds: ["instance-b"],
    status: "active", counts: { total: 1, completed: 0, blocked: 0, missing: 0 }, updatedBy: "person-a", updatedAt: now,
    projection: { sourceInstanceId: "instance-a", sourceSeq: 30, observedAt: now, receivedAt: now } },
  dag: { version: 1, nodes, bindings: [{ nodeKey: "C1", taskId: "task-global-a" }] },
  tasks: SHARED_LEDGER_PROJECTION_FIXTURE.payload.tasks.map((t) => ({ ...t, taskId: "task-global-a" })),
};

export const SHARED_LEDGER_LIST_FIXTURE: SharedLedgerFeatureList = {
  schemaVersion: 1, teamId: "team-a", serverSeq: 40, capabilities: SHARED_LEDGER_CAPABILITIES,
  features: [SHARED_LEDGER_FEATURE_FIXTURE.feature],
};
export const SHARED_LEDGER_RESULT_FIXTURE: SharedLedgerCommandResult = {
  schemaVersion: 1, requestId: "request-rewrite", commandDigest: "a03df561e8426597166162a076879dcddba9041f3a645650ea922d44b0b741a9",
  serverSeq: 41, committedAt: now + 1000, result: { featureId: "feature-a", rev: 8, version: 2 },
};
export const SHARED_LEDGER_RECEIPT_FIXTURE: SharedLedgerCommandReceipt = { status: "committed", receipt: SHARED_LEDGER_RESULT_FIXTURE };
export const SHARED_LEDGER_UNKNOWN_RECEIPT_FIXTURE: SharedLedgerCommandReceipt = { status: "unknown", requestId: "request-missing" };
export const SHARED_LEDGER_CONFLICT_FIXTURE: SharedLedgerErrorResponse = {
  code: "conflict", status: 409, currentRev: 7, currentVersion: 1,
  latest: SHARED_LEDGER_FEATURE_FIXTURE, modifiedBy: "person-a", modifiedAt: now,
};

const { projectId: _project, featureId: _feature, sourceInstanceId: _source, ...projection } = SHARED_LEDGER_PROJECTION_FIXTURE.payload;
export const SHARED_LEDGER_IMPORT_FIXTURE: SharedLedgerEnvelope<SharedLedgerImport> = {
  attemptNonce: nonce, payload: {
    mode: "dry-run", batchId: "batch-a", manifestDigest: "c22b419afeedaf35a55e7a552f2f52a0dcbd97910b827e849992a3f31ca584c9",
    manifest: { projectId: "project-a", sourceInstanceId: "instance-a", sourceSeq: 30, features: [{
      sourceFeatureId: "old-feature-a", title: "团队共享台账", description: "共享规划与只读执行投影", rev: 7,
      authorityMode: "planning", pendingProposal: false,
      versions: [{ version: 1, nodes, bindings: [{ nodeKey: "C1", taskId: "task-a" }], reason: "初始导入" }], projection,
    }] },
  },
};
export const SHARED_LEDGER_IMPORT_RESULT_FIXTURE: SharedLedgerImportResult = {
  schemaVersion: 1, mode: "dry-run", batchId: "batch-a", manifestDigest: SHARED_LEDGER_IMPORT_FIXTURE.payload.manifestDigest,
  serverSeq: 40, mappings: [{ kind: "feature", sourceInstanceId: "instance-a", sourceId: "old-feature-a", id: "feature-a" },
    { kind: "task", sourceInstanceId: "instance-a", sourceId: "task-a", id: "task-global-a" }],
};
export const SHARED_LEDGER_PROJECTION_RESULT_FIXTURE: SharedLedgerProjectionResult = {
  schemaVersion: 1, serverSeq: 40, sourceInstanceId: "instance-a", sourceSeq: 30,
  digest: "0049aa35ebb89b9edd1a9643f838718504a2f32249a6df203eecb0138782167c",
};
