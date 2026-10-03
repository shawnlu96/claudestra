import {
  array, bounded, choice, digest, distinct, fail, head, id, integer, literal, nullable, object,
  positive, refine, scope, text, timestamp, type Infer, type Schema,
} from "./shared-ledger-contract-v2-validation.js";
import { parseArtifact, parseAsk } from "./shared-ledger-contract-v2-asks.js";
import { parseCapability, parseReceipt, V2_COMMAND_NAMES, type V2CommandName } from "./shared-ledger-contract-v2-commands.js";
import { parseDag, parseFeature, parseProposal } from "./shared-ledger-contract-v2-dag.js";
import { parseLendClaim, parseLendLease, parseLendOrder, parseLendResult } from "./shared-ledger-contract-v2-lend.js";
import { parseGeneration, parseIntent, parseLease, parseLeasePolicy, parseOperationResult, parseResource, parseResourceKey } from "./shared-ledger-contract-v2-scheduling.js";
import { parseDependency, parseItem, parseStep, parseTask, parseWorkflow } from "./shared-ledger-contract-v2-tasks.js";
import { v2ManifestDigest } from "./shared-ledger-contract-v2-integrity.js";
import type { V2Artifact, V2Ask, V2AuthorizationBind } from "./shared-ledger-contract-v2-asks.js";
import type { V2Feature, V2Proposal } from "./shared-ledger-contract-v2-dag.js";
import type { V2LendOrder, V2LendClaim, V2LendLease, V2LendResult } from "./shared-ledger-contract-v2-lend.js";
import type { V2Generation, V2Intent, V2Lease, V2Resource, V2ResourceKey, V2OperationResult } from "./shared-ledger-contract-v2-scheduling.js";
import type { V2Dependency, V2Executor, V2Item, V2Step, V2Task, V2Workflow } from "./shared-ledger-contract-v2-tasks.js";
import type { V2Receipt } from "./shared-ledger-contract-v2-commands.js";
import { parseAuthorizationBind } from "./shared-ledger-contract-v2-asks.js";
import { parseExecutor } from "./shared-ledger-contract-v2-tasks.js";
import { parseFence, type V2Fence } from "./shared-ledger-contract-v2-validation.js";
import { resourceKey, resourcesOverlap } from "./shared-ledger-contract-v2-scheduling.js";

const capabilityShape = Object.fromEntries(V2_COMMAND_NAMES.map(k => [k, parseCapability])) as Record<V2CommandName, typeof parseCapability>;
export const parseCapabilities = object(capabilityShape);
export type V2Capabilities = Infer<typeof parseCapabilities>;
export function capabilities(enabled: readonly V2CommandName[] = []): V2Capabilities {
  return parseCapabilities(Object.fromEntries(V2_COMMAND_NAMES.map(k => [k, {
    enabled: enabled.includes(k), code: enabled.includes(k) ? null : "execution_not_shared",
    reason: enabled.includes(k) ? "" : "执行能力尚未开放",
  }])));
}
export const parseActor = refine(object({
  kind: choice(["person", "service"]), personId: id, instanceId: id, serviceId: nullable(id),
  representedPersonId: nullable(id), orderId: nullable(id), projects: array(id, 100), actions: array(choice(V2_COMMAND_NAMES), 100),
}), a => distinct(a.projects) && distinct(a.actions) && (a.kind === "service"
  ? a.serviceId !== null && a.representedPersonId !== null : a.serviceId === null && a.representedPersonId === null && a.orderId === null));
