import {
  array, branch, choice, digest, fenceFields, head, id, integer, nullable, object, positive,
  refine, repository, scope, text, timestamp, whole, type Infer,
} from "./shared-ledger-contract-v2-validation.js";
import { parseExecutor, type V2Executor } from "./shared-ledger-contract-v2-tasks.js";
const workerMatches = (worker: V2Executor | null, instance: string | null) =>
  worker !== null && worker.kind !== "human" && worker.instanceId === instance;

/** Central order DTOs wrap authority metadata; hello/beat/offer/claim/result wire bodies stay in lend-wire*. */
const orderVersionFields = { orderId: id, taskId: id, specRev: positive, round: integer, head, leaseGen: integer };
export const parseLendOrder = refine(object({
  ...scope, ...orderVersionFields, featureId: id, homeInstanceId: id, executorInstanceId: nullable(id), ...fenceFields,
  family: choice(["claude", "codex"]), step: choice(["review", "write", "fix"]), repository,
  pr: nullable(positive), branch: nullable(branch), base: nullable(branch), specArtifactId: id,
  grantId: id, grantDigest: digest, authorizationAskId: nullable(id),
  status: choice(["pooled", "claimed", "done", "unknown", "cancelled", "released"]),
  worker: nullable(parseExecutor), leaseMs: whole(1, 86400000), leaseUntil: nullable(timestamp),
  resultDigest: nullable(digest), resultOperationId: nullable(id), eventSeq: positive, supersedes: nullable(id),
  createdBy: id, createdAt: timestamp, updatedAt: timestamp, seenAt: nullable(timestamp),
}), o => o.updatedAt >= o.createdAt && (o.status !== "claimed" || (o.worker !== null && o.executorInstanceId !== null
  && o.leaseGen > 0 && o.leaseUntil !== null && workerMatches(o.worker, o.executorInstanceId)))
  && (o.step === "review" || (o.branch !== null && o.base !== null)));
export type V2LendOrder = Infer<typeof parseLendOrder>;
export const parseLendClaim = refine(object({
  ...scope, ...orderVersionFields, ...fenceFields, executorInstanceId: id, worker: parseExecutor,
  grantId: id, grantDigest: digest, claimedAt: timestamp,
}), c => workerMatches(c.worker, c.executorInstanceId));
export type V2LendClaim = Infer<typeof parseLendClaim>;
export const parseLendLease = refine(object({
  ...scope, orderId: id, taskId: id, ...fenceFields, leaseGen: positive, executorInstanceId: id,
  worker: parseExecutor, renewedAt: timestamp, expiresAt: timestamp, leaseMs: whole(1, 86400000),
}), l => l.expiresAt > l.renewedAt && l.expiresAt - l.renewedAt <= l.leaseMs && workerMatches(l.worker, l.executorInstanceId));
export type V2LendLease = Infer<typeof parseLendLease>;
export const parseLendResult = refine(object({
  ...scope, orderId: id, taskId: id, ...fenceFields, specRev: positive, round: integer,
  expectedHead: head, head: head, leaseGen: positive, executorInstanceId: id, worker: parseExecutor,
  operationId: id, resultDigest: digest, verdict: choice(["pass", "changes", "block", "delivered", "failed", "unknown"]),
  summary: text(4000), artifactIds: array(id, 100), observedAt: timestamp,
}), r => workerMatches(r.worker, r.executorInstanceId));
export type V2LendResult = Infer<typeof parseLendResult>;
