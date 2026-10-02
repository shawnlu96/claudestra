/** Synthetic wire fixtures only: 本机 / peer A / peer B. No machine paths or production identities. */
import { capabilities, V2_DTO_SCHEMAS } from "./shared-ledger-contract-v2-transfer.js";
import { V2_COMMAND_NAMES, parseCommand } from "./shared-ledger-contract-v2-commands.js";
import { parseFence, V2_ERROR_STATUS, type V2ErrorCode } from "./shared-ledger-contract-v2-validation.js";
import { v2ContentDigest, v2ManifestDigest } from "./shared-ledger-contract-v2-integrity.js";

export const V2_FIXTURE_SCOPE = { teamId: "team", projectId: "project" };
export const V2_FIXTURE_FENCE = { serviceGeneration: 1, epoch: 1, bootId: "boot-local" };
const V2_FIXTURE_DIGEST = "a".repeat(64);
const V2_FIXTURE_HEAD = "b".repeat(40);
const s = V2_FIXTURE_SCOPE, f = V2_FIXTURE_FENCE, d = V2_FIXTURE_DIGEST, h = V2_FIXTURE_HEAD;
const times = { createdAt: 1000, updatedAt: 1000, rev: 1 };
const executor = { kind: "agent", instanceId: "local", agentId: "worker" };
const peerWorker = { kind: "peer_agent", instanceId: "peer-a", agentId: "worker" };
const spec = { summary: "规格仅在主场", originalDigest: d, sharedDigest: null, artifactId: null,
  visibility: "home_only", repositoryPath: "spec/task.md", commit: h };
const bind = { taskId: "task", featureId: "feature", taskRev: 1, specRev: 1, workflowRev: 1,
  baseVersion: 1, proposalDigest: d, head: h, originalDigest: d, sharedDigest: d, actionDigest: d,
  redactionVersion: 1, actions: ["merge"], homeInstanceId: "local", expiresAt: 100000 };
const feature = { ...s, id: "feature", title: "合成 feature", description: "", ownerWords: "", ownerWordsBy: "person",
  authorityMode: "planning", homeInstanceId: "local", epoch: 1, status: "active", currentVersion: 1, ...times };
const task = { ...s, id: "task", itemId: "item", featureId: "feature", title: "合成 task", plan: "", kind: "code",
  stage: "spec", stageBefore: null, round: 0, specRev: 1, ...times, homeInstanceId: "local", executor,
  executorInstanceId: "local", pm: null, repository: "team/repository", branch: "feat/example", pr: 1, head: h, spec,
  collaboration: { reviewer: null, delegate: null }, review: { verdict: null, reviewedHead: null, reportArtifactId: null },
  delivery: { orderId: null, summary: "", artifactIds: [] } };
const item = { ...s, id: "item", featureId: "feature", title: "合成 item", ownerWords: "", ownerWordsBy: "person",
  description: "", descriptionBy: "person", priority: "P1", status: "todo", oneLine: "", next: "", ...times };
const dependency = { ...s, fromTask: "task", toTask: "task-two", kind: "blocks", when: "", state: "waiting", createdBy: "person", ...times };
const step = { ...s, taskId: "task", step: "write", round: 0, executor, state: "assigned", headFrom: null, headTo: null, verdict: null,
  verified: { author: null, independentReviewer: false, verifiedHead: null, evidenceArtifactIds: [] },
  claims: { family: "codex", model: null, summary: "" }, ...times };
const workflow = { ...s, taskId: "task", template: "code", templateVersion: 1, mode: "manual",
  authorFamily: "codex", fallback: [], specRev: 1, ...times };
const ask = { ...s, id: "ask", featureId: "feature", taskId: "task", source: "business", kind: "authorize", blocking: true,
  title: "合成授权", context: "", options: [{ id: "approve", label: "批准" }], allowText: false, bind,
  state: "open", rev: 1, createdBy: "person", createdAt: 1000, expiresAt: 100000,
  answeredBy: null, answeredAt: null, answer: null, decision: null, auditEventSeq: 1 };