export type V2Actor = Infer<typeof parseActor>;
/** Whitelisted observations are not executable commands and contain no arbitrary event data. */
export const parseEvent = object({
  ...scope, seq: positive, timestamp, entityId: id, kind: choice([
    "task", "item", "dependency", "step", "workflow", "ask", "artifact", "lease", "intent", "operation", "lend", "dag", "migration", "home",
  ]), command: choice(V2_COMMAND_NAMES), requestId: id, actor: parseActor, summary: text(4000),
  taskRev: nullable(positive), specRev: nullable(positive), head: nullable(head),
  source: nullable(object({ instanceId: id, seq: integer, origin: nullable(id), originSeq: nullable(integer) })),
});
export type V2Event = Infer<typeof parseEvent>;
export const executionRows = {
  features: array(parseFeature), dags: array(object({ featureId: id, dag: parseDag })),
  items: array(parseItem), tasks: array(parseTask), dependencies: array(parseDependency), steps: array(parseStep),
  workflows: array(parseWorkflow), asks: array(parseAsk), artifacts: array(parseArtifact),
  leases: array(parseLease), intents: array(parseIntent), resources: array(parseResource), operationResults: array(parseOperationResult),
  lendOrders: array(parseLendOrder), lendClaims: array(parseLendClaim), lendLeases: array(parseLendLease), lendResults: array(parseLendResult),
  proposals: array(parseProposal),
};
const parseRows = object(executionRows);
export type V2ExecutionRows = Infer<typeof parseRows>;
/** Referential checks are shared by import and snapshots; project scope is never inferred from an id. */
export function assertRows(rows: V2ExecutionRows, teamId: string, projectId: string): void {
  const groups = Object.keys(executionRows).map(k => rows[k as keyof V2ExecutionRows]);
  for (const group of groups) for (const value of group) {
    const v = value as unknown as Record<string, unknown>;
    if (Object.hasOwn(v, "teamId") && (v.teamId !== teamId || v.projectId !== projectId)) fail();
  }
  const features = new Map(rows.features.map(f => [f.id, f])), tasks = new Map(rows.tasks.map(t => [t.id, t]));
  const items = new Set(rows.items.map(i => i.id)), intents = new Map(rows.intents.map(i => [i.id, i]));
  const orders = new Map(rows.lendOrders.map(o => [o.orderId, o]));
  for (const [values, key] of [
    [rows.features, "id"], [rows.items, "id"], [rows.tasks, "id"], [rows.asks, "id"], [rows.artifacts, "artifactId"],
    [rows.intents, "id"], [rows.lendOrders, "orderId"], [rows.proposals, "id"], [rows.workflows, "taskId"], [rows.leases, "taskId"],
  ] as const) if (!distinct(values as unknown as Record<string, unknown>[], r => String(r[key]))) fail();
  for (const task of rows.tasks) {
    const f = features.get(task.featureId);
    if (!f || f.homeInstanceId !== task.homeInstanceId || (task.itemId !== null && !items.has(task.itemId))) fail();
  }
  for (const item of rows.items) if (item.featureId !== null && !features.has(item.featureId)) fail();
  for (const dep of rows.dependencies) if (!tasks.has(dep.fromTask) || !tasks.has(dep.toTask)) fail();
  for (const dag of rows.dags) {
    if (!features.has(dag.featureId) || dag.dag.version > features.get(dag.featureId)!.currentVersion) fail();
    for (const b of dag.dag.bindings) if (tasks.get(b.taskId)?.featureId !== dag.featureId) fail();
  }
  for (const f of rows.features) if (f.currentVersion > 0 && !rows.dags.some(d => d.featureId === f.id && d.dag.version === f.currentVersion)) fail();
  for (const group of [rows.steps, rows.workflows, rows.leases, rows.intents, rows.lendOrders, rows.artifacts]) {
    for (const v of group) if (!tasks.has(v.taskId)) fail();
  }
  for (const group of [rows.asks, rows.proposals]) for (const v of group) if (!features.has(v.featureId)) fail();
  for (const ask of rows.asks) if (ask.taskId !== null && tasks.get(ask.taskId)?.featureId !== ask.featureId) fail();
  const artifacts = new Map(rows.artifacts.map(a => [a.artifactId, a]));
  for (const task of rows.tasks) if (task.spec.artifactId !== null) {
    const artifact = artifacts.get(task.spec.artifactId);
    if (!artifact || artifact.taskId !== task.id || artifact.specRev !== task.specRev || artifact.sharedDigest !== task.spec.sharedDigest) fail();
  }
  if (!distinct(rows.dependencies, d => JSON.stringify([d.fromTask, d.toTask]))
    || !distinct(rows.steps, s => JSON.stringify([s.taskId, s.step, s.round]))
    || !distinct(rows.dags, d => JSON.stringify([d.featureId, d.dag.version]))
    || !distinct(rows.resources, r => resourceKey(r.key))) fail();
  parseDag({ version: 1, nodes: rows.tasks.map(t => ({ key: t.id, oneLine: t.title,
    deps: rows.dependencies.filter(d => d.toTask === t.id).map(d => d.fromTask), fileGlobs: [], estimate: "" })), bindings: [] });
  for (const r of rows.resources) if (r.key.teamId !== teamId || r.key.projectId !== projectId
    || intents.get(r.intentId)?.taskId !== r.taskId || intents.get(r.intentId)?.operationId !== r.operationId) fail();
  for (const r of rows.operationResults) if (intents.get(r.intentId)?.taskId !== r.taskId) fail();
  for (const group of [rows.lendClaims, rows.lendLeases, rows.lendResults]) for (const r of group) if (orders.get(r.orderId)?.taskId !== r.taskId) fail();
  for (const intent of rows.intents) if (intent.status === "unknown") for (const key of intent.resources) {
    if (!rows.resources.some(r => r.intentId === intent.id && r.state === "unknown" && resourceKey(r.key) === resourceKey(key))) fail();
  }
  assertExecutionLinks(rows);
}
function sameFence(a: V2Fence, b: V2Fence): boolean {
  return a.serviceGeneration === b.serviceGeneration && a.epoch === b.epoch && a.bootId === b.bootId;
}
function assertExecutionLinks(rows: V2ExecutionRows): void {
  for (const r of rows.resources) {
    const intent = rows.intents.find(i => i.id === r.intentId)!;
    if (!sameFence(r, intent) || !intent.resources.some(key => resourceKey(key) === resourceKey(r.key))) fail();
    if (rows.resources.some(other => other.intentId !== r.intentId && resourcesOverlap(r.key, other.key))) fail();
  }
  for (const r of rows.operationResults) {
    const intent = rows.intents.find(i => i.id === r.intentId)!;
    if (!sameFence(r, intent) || r.operationId !== intent.operationId) fail();
  }
  for (const group of [rows.lendClaims, rows.lendLeases, rows.lendResults]) for (const r of group) {
    const order = rows.lendOrders.find(o => o.orderId === r.orderId)!;
    if (!sameFence(r, order) || r.leaseGen !== order.leaseGen || r.executorInstanceId !== order.executorInstanceId) fail();
    if ("specRev" in r && (r.specRev !== order.specRev || r.round !== order.round)) fail();
    if ("expectedHead" in r ? r.expectedHead !== order.head : "head" in r && r.head !== order.head) fail();
  }
}
export const parseSnapshot = bounded(refine(object({
  ...scope, schemaVersion: literal(2), service: parseGeneration, serverSeq: integer, capturedAt: timestamp,
  capabilities: parseCapabilities, leasePolicy: parseLeasePolicy, ...executionRows,
  events: array(parseEvent, 10000), receipts: array(parseReceipt, 10000),
}), s => {
  assertRows(s, s.teamId, s.projectId);
  return s.serverSeq === s.service.serverSeq && s.events.every(e => e.teamId === s.teamId && e.projectId === s.projectId && e.seq <= s.serverSeq)
    && s.receipts.every(r => r.teamId === s.teamId && r.projectId === s.projectId && r.serverSeq <= s.serverSeq
    && r.serviceGeneration <= s.service.serviceGeneration)
    && distinct(s.events, e => String(e.seq))
    && distinct(s.receipts, r => JSON.stringify([r.personId, r.instanceId, r.requestId]));
}), 16_777_216);
export type V2Snapshot = Infer<typeof parseSnapshot>;
export const parseIdMapping = object({
  kind: choice(["feature", "item", "task", "ask", "artifact", "intent", "order", "proposal"]), sourceInstanceId: id, sourceId: id, id,
});
export const parseMigrationManifest = bounded(refine(object({
  ...scope, schemaVersion: literal(2), batchId: id, sourceInstanceId: id, featureIds: array(id),
  sourceSeq: integer, serviceGeneration: positive, snapshotDigest: digest, manifestDigest: digest,
  authorityFrom: choice(["source", "planning"]), authorityTo: literal("execution"),
  frozenAt: timestamp, authorizationAskId: id, mappings: array(parseIdMapping, 10000), ...executionRows,
  evidence: object({ dispatchPaused: literal(true), workersSettled: literal(true), unknownReconciled: literal(true),
    specsComplete: literal(true), reviewsComplete: literal(true), oldOrders: choice(["settled", "imported_reconciled"]),
    localWriteGateInstalled: literal(true), leasesMustBeAcquired: literal(true) }),
}), m => {
  assertRows(m, m.teamId, m.projectId);
  return m.featureIds.length > 0 && distinct(m.featureIds) && m.features.length === m.featureIds.length
    && m.features.every(f => m.featureIds.includes(f.id) && f.authorityMode === m.authorityFrom)
    && m.leases.length === 0 && m.intents.every(i => i.status !== "unknown") && m.proposals.every(p => p.state !== "pending")
    && m.resources.every(r => r.state !== "unknown") && m.operationResults.every(r => r.state !== "unknown")
    && m.lendOrders.every(o => o.status !== "unknown") && m.lendResults.every(r => r.verdict !== "unknown")
    && (m.evidence.oldOrders !== "settled" || m.lendOrders.every(o => !["pooled", "claimed"].includes(o.status)))
    && m.tasks.every(t => t.spec.visibility === "approved_copy")
    && m.mappings.every(x => x.sourceInstanceId === m.sourceInstanceId)
    && distinct(m.mappings, x => JSON.stringify([x.kind, x.sourceInstanceId, x.sourceId]))
    && distinct(m.mappings, x => JSON.stringify([x.kind, x.id])) && completeMappings(m)
    && m.manifestDigest === v2ManifestDigest(m);
}), 16_777_216);
export type V2MigrationManifest = Infer<typeof parseMigrationManifest>;
function completeMappings(m: { mappings: ReturnType<typeof parseIdMapping>[] } & V2ExecutionRows): boolean {
  const rows = { feature: m.features.map(r => r.id), item: m.items.map(r => r.id), task: m.tasks.map(r => r.id), ask: m.asks.map(r => r.id),
    artifact: m.artifacts.map(r => r.artifactId), intent: m.intents.map(r => r.id), order: m.lendOrders.map(r => r.orderId), proposal: m.proposals.map(r => r.id) };
  return Object.entries(rows).every(([kind, ids]) => ids.every(id => m.mappings.some(x => x.kind === kind && x.id === id)))
    && m.mappings.every(x => rows[x.kind].includes(x.id));
}
export const parseMigration = object({ mode: choice(["dry-run", "commit"]), manifest: parseMigrationManifest });
export const parseMigrationResult = object({
  schemaVersion: literal(2), ...scope, batchId: id, manifestDigest: digest, serviceGeneration: positive,
  serverSeq: positive, committedAt: timestamp, mappings: array(parseIdMapping, 10000), featureIds: array(id),
});
/** Error/receipt lookups expose only credential-filtered scope. A timeout is unknown, never implicit failure. */
export const parseReceiptLookup = refine(object({
  ...scope, requestId: id, status: choice(["committed", "unknown"]), receipt: nullable(parseReceipt),
}), r => r.status === "unknown" ? r.receipt === null : r.receipt !== null && r.receipt.requestId === r.requestId
  && r.receipt.teamId === r.teamId && r.receipt.projectId === r.projectId);
