import {
  assertTransactionContext, fail, id, integer, positive, parseCommand, parseFeature, parseLease, parseTask,
  V2_LEASE_MS, V2_RENEW_MS, type V2DomainModule, type V2Feature, type V2Lease, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { assertCurrentGeneration } from "./generation.js";
import { installLeaseSchema } from "./schema.js";
import type { HomeChange, LeaseCommand, LeaseDependencies } from "./types.js";

interface LeaseRow { featureId: string; epoch: number; active: number; lease: string }
interface Policy { leaseMs: number; renewMs: number }
export type LeaseResult = V2Lease | { featureId: string; homeInstanceId: string; epoch: number } | { taskId: string; epoch: number };

function row(context: V2TransactionContext, taskId: string): LeaseRow | undefined {
  return context.all("leases.get", { taskId: id(taskId) })[0] as LeaseRow | undefined;
}
function featureForTask(context: V2TransactionContext, deps: LeaseDependencies, taskId: string) {
  const task = parseTask(deps.readTask(context, taskId));
  const feature = parseFeature(deps.readFeature(context, task.featureId));
  for (const entity of [task, feature]) {
    if (entity.teamId !== context.scope.teamId || entity.projectId !== context.scope.projectId) fail("not_found");
  }
  if (task.id !== taskId || feature.id !== task.featureId) fail("not_found");
  if (feature.authorityMode !== "execution") fail("execution_not_shared");
  if (task.homeInstanceId !== feature.homeInstanceId) fail("wrong_home");
  return { task, feature };
}
function assertHome(context: V2TransactionContext, home: string): void {
  if (context.scope.actor.instanceId !== home) fail("wrong_home");
}
function assertLease(context: V2TransactionContext, deps: LeaseDependencies, taskId: string): V2Lease {
  assertTransactionContext(context); assertCurrentGeneration(context);
  const { feature } = featureForTask(context, deps, taskId);
  assertHome(context, feature.homeInstanceId);
  const stored = row(context, taskId);
  if (!stored) fail("lease_expired");
  if (stored.featureId !== feature.id) fail("conflict");
  const lease = parseLease(JSON.parse(stored.lease)), s = context.scope;
  if (lease.serviceGeneration !== s.serviceGeneration) fail("stale_generation");
  if (!stored.active || stored.epoch !== s.epoch || lease.epoch !== s.epoch || lease.bootId !== s.bootId) fail("stale_epoch");
  if (lease.homeInstanceId !== feature.homeInstanceId || lease.holderInstanceId !== s.actor.instanceId) fail("wrong_home");
  if (s.now < lease.renewedAt || s.now >= lease.expiresAt) fail("lease_expired");
  return lease;
}
function save(context: V2TransactionContext, featureId: string, lease: V2Lease, active = 1, epoch = lease.epoch): void {
  context.run("leases.put", { taskId: lease.taskId, featureId, nextEpoch: epoch, active, lease: JSON.stringify(parseLease(lease)) });
}
function nextEpoch(context: V2TransactionContext, deps: LeaseDependencies, feature: V2Feature): number {
  const next = positive(feature.epoch + 1);
  deps.advanceFeature(context, feature, next, feature.homeInstanceId);
  return next;
}
function acquire(context: V2TransactionContext, deps: LeaseDependencies, policy: Policy,
  command: Extract<LeaseCommand, { type: "lease.acquire" }>): V2Lease {
  const p = command.payload, s = context.scope, { task, feature } = featureForTask(context, deps, p.taskId);
  assertHome(context, feature.homeInstanceId);
  if (p.homeInstanceId !== feature.homeInstanceId) fail("wrong_home");
  if (task.rev !== p.expectedRev || task.specRev !== p.expectedSpecRev
    || deps.workflowRev(context, task.id) !== p.expectedWorkflowRev) fail("conflict");
  const stored = row(context, task.id), previous = stored ? parseLease(JSON.parse(stored.lease)) : null;
  if (stored && stored.featureId !== feature.id) fail("conflict");
  if (s.epoch !== (stored?.epoch ?? feature.epoch)) fail("stale_epoch");
  if (context.all("leases.retired", { taskId: task.id, candidateBoot: s.bootId }).length) fail("stale_epoch");
  if (previous && s.now < previous.renewedAt) fail("lease_expired");
  if (stored?.active && previous?.serviceGeneration === s.serviceGeneration && previous.bootId === s.bootId && s.now < previous.expiresAt) {
    return assertLease(context, deps, task.id);
  }
  // Every acquisition consumes a fresh epoch, including reacquisition after expiry.
  // The feature epoch is the high-water mark; unrelated task leases retain their own fences.
  const epoch = nextEpoch(context, deps, feature);
  if (previous && previous.bootId !== s.bootId) {
    context.run("leases.retire", { taskId: task.id, retiredBoot: previous.bootId });
  }
  const lease = parseLease({ teamId: s.teamId, projectId: s.projectId, taskId: task.id,
    homeInstanceId: feature.homeInstanceId, holderInstanceId: s.actor.instanceId, serviceGeneration: s.serviceGeneration,
    bootId: s.bootId, epoch, acquiredAt: s.now, renewedAt: s.now, expiresAt: s.now + policy.leaseMs });
  save(context, feature.id, lease);
  return lease;
}
function changeHome(context: V2TransactionContext, deps: LeaseDependencies, command: HomeChange): LeaseResult {
  const p = command.payload, feature = parseFeature(deps.readFeature(context, p.featureId));
  if (feature.id !== p.featureId || feature.teamId !== context.scope.teamId || feature.projectId !== context.scope.projectId) fail("not_found");
  if (feature.authorityMode !== "execution") fail("execution_not_shared");
  if (feature.rev !== p.expectedRev) fail("conflict");
  if (feature.epoch !== command.epoch) fail("stale_epoch");
  if (feature.homeInstanceId === p.nextHomeInstanceId) fail("conflict");
  deps.assertHomeAuthorization(context, command, feature);
  const settled = deps.settlement(context, feature.id);
  if (integer(settled.unknownCount) !== 0) fail("unknown_operation");
  if (settled.workersSettled !== true || settled.lendSettled !== true) fail("migration_blocked");
  deps.advanceFeature(context, feature, p.nextEpoch, p.nextHomeInstanceId);
  context.run("leases.revokeFeature", { featureId: feature.id, nextEpoch: p.nextEpoch });
  return { featureId: feature.id, homeInstanceId: p.nextHomeInstanceId, epoch: p.nextEpoch };
}
function apply(context: V2TransactionContext, deps: LeaseDependencies, policy: Policy, input: LeaseCommand): LeaseResult {
  assertTransactionContext(context);
  const command = parseCommand(input), s = context.scope;
  if (command.teamId !== s.teamId || command.projectId !== s.projectId) fail("forbidden");
  if (command.serviceGeneration !== s.serviceGeneration) fail("stale_generation");
  if (command.epoch !== s.epoch || command.bootId !== s.bootId) fail("stale_epoch");
  if (!s.actor.actions.includes(command.type)) fail("forbidden");
  assertCurrentGeneration(context);
  if (command.type === "home.change") return changeHome(context, deps, command);
  if (command.type === "lease.acquire") return acquire(context, deps, policy, command);
  if (command.type !== "lease.renew" && command.type !== "lease.release") return fail("invalid_field");
  const lease = assertLease(context, deps, command.payload.taskId);
  const { feature } = featureForTask(context, deps, lease.taskId);
  if (command.type === "lease.release") {
    const epoch = nextEpoch(context, deps, feature);
    save(context, feature.id, lease, 0, epoch);
    return { taskId: lease.taskId, epoch };
  }
  if (command.payload.homeInstanceId !== feature.homeInstanceId) fail("wrong_home");
  const renewed = parseLease({ ...lease, renewedAt: s.now, expiresAt: s.now + policy.leaseMs });
  save(context, feature.id, renewed);
  return renewed;
}
export function createLeaseDomain(deps: LeaseDependencies, options: Partial<Policy> = {}) {
  const policy = Object.freeze({ leaseMs: options.leaseMs ?? V2_LEASE_MS, renewMs: options.renewMs ?? V2_RENEW_MS });
  if (positive(policy.leaseMs) > V2_LEASE_MS || positive(policy.renewMs) >= policy.leaseMs) fail("invalid_field");
  const domain: V2DomainModule<LeaseCommand, LeaseResult> = {
    installSchema: installLeaseSchema,
    applyInTransaction: (context, command) => apply(context, deps, policy, command),
  };
  return Object.freeze({ ...domain, policy,
    assertWritable: (context: V2TransactionContext, taskId: string) => assertLease(context, deps, taskId),
  });
}