const artifact = { ...s, artifactId: "artifact", kind: "spec", taskId: "task", specRev: 1, head: null,
  digest: v2ContentDigest("copy"), originalDigest: d, sharedDigest: v2ContentDigest("copy"),
  redactionVersion: 1, approvalAskId: "ask", approvedBy: "person", createdAt: 1000,
  mediaType: "text/markdown", bytes: 4, content: "copy", visibility: "approved_copy" };
const lease = { ...s, taskId: "task", homeInstanceId: "local", holderInstanceId: "local", ...f,
  acquiredAt: 1000, renewedAt: 1000, expiresAt: 61000 };
const resourceKey = { ...s, repository: "team/repository", kind: "file", path: "src/example.ts" };
const intent = { ...s, id: "intent", taskId: "task", homeInstanceId: "local", executorInstanceId: "local", ...f,
  node: "write", action: "dispatch", operationId: "operation", taskRev: 1, specRev: 1, workflowRev: 1,
  templateVersion: 1, head: h, round: 0, dependencyDigest: d, authorizationAskId: null, authorizationDigest: null,
  resources: [resourceKey], causalSeq: 0, eventSeq: 1, status: "pending", attempts: 0, reason: "", createdAt: 1000, updatedAt: 1000 };
const resource = { key: resourceKey, taskId: "task", intentId: "intent", operationId: "operation", ...f, scope: "intent", state: "held", acquiredAt: 1000 };
const operationResult = { ...s, operationId: "operation", intentId: "intent", taskId: "task", ...f,
  state: "succeeded", head: h, approvalAskId: null, summary: "", artifactIds: [], observedAt: 1000 };
const orderVersion = { orderId: "order", taskId: "task", specRev: 1, round: 0, head: h, leaseGen: 1 };
const lendOrder = { ...s, ...orderVersion, featureId: "feature", homeInstanceId: "local", executorInstanceId: "peer-a", ...f,
  family: "codex", step: "review", repository: "team/repository", pr: 1, branch: null, base: null, specArtifactId: "artifact",
  grantId: "grant", grantDigest: d, authorizationAskId: null, status: "claimed", worker: peerWorker, leaseMs: 60000, leaseUntil: 61000,
  resultDigest: null, resultOperationId: null, eventSeq: 1, supersedes: null, createdBy: "person", createdAt: 1000, updatedAt: 1000, seenAt: null };
const lendClaim = { ...s, ...orderVersion, ...f, executorInstanceId: "peer-a", worker: peerWorker, grantId: "grant", grantDigest: d, claimedAt: 1000 };
const lendLease = { ...s, orderId: "order", taskId: "task", ...f, leaseGen: 1, executorInstanceId: "peer-a", worker: peerWorker,
  renewedAt: 1000, expiresAt: 61000, leaseMs: 60000 };
const lendResult = { ...s, orderId: "order", taskId: "task", ...f, specRev: 1, round: 0, expectedHead: h, head: h, leaseGen: 1,
  executorInstanceId: "peer-a", worker: peerWorker, operationId: "lend-result", resultDigest: d, verdict: "pass", summary: "", artifactIds: [], observedAt: 1000 };
const dag = { version: 1, nodes: [{ key: "write", oneLine: "合成任务", deps: [], fileGlobs: ["src/example.ts"], estimate: "1h" }],
  bindings: [{ nodeKey: "write", taskId: "task" }] };
const proposal = { ...s, id: "proposal", featureId: "feature", baseVersion: 1, version: 2, reasonKind: "new_issue", reasonText: "合成原因",
  nodes: dag.nodes, cancels: [], scopeChange: true, proposalDigest: d, baseDigest: d, expiresAt: 100000, rev: 1,
  proposedBy: "person", askId: "ask", createdAt: 1000, state: "pending", decidedAt: null, decidedBy: null, decisionNote: "" };
const generation = { serviceId: "service", serviceGeneration: 1, schemaVersion: 2, bootId: "service-boot", state: "active",
  serverSeq: 1, startedAt: 1000, restoredFrom: null, restoreReconciledAt: null };
const actor = { kind: "person", personId: "person", instanceId: "local", serviceId: null, representedPersonId: null,
  orderId: null, projects: ["project"], actions: ["task.set"] };
const receipt = { ...s, schemaVersion: 2, serviceGeneration: 1, requestId: "request", personId: "person", instanceId: "local", commandDigest: d,
  command: "task.set", serverSeq: 1, committedAt: 1000,
  result: { entityId: "task", rev: 2, specRev: 1, version: null, epoch: 1, operationId: null } };
