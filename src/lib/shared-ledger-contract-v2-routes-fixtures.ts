/** Synthetic S2K route fixtures: 本机 / peer A / peer B only. One legal and several illegal samples per route. */
import { V2_DTO_FIXTURES, V2_COMMAND_FIXTURES, V2_FIXTURE_SCOPE } from "./shared-ledger-contract-v2-fixtures.js";
import { capabilities } from "./shared-ledger-contract-v2-transfer.js";
import type { V2RouteName } from "./shared-ledger-contract-v2-routes.js";

type Obj = Record<string, any>;
const clone = <T>(v: T): T => structuredClone(v);
const dto = (k: keyof typeof V2_DTO_FIXTURES): Obj => clone(V2_DTO_FIXTURES[k].valid) as Obj;
const s = V2_FIXTURE_SCOPE, other = { teamId: "team", projectId: "project-other" };
const d = "a".repeat(64), d2 = "c".repeat(64);
const task = dto("task"), feature = dto("feature"), ask = dto("ask"), dag = dto("dag");

export const V2_FEATURE_VIEW_FIXTURE = {
  ...s, serverSeq: 3, serviceGeneration: 1, feature, dag, tasks: [task], dependencies: [], steps: [dto("step")],
  workflows: [dto("workflow")], intents: [dto("intent")], resources: [dto("resource")], pendingAsks: [ask], capabilities: capabilities(),
};
const view = () => clone(V2_FEATURE_VIEW_FIXTURE) as Obj;
const mutate = (base: () => Obj, fn: (v: Obj) => void) => { const v = base(); fn(v); return v; };
/** Each illegal view breaks exactly one structural rule. */
export const V2_FEATURE_VIEW_INVALID: Record<string, unknown> = {
  unknownField: { ...view(), extra: true },
  missingCapabilities: mutate(view, v => { delete v.capabilities; }),
  featureCrossScope: mutate(view, v => { v.feature.projectId = other.projectId; }),
  taskCrossScope: mutate(view, v => { v.tasks[0].projectId = other.projectId; }),
  taskOtherFeature: mutate(view, v => { v.tasks[0].featureId = "feature-other"; }),
  workflowTaskMissing: mutate(view, v => { v.workflows[0].taskId = "task-missing"; }),
  intentTaskMissing: mutate(view, v => { v.intents[0].taskId = "task-missing"; v.resources = []; }),
  stepTaskMissing: mutate(view, v => { v.steps[0].taskId = "task-missing"; }),
  resourceIntentMissing: mutate(view, v => { v.resources[0].intentId = "intent-missing"; }),
  dependencyTaskMissing: mutate(view, v => { v.dependencies = [{ ...dto("dependency") }]; }),
  askOtherFeature: mutate(view, v => { v.pendingAsks[0].featureId = "feature-other"; v.pendingAsks[0].bind.featureId = "feature-other"; }),
  askNotPending: mutate(view, v => { v.pendingAsks[0].state = "cancelled"; }),
  dagVersionMismatch: mutate(view, v => { v.dag = null; }),
  dagBindingMissing: mutate(view, v => { v.dag.bindings[0].taskId = "task-missing"; }),
  duplicateTask: mutate(view, v => { v.tasks.push(clone(v.tasks[0])); }),
  capabilitiesMissingCommand: mutate(view, v => { delete v.capabilities["task.set"]; }),
  unknownWithoutLock: mutate(view, v => { v.intents[0].status = "unknown"; v.resources = []; }),
  unknownLockHeld: mutate(view, v => { v.intents[0].status = "unknown"; }),
  resourceFenceMismatch: mutate(view, v => { v.resources[0].epoch += 1; }),
  resourceOtherBoot: mutate(view, v => { v.resources[0].bootId = "boot-other"; }),
  resourceNotDeclared: mutate(view, v => { v.intents[0].resources = []; }),
  resourceOverlap: mutate(view, v => {
    const repo = { ...s, repository: "team/repository", kind: "repository" };
    v.intents.push({ ...clone(v.intents[0]), id: "intent-2", operationId: "operation-2", resources: [repo] });
    v.resources.push({ ...clone(v.resources[0]), key: repo, intentId: "intent-2", operationId: "operation-2" });
  }),
};