export interface V2DTOs {
  task: V2Task; item: V2Item; dependency: V2Dependency; step: V2Step; workflow: V2Workflow;
  ask: V2Ask; authorizationBind: V2AuthorizationBind; artifact: V2Artifact; executor: V2Executor; fence: V2Fence;
  lease: V2Lease; intent: V2Intent; resourceKey: V2ResourceKey; resource: V2Resource; operationResult: V2OperationResult;
  lendOrder: V2LendOrder; lendClaim: V2LendClaim; lendLease: V2LendLease; lendResult: V2LendResult;
  feature: V2Feature; dag: ReturnType<typeof parseDag>; proposal: V2Proposal; generation: V2Generation;
  capabilities: V2Capabilities; snapshot: V2Snapshot; migrationManifest: V2MigrationManifest;
  actor: V2Actor; event: V2Event; receipt: V2Receipt;
}
export const V2_DTO_SCHEMAS = Object.freeze({
  authorizationBind: parseAuthorizationBind, executor: parseExecutor, fence: parseFence,
  task: parseTask, item: parseItem, dependency: parseDependency, step: parseStep, workflow: parseWorkflow,
  ask: parseAsk, artifact: parseArtifact, lease: parseLease, intent: parseIntent, resourceKey: parseResourceKey,
  resource: parseResource, operationResult: parseOperationResult, lendOrder: parseLendOrder, lendClaim: parseLendClaim,
  lendLease: parseLendLease, lendResult: parseLendResult, feature: parseFeature, dag: parseDag, proposal: parseProposal,
  generation: parseGeneration, capabilities: parseCapabilities, snapshot: parseSnapshot, migrationManifest: parseMigrationManifest,
  actor: parseActor, event: parseEvent, receipt: parseReceipt,
} satisfies { [K in keyof V2DTOs]: Schema<V2DTOs[K]> });
export function parseDTO<K extends keyof V2DTOs>(kind: K, value: unknown): V2DTOs[K] {
  return V2_DTO_SCHEMAS[kind](value) as V2DTOs[K];
}