const event = { ...s, seq: 1, timestamp: 1000, entityId: "task", kind: "task", command: "task.set", requestId: "request",
  actor, summary: "", taskRev: 2, specRev: 1, head: null, source: null };
const rows = { features: [feature], dags: [{ featureId: "feature", dag }], items: [item], tasks: [task], dependencies: [], steps: [step],
  workflows: [workflow], asks: [ask], artifacts: [artifact], leases: [], intents: [intent], resources: [resource], operationResults: [],
  lendOrders: [lendOrder], lendClaims: [lendClaim], lendLeases: [lendLease], lendResults: [], proposals: [proposal] };
const snapshot = { ...s, schemaVersion: 2, service: generation, serverSeq: 1, capturedAt: 1000, capabilities: capabilities(),
  leasePolicy: { leaseMs: 60000, renewMs: 15000, clock: "central" }, ...rows, events: [event], receipts: [receipt] };
const migrationManifest = { ...s, schemaVersion: 2, batchId: "batch", sourceInstanceId: "local", featureIds: ["feature"], sourceSeq: 1,
  serviceGeneration: 1, snapshotDigest: d, manifestDigest: d, authorityFrom: "planning", authorityTo: "execution", frozenAt: 1000,
  authorizationAskId: "ask", ...rows, proposals: [],
  tasks: [{ ...task, spec: { ...spec, artifactId: "artifact", sharedDigest: artifact.sharedDigest, visibility: "approved_copy" } }],
  mappings: Object.entries({ feature: ["feature"], item: ["item"], task: ["task"], ask: ["ask"], artifact: ["artifact"],
    intent: ["intent"], order: ["order"] }).flatMap(([kind, ids]) => ids.map(id => ({ kind, sourceInstanceId: "local", sourceId: `old-${id}`, id }))),
  evidence: { dispatchPaused: true, workersSettled: true, unknownReconciled: true, specsComplete: true, reviewsComplete: true,
    oldOrders: "imported_reconciled", localWriteGateInstalled: true, leasesMustBeAcquired: true } };
migrationManifest.manifestDigest = v2ManifestDigest(migrationManifest);
const legal = { authorizationBind: bind, executor, fence: f,
  task, item, dependency, step, workflow, ask, artifact, lease, intent, resourceKey, resource, operationResult,
  lendOrder, lendClaim, lendLease, lendResult, feature, dag, proposal, generation, capabilities: capabilities(), snapshot, migrationManifest, actor, event, receipt };
export const V2_DTO_FIXTURES = Object.fromEntries(Object.entries(legal).map(([kind, valid]) =>
  [kind, { valid, invalid: { ...valid, unrecognized: true } }])) as {
    [K in keyof typeof V2_DTO_SCHEMAS]: { valid: unknown; invalid: unknown };
  };