const revertView = () => mutate(view, v => {
  v.feature.authorityMode = "planning"; v.feature.epoch = 2; v.resources = []; v.intents[0].status = "done";
});
export const V2_REVERT_REQUEST_FIXTURE = {
  ...s, batchId: "revert-batch", featureIds: ["feature"], expectedEpoch: 1, authorizationAskId: "ask",
  evidence: { dispatchPaused: true, leasesReleased: true, lendSettled: true, unknownReconciled: true },
};
const revertRequest = () => clone(V2_REVERT_REQUEST_FIXTURE) as Obj;
export const V2_REVERT_REQUEST_INVALID: Record<string, unknown> = {
  evidenceFalse: mutate(revertRequest, r => { r.evidence.lendSettled = false; }),
  evidenceMissing: mutate(revertRequest, r => { delete r.evidence.unknownReconciled; }),
  evidenceExtra: mutate(revertRequest, r => { r.evidence.extra = true; }),
  noFeatures: mutate(revertRequest, r => { r.featureIds = []; }),
  duplicateFeatures: mutate(revertRequest, r => { r.featureIds = ["feature", "feature"]; }),
  zeroEpoch: mutate(revertRequest, r => { r.expectedEpoch = 0; }),
  carriesActor: { ...revertRequest(), actor: { kind: "person" } },
};
export const V2_REVERT_RESULT_FIXTURE = {
  ...s, schemaVersion: 2, batchId: "revert-batch", featureIds: ["feature"], nextEpoch: 2,
  serviceGeneration: 1, serverSeq: 4, committedAt: 2000, views: [revertView()],
};
const revertResult = () => clone(V2_REVERT_RESULT_FIXTURE) as Obj;
export const V2_REVERT_RESULT_INVALID: Record<string, unknown> = {
  stillExecution: mutate(revertResult, r => { r.views[0].feature.authorityMode = "execution"; }),
  epochMismatch: mutate(revertResult, r => { r.nextEpoch = 3; }),
  viewMissing: mutate(revertResult, r => { r.views = []; }),
  viewOtherFeature: mutate(revertResult, r => { r.featureIds = ["feature-other"]; }),
  heldResource: mutate(revertResult, r => { r.views[0].resources = [dto("resource")]; r.views[0].intents[0].status = "pending"; }),
  liveIntent: mutate(revertResult, r => { r.views[0].intents[0].status = "unknown"; }),
  viewAhead: mutate(revertResult, r => { r.views[0].serverSeq = 5; }),
  badView: mutate(revertResult, r => { r.views[0].tasks[0].projectId = other.projectId; }),
};

const command = clone(V2_COMMAND_FIXTURES.find(c => c.type === "task.set")!.valid) as Obj;
const receipt = dto("receipt");
const manifest = dto("migrationManifest");
const migrationResult = { ...s, schemaVersion: 2, batchId: "batch", manifestDigest: manifest.manifestDigest, serviceGeneration: 1,
  serverSeq: 2, committedAt: 2000, mappings: manifest.mappings, featureIds: ["feature"] };
const lendView = { order: dto("lendOrder"), lease: dto("lendLease"), task, now: 2000 };

export interface V2RouteFixture {
  params: Obj; path: string;
  request: { valid: unknown; invalid: Record<string, unknown> };
  response: { valid: unknown; invalid: Record<string, unknown> };
}
const p = (extra: Obj = {}) => ({ ...s, ...extra });
const root = "/v2/teams/team/projects/project";
const getBody = { valid: undefined, invalid: { body: {}, nullBody: null } };
const crossScope = (v: Obj) => ({ ...clone(v), projectId: other.projectId });

