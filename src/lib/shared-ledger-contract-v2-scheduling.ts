import {
  array, choice, digest, distinct, fenceFields, head, id, integer, literal, nullable, object, positive,
  refine, relativePath, repository, scope, text, timestamp, union, type Infer,
} from "./shared-ledger-contract-v2-validation.js";

export const V2_LEASE_MS = 60_000;
export const V2_RENEW_MS = 15_000;
/** All fences are central counters/times. Timeout alone neither moves home nor releases unknown resources. */
export const parseLease = refine(object({
  ...scope, taskId: id, homeInstanceId: id, holderInstanceId: id, ...fenceFields,
  acquiredAt: timestamp, renewedAt: timestamp, expiresAt: timestamp,
}), l => l.holderInstanceId === l.homeInstanceId && l.renewedAt >= l.acquiredAt
  && l.expiresAt > l.renewedAt && l.expiresAt - l.renewedAt <= V2_LEASE_MS);
export type V2Lease = Infer<typeof parseLease>;
const filePath = refine(relativePath, p => !/[*\[\]{}!]/.test(p));
export const parseResourceKey = union(
  object({ ...scope, repository, kind: literal("repository") }),
  object({ ...scope, repository, kind: literal("file"), path: filePath }),
);
export type V2ResourceKey = Infer<typeof parseResourceKey>;
/** A structured key prevents colon/path aliases from introducing cross-project or host-local locks. */
export function resourceKey(key: V2ResourceKey): string {
  const k = parseResourceKey(key);
  return JSON.stringify([k.teamId, k.projectId, k.repository, k.kind, k.kind === "file" ? k.path : null]);
}
export function resourcesOverlap(first: V2ResourceKey, second: V2ResourceKey): boolean {
  const a = parseResourceKey(first), b = parseResourceKey(second);
  return a.teamId === b.teamId && a.projectId === b.projectId && a.repository === b.repository
    && (a.kind === "repository" || b.kind === "repository" || a.path === b.path);
}
export const executionActions = ["dispatch", "stage", "deliver", "review", "merge", "deploy", "release", "pause", "cancel", "verify"] as const;
export const parseIntent = refine(object({
  ...scope, id, taskId: id, homeInstanceId: id, executorInstanceId: nullable(id), ...fenceFields,
  node: id, action: choice(executionActions), operationId: id, taskRev: positive, specRev: positive,
  workflowRev: positive, templateVersion: positive, head: nullable(head), round: integer,
  dependencyDigest: digest, authorizationAskId: nullable(id), authorizationDigest: nullable(digest),
  resources: array(parseResourceKey, 100), causalSeq: integer, eventSeq: positive,
  status: choice(["pending", "submitted", "done", "unknown", "cancelled"]), attempts: integer,
  reason: text(2000), createdAt: timestamp, updatedAt: timestamp,
}), i => i.updatedAt >= i.createdAt && distinct(i.resources, resourceKey)
  && i.resources.every(r => r.teamId === i.teamId && r.projectId === i.projectId)
  && (i.authorizationAskId === null) === (i.authorizationDigest === null)
  && (!["merge", "deploy", "release"].includes(i.action) || i.authorizationAskId !== null));
export type V2Intent = Infer<typeof parseIntent>;
export const parseResource = object({
  key: parseResourceKey, taskId: id, intentId: id, operationId: id, ...fenceFields,
  scope: choice(["intent", "card"]), state: choice(["held", "unknown"]), acquiredAt: timestamp,
});
export type V2Resource = Infer<typeof parseResource>;
export const parseOperationResult = object({
  ...scope, operationId: id, intentId: id, taskId: id, ...fenceFields,
  state: choice(["succeeded", "failed", "unknown"]), head: nullable(head), approvalAskId: nullable(id),
  summary: text(4000), artifactIds: array(id, 100), observedAt: timestamp,
});
export type V2OperationResult = Infer<typeof parseOperationResult>;
export const parseGeneration = refine(object({
  serviceId: id, serviceGeneration: positive, schemaVersion: literal(2), bootId: id,
  state: choice(["frozen", "active"]), serverSeq: integer, startedAt: timestamp,
  restoredFrom: nullable(object({ serviceGeneration: positive, serverSeq: integer, snapshotDigest: digest })),
  restoreReconciledAt: nullable(timestamp),
}), g => g.restoredFrom === null ? g.restoreReconciledAt === null : g.serviceGeneration > g.restoredFrom.serviceGeneration
  && (g.state === "frozen" ? g.restoreReconciledAt === null : g.restoreReconciledAt !== null && g.restoreReconciledAt >= g.startedAt));
export type V2Generation = Infer<typeof parseGeneration>;
export const parseLeasePolicy = object({ leaseMs: literal(V2_LEASE_MS), renewMs: literal(V2_RENEW_MS), clock: literal("central") });