const taskVersion = { taskId: "task", expectedRev: 1, expectedSpecRev: 1 };
const execution = { ...taskVersion, expectedWorkflowRev: 1 };
const featureVersion = { featureId: "feature", expectedRev: 1 };
const askVersion = { askId: "ask", expectedRev: 1, bindDigest: d };
const payloads = {
  "feature.new": { title: "合成", description: "", homeInstanceId: "local" },
  "feature.set": { ...featureVersion, title: "新标题" },
  "dag.init": { ...featureVersion, baseVersion: 0, nodes: dag.nodes, reason: "初版" },
  "item.new": { featureId: "feature", title: "合成", description: "" },
  "item.set": { itemId: "item", expectedRev: 1, title: "合成" },
  "task.new": { ...featureVersion, itemId: "item", title: "合成", plan: "", kind: "code", repository: "team/repository", spec },
  "task.set": { ...taskVersion, patch: { title: "新标题" } },
  "task.spec": { ...taskVersion, nextSpecRev: 2, spec, reason: "变更" },
  "task.assign": { ...execution, executor, authorizationAskId: null },
  "task.stage": { ...execution, from: "spec", to: "restate", round: 0, authorizationAskId: null },
  "task.deliver": { ...execution, round: 0, orderId: null, leaseGen: null, head: h, artifactIds: [], summary: "" },
  "task.review": { ...execution, round: 0, orderId: null, leaseGen: null, head: h, verdict: "pass", reportArtifactId: "artifact" },
  "dep.set": { fromTask: "task", toTask: "task-two", expectedRev: 0, kind: "blocks", when: "" },
  "dep.remove": { fromTask: "task", toTask: "task-two", expectedRev: 1 },
  "step.assign": { ...execution, step: "write", round: 0, executor },
  "workflow.set": { ...execution, template: "code", templateVersion: 1, mode: "manual", authorFamily: "codex", fallback: [], authorizationAskId: null },
  "ask.create": { featureId: "feature", taskId: "task", kind: "authorize", blocking: true, title: "批准", context: "", options: [], allowText: true, bind },
  "ask.answer": { ...askVersion, answer: { kind: "option", optionId: "approve" }, decision: "approved" },
  "ask.cancel": { ...askVersion, reason: "撤销" }, "ask.expire": askVersion,
  "authorization.check": { ...execution, askId: "ask", bind, action: "merge" }, "artifact.put": { artifact },
  "lease.acquire": { ...execution, homeInstanceId: "local" },
  "lease.renew": { taskId: "task", homeInstanceId: "local" }, "lease.release": { taskId: "task", reason: "停止" },
  "intent.create": { ...execution, action: "dispatch", node: "write", operationId: "operation", head: h, round: 0,
    dependencyDigest: d, authorizationAskId: null, authorizationDigest: null, resources: [resourceKey] },
  "intent.check": { ...execution, intentId: "intent", operationId: "operation", authorizationAskId: null, authorizationDigest: null },
  "intent.cancel": { ...execution, intentId: "intent", operationId: "operation", reason: "停止" },
  "operation.result": { result: operationResult },
  "operation.reconcile": { ...execution, intentId: "intent", operationId: "operation", result: operationResult, authorizationAskId: "ask" },
  "lend.create": { ...execution, featureId: "feature", family: "codex", step: "review", executorInstanceId: "peer-a",
    specArtifactId: "artifact", head: h, round: 0, branch: null, base: null, grantId: "grant", grantDigest: d },
  "lend.claim": { claim: lendClaim }, "lend.renew": { orderId: "order", leaseGen: 1, executorInstanceId: "peer-a" },
  "lend.result": { result: lendResult }, "lend.cancel": { ...execution, orderId: "order", leaseGen: 1, reason: "停止" },
  "dag.propose": { ...featureVersion, baseVersion: 1, version: 2, reasonKind: "new_issue", reasonText: "原因",
    nodes: dag.nodes, cancels: [], scopeChange: true, proposalDigest: d, baseDigest: d, expiresAt: 100000 },
  "dag.decide": { ...featureVersion, proposalId: "proposal", proposalDigest: d, baseVersion: 1, askId: "ask", decision: "approved" },
  "dag.bind": { ...featureVersion, baseVersion: 1, nodeKey: "write", taskId: "task" },
  "dag.rewrite": { ...featureVersion, baseVersion: 0, dag, reason: "原因" },
  "home.change": { ...featureVersion, nextHomeInstanceId: "peer-b", nextEpoch: 2, authorizationAskId: "ask",
    oldHomeStopped: true, workersSettled: true, lendSettled: true, unknownReconciled: true },
  "migration.commit": { featureId: "feature", batchId: "batch", manifestDigest: d, authorizationAskId: "ask" },
};
export const V2_COMMAND_FIXTURES = V2_COMMAND_NAMES.map(type => {
  const valid = parseCommand({ ...s, ...f, requestId: `request-${type}`, type, payload: payloads[type] });
  return { type, valid, invalid: { ...valid, payload: { ...valid.payload, unrecognized: true } } };
});
export const V2_ERROR_FIXTURES = Object.entries(V2_ERROR_STATUS).map(([code, status]) => ({
  code: code as V2ErrorCode, status, valid: { code: code as V2ErrorCode, message: "", requestId: null }, invalid: { code, message: 1, requestId: null },
}));
export const V2_FENCE_FIXTURES = { valid: parseFence(f), invalid: { ...f, epoch: 0 } };
export const V2_INSTANCE_LABELS = { local: "本机", "peer-a": "peer A", "peer-b": "peer B" } as const;
