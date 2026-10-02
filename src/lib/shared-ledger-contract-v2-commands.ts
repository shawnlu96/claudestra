import {
  array, boolean, bounded, branch, choice, digest, fenceFields, head, id, integer, literal, nullable,
  object, optional, positive, record, refine, repository, scope, text, timestamp, fail, V2_ERROR_STATUS, type Infer, type Schema, type V2ErrorCode,
} from "./shared-ledger-contract-v2-validation.js";
import { STAGES, STEPS, TASK_KINDS } from "./ledger-stages.js";
import { askContentFields, parseAskAnswer, parseArtifact, parseAuthorizationBind } from "./shared-ledger-contract-v2-asks.js";
import { parseDag, parseNode, proposalContentFields } from "./shared-ledger-contract-v2-dag.js";
import { parseLendClaim, parseLendResult } from "./shared-ledger-contract-v2-lend.js";
import { executionActions, parseOperationResult, parseResourceKey } from "./shared-ledger-contract-v2-scheduling.js";
import { parseExecutor, parseTaskPatch, parseTaskSpec, workflowSettings } from "./shared-ledger-contract-v2-tasks.js";

/** Every write is scoped, idempotent and fenced. Identity/roles come only from verified transport, never this body. */
const common = { ...scope, requestId: id, ...fenceFields };
const feature = { featureId: id, expectedRev: positive };
const task = { taskId: id, expectedRev: positive, expectedSpecRev: positive };
const execution = { ...task, expectedWorkflowRev: positive };
const askVersion = { askId: id, expectedRev: positive, bindDigest: digest };
const payloads = {
  "feature.new": object({ title: text(300, 1), description: text(16000), homeInstanceId: id }),
  "feature.set": object({ ...feature, title: optional(text(300, 1)), description: optional(text(16000)) }),
  "dag.init": object({ ...feature, baseVersion: literal(0), nodes: array(parseNode), reason: text(2000, 1) }),
  "item.new": object({ featureId: nullable(id), title: text(300, 1), description: text(16000) }),
  "item.set": object({ itemId: id, expectedRev: positive, title: optional(text(300, 1)), description: optional(text(16000)) }),
  "task.new": object({ ...feature, itemId: nullable(id), title: text(300, 1), plan: text(16000), kind: choice(TASK_KINDS), repository, spec: parseTaskSpec }),
  "task.set": object({ ...task, patch: parseTaskPatch }),
  "task.spec": object({ ...task, nextSpecRev: positive, spec: parseTaskSpec, reason: text(2000, 1) }),
  "task.assign": object({ ...execution, executor: parseExecutor, authorizationAskId: nullable(id) }),
  "task.stage": object({ ...execution, from: choice(STAGES), to: choice(STAGES), round: integer, authorizationAskId: nullable(id) }),
  "task.deliver": object({ ...execution, round: integer, orderId: nullable(id), leaseGen: nullable(positive), head, artifactIds: array(id, 100), summary: text(4000) }),
  "task.review": object({ ...execution, round: integer, orderId: nullable(id), leaseGen: nullable(positive), head,
    verdict: choice(["pass", "changes", "block"]), reportArtifactId: id }),
  "dep.set": object({ fromTask: id, toTask: id, expectedRev: integer, kind: choice(["blocks", "branch"]), when: text(2000) }),
  "dep.remove": object({ fromTask: id, toTask: id, expectedRev: positive }),
  "step.assign": object({ ...execution, step: choice(STEPS), round: integer, executor: parseExecutor }),
  "workflow.set": object({ ...execution, ...workflowSettings, authorizationAskId: nullable(id) }),
  "ask.create": object({ featureId: id, taskId: nullable(id), ...askContentFields }),
  "ask.answer": object({ ...askVersion, answer: parseAskAnswer, decision: choice(["approved", "rejected", "acknowledged"]) }),
  "ask.cancel": object({ ...askVersion, reason: text(2000, 1) }),
  "ask.expire": object({ ...askVersion }),
  "authorization.check": object({ ...execution, askId: id, bind: parseAuthorizationBind, action: text(80, 1) }),
  "artifact.put": object({ artifact: parseArtifact }),
  "lease.acquire": object({ ...execution, homeInstanceId: id }),
  "lease.renew": object({ taskId: id, homeInstanceId: id }),
  "lease.release": object({ taskId: id, reason: text(2000, 1) }),
  "intent.create": object({ ...execution, action: choice(executionActions), node: id, operationId: id, head: nullable(head), round: integer,
    dependencyDigest: digest, authorizationAskId: nullable(id), authorizationDigest: nullable(digest), resources: array(parseResourceKey, 100) }),
  "intent.check": object({ ...execution, intentId: id, operationId: id, authorizationAskId: nullable(id), authorizationDigest: nullable(digest) }),
  "intent.cancel": object({ ...execution, intentId: id, operationId: id, reason: text(2000, 1) }),
  "operation.result": object({ result: parseOperationResult }),
  "operation.reconcile": object({ ...execution, intentId: id, operationId: id, result: parseOperationResult, authorizationAskId: id }),
  "lend.create": object({ ...execution, featureId: id, family: choice(["claude", "codex"]), step: choice(["review", "write", "fix"]),
    executorInstanceId: nullable(id), specArtifactId: id, head, round: integer, branch: nullable(branch), base: nullable(branch), grantId: id, grantDigest: digest }),
  "lend.claim": object({ claim: parseLendClaim }),
  "lend.renew": object({ orderId: id, leaseGen: positive, executorInstanceId: id }),
  "lend.result": object({ result: parseLendResult }),
  "lend.cancel": object({ ...execution, orderId: id, leaseGen: integer, reason: text(2000, 1) }),
  "dag.propose": object({ ...feature, ...proposalContentFields }),
  "dag.decide": object({ ...feature, proposalId: id, proposalDigest: digest, baseVersion: positive, askId: id, decision: choice(["approved", "rejected"]) }),
  "dag.bind": object({ ...feature, baseVersion: positive, nodeKey: id, taskId: id }),
  "dag.rewrite": object({ ...feature, baseVersion: integer, dag: parseDag, reason: text(2000, 1) }),
  "home.change": object({ ...feature, nextHomeInstanceId: id, nextEpoch: positive, authorizationAskId: id,
    oldHomeStopped: literal(true), workersSettled: literal(true), lendSettled: literal(true), unknownReconciled: literal(true) }),
  "migration.commit": object({ featureId: id, batchId: id, manifestDigest: digest, authorizationAskId: id }),
} as const;
export type V2CommandName = keyof typeof payloads;
export type V2Command = { [K in V2CommandName]: Infer<ReturnType<typeof base<K>>> & { payload: Infer<typeof payloads[K]> } }[V2CommandName];
function base<K extends V2CommandName>(type: K) { return object({ ...common, type: literal(type) }); }
/** The per-command payload tables contain no actor, role, local process commands or generic execution patch. */
export const V2_COMMAND_SCHEMAS = Object.freeze(Object.fromEntries(Object.entries(payloads).map(([type, payload]) =>
  [type, bounded(refine(object({ ...common, type: literal(type), payload }), c => {
    assertCommandShape(c as V2Command); return true;
  }))]))) as { readonly [K in V2CommandName]: Schema<Extract<V2Command, { type: K }>> };
