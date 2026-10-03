import { parseLendClaim, parseLendLease, parseLendOrder, type V2LendOrder, type V2LendLease } from "../../lib/shared-ledger-contract-v2-lend.js";
import { parseStep } from "../../lib/shared-ledger-contract-v2-tasks.js";
import type { V2TransactionContext } from "../../lib/shared-ledger-contract-v2-transaction.js";
import { v2ObjectDigest } from "../../lib/shared-ledger-contract-v2-integrity.js";
import { fail, positive } from "../../lib/shared-ledger-contract-v2-validation.js";
import { LEASE_MS_DEFAULT } from "../../lib/lend-wire.js";
import {
  assertLiveLease, assertTaskOrder, assertVersions, fenceOf, loadExecution, orderStep, sameWorker, stageFor, synchronous,
  type LendCommand, type LendPorts,
} from "./checks.js";
import { insertLendRow, readLendRow, updateLendOrder } from "./storage.js";

export function saveOrder(context: V2TransactionContext, ports: LendPorts, command: LendCommand, old: V2LendOrder, next: V2LendOrder): V2LendOrder {
  next.updatedAt = context.scope.now;
  next.eventSeq = positive(ports.appendEvent(context, command, parseLendOrder(next)));
  return updateLendOrder(context, old, next);
}
export function createOrder(context: V2TransactionContext, ports: LendPorts, command: Extract<LendCommand, { type: "lend.create" }>): V2LendOrder {
  const p = command.payload, { task, workflow, feature } = loadExecution(context, ports, p.taskId);
  assertVersions({ task, workflow, feature }, p);
  if (p.featureId !== feature.id || p.round !== task.round || task.stage !== stageFor[p.step]
    || (task.head !== p.head && !(p.step === "write" && task.head === null))) fail("stale_order");
  if (context.scope.actor.orderId !== null) fail("forbidden");
  const now = context.scope.now;
  const order = parseLendOrder({
    teamId: command.teamId, projectId: command.projectId, ...fenceOf(command),
    orderId: `lend:${v2ObjectDigest([command.teamId, command.projectId, context.scope.actor.personId, context.scope.actor.instanceId, command.requestId])}`,
    taskId: task.id, featureId: feature.id, homeInstanceId: task.homeInstanceId, executorInstanceId: p.executorInstanceId,
    family: p.family, step: p.step, specRev: p.expectedSpecRev, round: p.round, head: p.head, repository: task.repository,
    branch: p.branch, base: p.base, pr: task.pr, specArtifactId: p.specArtifactId, grantId: p.grantId, grantDigest: p.grantDigest,
    authorizationAskId: null, status: "pooled", worker: null, leaseGen: 0, leaseMs: LEASE_MS_DEFAULT, leaseUntil: null,
    resultDigest: null, resultOperationId: null, eventSeq: 1, supersedes: null,
    createdBy: context.scope.actor.personId, createdAt: now, updatedAt: now, seenAt: null,
  });
  order.eventSeq = positive(ports.appendEvent(context, command, order));
  insertLendRow(context, "order", order);
  return order;
}
function leaseFor(order: V2LendOrder, now: number): V2LendLease {
  return parseLendLease({ teamId: order.teamId, projectId: order.projectId, ...fenceOf(order),
    orderId: order.orderId, taskId: order.taskId, leaseGen: order.leaseGen,
    executorInstanceId: order.executorInstanceId, worker: order.worker, leaseMs: order.leaseMs,
    renewedAt: now, expiresAt: now + order.leaseMs });
}
export function claimOrder(context: V2TransactionContext, ports: LendPorts, command: Extract<LendCommand, { type: "lend.claim" }>, old: V2LendOrder) {
  const claim = command.payload.claim;
  if (old.status !== "pooled") fail("stale_order");
  if (claim.leaseGen !== old.leaseGen + 1) fail("stale_lease_gen");
  if (claim.taskId !== old.taskId || claim.specRev !== old.specRev || claim.head !== old.head || claim.round !== old.round) fail("stale_order");
  if ((old.executorInstanceId !== null && claim.executorInstanceId !== old.executorInstanceId)
    || claim.grantId !== old.grantId || claim.grantDigest !== old.grantDigest) fail("authorization_mismatch");
  const { task } = loadExecution(context, ports, old.taskId); assertTaskOrder(task, old);
  const previous = orderStep(context, ports, old);
  if (previous && previous.state !== "assigned") fail("stale_order");
  const now = context.scope.now;
  const next = parseLendOrder({ ...old, status: "claimed", executorInstanceId: claim.executorInstanceId,
    worker: claim.worker, leaseGen: claim.leaseGen, leaseUntil: now + old.leaseMs, seenAt: now });
  const lease = leaseFor(next, now);
  insertLendRow(context, "claim", parseLendClaim({ ...claim, claimedAt: now }));
  insertLendRow(context, "lease", lease);
  synchronous(ports.writeStep(context, previous, parseStep({
    teamId: old.teamId, projectId: old.projectId, taskId: old.taskId, step: old.step, round: old.round,
    executor: claim.worker, state: "assigned", headFrom: old.head, headTo: null, verdict: null,
    verified: { author: null, independentReviewer: false, verifiedHead: null, evidenceArtifactIds: [] },
    claims: { family: old.family, model: null, summary: "" },
    rev: (previous?.rev ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now,
  })));
  return { order: saveOrder(context, ports, command, old, next), lease, replayed: false };
}
export function renewOrder(context: V2TransactionContext, ports: LendPorts, command: Extract<LendCommand, { type: "lend.renew" }>, old: V2LendOrder) {
  const p = command.payload, now = context.scope.now;
  assertLiveLease(context, old, p.leaseGen, p.executorInstanceId);
  const { task } = loadExecution(context, ports, old.taskId); assertTaskOrder(task, old);
  const previous = readLendRow(context, "lease", old.orderId);
  if (!previous || previous.leaseGen !== old.leaseGen || previous.expiresAt !== old.leaseUntil || !sameWorker(previous.worker, old.worker)) fail("stale_order");
  const lease = leaseFor(old, now);
  if (context.run("lend.lease.update", { orderId: old.orderId, previous: JSON.stringify(previous), body: JSON.stringify(lease) }) !== 1) fail("conflict");
  return { order: saveOrder(context, ports, command, old, { ...old, leaseUntil: lease.expiresAt }), lease, replayed: false };
}
export function cancelOrder(context: V2TransactionContext, ports: LendPorts, command: Extract<LendCommand, { type: "lend.cancel" }>, old: V2LendOrder) {
  const p = command.payload, execution = loadExecution(context, ports, old.taskId);
  assertVersions(execution, p);
  if (p.taskId !== old.taskId || p.expectedSpecRev !== old.specRev) fail("stale_order");
  if (p.leaseGen !== old.leaseGen) fail("stale_lease_gen");
  if (old.status !== "pooled" && old.status !== "claimed" && old.status !== "unknown") fail("stale_order");
  return { order: saveOrder(context, ports, command, old, { ...old, status: "cancelled" }), replayed: false };
}