export const V2_ROUTE_FIXTURES: Record<V2RouteName, V2RouteFixture> = {
  commands: {
    params: p(), path: `${root}/commands`,
    request: { valid: command, invalid: { crossScope: crossScope(command), carriesActor: { ...command, actor: { kind: "person" } }, unknownType: { ...command, type: "task.drop" } } },
    response: { valid: receipt, invalid: { crossScope: crossScope(receipt), badCommand: { ...receipt, command: "task.drop" } } },
  },
  receipts: {
    params: p({ requestId: "request", operationId: "operation", commandDigest: d }),
    path: `${root}/receipts/request?operationId=operation&commandDigest=${d}`,
    request: getBody,
    response: { valid: { ...s, requestId: "request", status: "committed", receipt: { ...receipt, commandDigest: d } }, invalid: {
      otherRequest: { ...s, requestId: "request-other", status: "unknown", receipt: null },
      digestMismatch: { ...s, requestId: "request", status: "committed", receipt: { ...receipt, commandDigest: d2 } },
      unknownWithReceipt: { ...s, requestId: "request", status: "unknown", receipt },
      crossScope: { ...other, requestId: "request", status: "unknown", receipt: null },
    } },
  },
  asks: {
    params: p({ askId: "ask" }), path: `${root}/asks/ask`, request: getBody,
    response: { valid: ask, invalid: { otherAsk: { ...clone(ask), id: "ask-other" }, crossScope: crossScope(ask) } },
  },
  features: {
    params: p({ featureId: "feature" }), path: `${root}/features/feature`, request: getBody,
    response: { valid: V2_FEATURE_VIEW_FIXTURE, invalid: {
      ...V2_FEATURE_VIEW_INVALID,
      otherFeature: mutate(view, v => { v.feature.id = "feature-other"; v.tasks[0].featureId = "feature-other";
        v.pendingAsks[0].featureId = "feature-other"; v.pendingAsks[0].bind.featureId = "feature-other"; }),
      viewCrossScope: mutate(view, v => { v.projectId = other.projectId; }),
    } },
  },
  lend: {
    params: p({ orderId: "order" }), path: `${root}/lend/order`, request: getBody,
    response: { valid: lendView, invalid: {
      otherOrder: { ...clone(lendView), order: { ...dto("lendOrder"), orderId: "order-other" }, lease: null },
      taskMismatch: { ...clone(lendView), task: { ...clone(task), id: "task-other" } },
      leaseOtherGen: { ...clone(lendView), lease: { ...dto("lendLease"), leaseGen: 2 } },
      leaseOtherEpoch: { ...clone(lendView), lease: { ...dto("lendLease"), epoch: 2 } },
      leaseOtherGeneration: { ...clone(lendView), lease: { ...dto("lendLease"), serviceGeneration: 2 } },
      leaseOtherBoot: { ...clone(lendView), lease: { ...dto("lendLease"), bootId: "boot-other" } },
      leaseOtherExecutor: { ...clone(lendView), lease: { ...dto("lendLease"), executorInstanceId: "peer-b",
        worker: { kind: "peer_agent", instanceId: "peer-b", agentId: "worker" } } },
      orderOtherFeature: { ...clone(lendView), task: { ...clone(task), featureId: "feature-other" } },
      orderOtherHome: { ...clone(lendView), task: { ...clone(task), homeInstanceId: "peer-a" } },
      missingNow: { order: lendView.order, lease: null, task },
    } },
  },
  migrations: {
    params: p(), path: `${root}/migrations`,
    request: { valid: { mode: "dry-run", manifest }, invalid: {
      badMode: { mode: "force", manifest }, crossScope: { mode: "commit", manifest: crossScope(manifest) },
    } },
    response: { valid: migrationResult, invalid: { crossScope: crossScope(migrationResult), noDigest: { ...migrationResult, manifestDigest: "x" } } },
  },
  migration: {
    params: p({ batchId: "batch" }), path: `${root}/migrations/batch`, request: getBody,
    response: { valid: { ...s, batchId: "batch", status: "committed", result: migrationResult }, invalid: {
      unknownWithResult: { ...s, batchId: "batch", status: "unknown", result: migrationResult },
      committedWithoutResult: { ...s, batchId: "batch", status: "committed", result: null },
      otherBatch: { ...s, batchId: "batch-other", status: "unknown", result: null },
      resultOtherBatch: { ...s, batchId: "batch", status: "committed", result: { ...migrationResult, batchId: "batch-other" } },
    } },
  },
  reverts: {
    params: p(), path: `${root}/reverts`,
    request: { valid: V2_REVERT_REQUEST_FIXTURE, invalid: { ...V2_REVERT_REQUEST_INVALID, crossScope: crossScope(V2_REVERT_REQUEST_FIXTURE) } },
    response: { valid: V2_REVERT_RESULT_FIXTURE, invalid: { ...V2_REVERT_RESULT_INVALID, crossScope: crossScope(V2_REVERT_RESULT_FIXTURE) } },
  },
  revert: {
    params: p({ batchId: "revert-batch" }), path: `${root}/reverts/revert-batch`, request: getBody,
    response: { valid: { ...s, batchId: "revert-batch", status: "unknown", result: null }, invalid: {
      unknownWithResult: { ...s, batchId: "revert-batch", status: "unknown", result: V2_REVERT_RESULT_FIXTURE },
      otherBatch: { ...s, batchId: "batch", status: "unknown", result: null },
      badResult: { ...s, batchId: "revert-batch", status: "committed", result: V2_REVERT_RESULT_INVALID.stillExecution },
    } },
  },
};
/** Path ids that must never reach a URL. */
export const V2_ROUTE_BAD_IDS = ["a/b", "..", "a..b", "../project", "", " team", "team?x", "%2e%2e"];