export const V2_COMMAND_NAMES = Object.freeze(Object.keys(payloads) as V2CommandName[]);
export function parseCommand(value: unknown): V2Command {
  const raw = record(value);
  if (typeof raw.type !== "string" || !Object.hasOwn(V2_COMMAND_SCHEMAS, raw.type)) return fail();
  return V2_COMMAND_SCHEMAS[raw.type as V2CommandName](value);
}
const owners = new Set<V2CommandName>(["ask.answer", "workflow.set", "operation.reconcile", "dag.decide", "home.change", "migration.commit"]);
const members = new Set<V2CommandName>([
  "feature.new", "feature.set", "dag.init", "item.new", "item.set", "task.new", "task.set", "task.spec", "dep.set", "dep.remove", "dag.propose", "dag.rewrite",
]);
/** Necessary role class only; X12 also checks scoped service actions, home, current versions and effective owner bind. */
export const V2_COMMAND_POLICY = Object.freeze(Object.fromEntries(V2_COMMAND_NAMES.map(name => [name, Object.freeze({
  actor: owners.has(name) ? "owner" : members.has(name) ? "member" : "home_or_scoped_service",
  executionOnly: !name.startsWith("feature.") && !name.startsWith("dag.") && !name.startsWith("ask.") && name !== "artifact.put",
})])) as Record<V2CommandName, Readonly<{ actor: "owner" | "member" | "home_or_scoped_service"; executionOnly: boolean }>>);
const parseErrorCode = choice(Object.keys(V2_ERROR_STATUS) as V2ErrorCode[]);
export const parseError = object({ code: parseErrorCode, message: text(2000), requestId: nullable(id) });
export const parseCapability = refine(object({ enabled: boolean, code: nullable(parseErrorCode), reason: text(2000) }),
  c => c.enabled ? c.code === null : c.code !== null && c.reason.length > 0);
export const parseReceipt = object({
  ...scope, schemaVersion: literal(2), serviceGeneration: positive, requestId: id, personId: id, instanceId: id, commandDigest: digest,
  command: choice(V2_COMMAND_NAMES), serverSeq: positive, committedAt: timestamp,
  result: object({ entityId: id, rev: positive, specRev: nullable(positive), version: nullable(integer), epoch: positive, operationId: nullable(id) }),
});
export type V2Receipt = Infer<typeof parseReceipt>;

/** These relations are knowable from the body; live CAS, roles, leases and approval validity stay in the owning transaction. */
function assertCommandShape(c: V2Command): void {
  const p = c.payload;
  if ((c.type === "feature.set" || c.type === "item.set") && !("title" in p || "description" in p)) fail();
  if (c.type === "task.spec" && c.payload.nextSpecRev !== c.payload.expectedSpecRev + 1) fail();
  if (c.type === "home.change" && c.payload.nextEpoch !== c.epoch + 1) fail();
  if (c.type === "task.stage" && c.payload.from === c.payload.to) fail();
  if ((c.type === "dep.set" || c.type === "dep.remove") && c.payload.fromTask === c.payload.toTask) fail();
  if (c.type === "dag.init") parseDag({ version: 1, nodes: c.payload.nodes, bindings: [] });
  if (c.type === "dag.propose") {
    if (c.payload.version !== c.payload.baseVersion + 1) fail();
    parseDag({ version: c.payload.version, nodes: c.payload.nodes, bindings: [] });
  }
  if (c.type === "dag.rewrite" && c.payload.dag.version !== c.payload.baseVersion + 1) fail();
  if ((c.type === "task.deliver" || c.type === "task.review") && (c.payload.orderId === null) !== (c.payload.leaseGen === null)) fail();
  if (c.type === "workflow.set" && c.payload.mode === "auto" && c.payload.authorizationAskId === null) fail();
  if (c.type === "lend.create" && c.payload.step !== "review" && (c.payload.branch === null || c.payload.base === null)) fail();
  if (c.type === "ask.create" && (c.payload.featureId !== c.payload.bind.featureId || c.payload.taskId !== c.payload.bind.taskId)) fail();
  if (c.type === "artifact.put") assertNestedScope(c, c.payload.artifact);
  if (c.type === "lend.claim") assertNestedScope(c, c.payload.claim);
  if (c.type === "lend.result" || c.type === "operation.result" || c.type === "operation.reconcile") assertNestedScope(c, c.payload.result);
  if (c.type === "intent.create") {
    for (const r of c.payload.resources) assertNestedScope(c, r);
    if ((c.payload.authorizationAskId === null) !== (c.payload.authorizationDigest === null)) fail();
    if (["merge", "deploy", "release"].includes(c.payload.action) && c.payload.authorizationAskId === null) fail();
  }
}
function assertNestedScope(c: V2Command, nested: { teamId: string; projectId: string; serviceGeneration?: number; epoch?: number; bootId?: string }): void {
  if (c.teamId !== nested.teamId || c.projectId !== nested.projectId) fail();
  for (const key of ["serviceGeneration", "epoch", "bootId"] as const) if (nested[key] !== undefined && nested[key] !== c[key]) fail();
}
