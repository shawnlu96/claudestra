import { liveGrant } from "./lend-grant.js";
import type { LendDeps } from "./lend-drive.js";
import {
  assertFence, fail, parseActor, parseExecutor, parseLendOrder, parseLendLease, parseTask, parseReceipt, timestamp,
  v2ObjectDigest, type V2Actor, type V2Executor, type V2LendOrder, type V2LendLease, type V2Task, type V2Command,
} from "./shared-ledger-contract-v2.js";

/** Supplied by authenticated bridge/journal lookup, never constructed from a worker request body. */
export interface LendCentralBinding {
  order: V2LendOrder; worker: V2Executor; executorInstanceId: string; actor: V2Actor;
  peer: string; fp: string; homeInstanceId: string;
}
export interface LendCentralView { order: V2LendOrder; lease: V2LendLease | null; task: V2Task; now: number }
export type LendCentralGrantDeps = Pick<LendDeps, "readLend" | "context" | "now">;

export function bindingOf(raw: LendCentralBinding): LendCentralBinding {
  const b = structuredClone(raw);
  b.order = parseLendOrder(b.order); b.actor = parseActor(b.actor); b.worker = parseExecutor(b.worker);
  if (b.worker.kind === "human" || b.worker.instanceId !== b.executorInstanceId || !b.fp
    || b.order.homeInstanceId !== b.homeInstanceId || b.actor.kind !== "service"
    || b.actor.orderId !== b.order.orderId || !b.actor.projects.includes(b.order.projectId)
    || b.actor.instanceId !== b.homeInstanceId) return fail("forbidden");
  if (b.order.executorInstanceId !== null && b.order.executorInstanceId !== b.executorInstanceId) return fail("forbidden");
  if (b.order.worker !== null && v2ObjectDigest(b.order.worker) !== v2ObjectDigest(b.worker)) return fail("forbidden");
  return b;
}
export function allowed(b: LendCentralBinding, type: V2Command["type"]): void {
  if (!b.actor.actions.includes(type)) fail("forbidden");
}
export async function grantOf(b: LendCentralBinding, deps: LendCentralGrantDeps) {
  const o = b.order;
  const grant = await liveGrant({ peer: b.peer, fp: b.fp, family: o.family, preview: { repo: o.repository, step: o.step } }, deps);
  if (!grant.ok) return fail("authorization_expired");
  return grant.entry;
}
export function checkView(b: LendCentralBinding, raw: LendCentralView, claimed: boolean): LendCentralView {
  const view = { order: parseLendOrder(raw.order), lease: raw.lease === null ? null : parseLendLease(raw.lease),
    task: parseTask(raw.task), now: timestamp(raw.now) };
  const o = view.order, pinned = b.order, t = view.task;
  checkFence(pinned, o);
  for (const field of ["teamId", "projectId", "orderId", "taskId", "featureId", "homeInstanceId", "specRev", "round", "head",
    "grantId", "grantDigest", "family", "step", "repository", "branch", "base", "pr"] as const) {
    if (o[field] !== pinned[field]) return fail("stale_order");
  }
  if (t.teamId !== o.teamId || t.projectId !== o.projectId || t.id !== o.taskId || t.featureId !== o.featureId
    || t.homeInstanceId !== b.homeInstanceId || t.repository !== o.repository || t.specRev !== o.specRev
    || t.round !== o.round || t.head !== o.head || t.stage !== ({ review: "review", write: "build", fix: "fix" } as const)[o.step]) {
    return fail("stale_order");
  }
  if (!claimed) {
    if (o.status !== "pooled" || o.leaseGen !== pinned.leaseGen
      || (o.executorInstanceId !== null && o.executorInstanceId !== b.executorInstanceId)) return fail("stale_order");
    return view;
  }
  const l = view.lease;
  if (o.status !== "claimed" || !l) return fail("stale_order");
  checkFence(o, l);
  if (o.executorInstanceId !== b.executorInstanceId || v2ObjectDigest(o.worker) !== v2ObjectDigest(b.worker)
    || l.executorInstanceId !== b.executorInstanceId || v2ObjectDigest(l.worker) !== v2ObjectDigest(b.worker)) return fail("forbidden");
  if (l.teamId !== o.teamId || l.projectId !== o.projectId || l.taskId !== o.taskId || l.orderId !== o.orderId
    || l.leaseGen !== o.leaseGen || o.leaseGen !== pinned.leaseGen) return fail("stale_lease_gen");
  if (l.expiresAt <= view.now || (o.leaseUntil ?? 0) <= view.now) return fail("lease_expired");
  return view;
}
export function checkedReceipt(b: LendCentralBinding, command: V2Command, raw: unknown) {
  const r = parseReceipt(raw);
  if (r.teamId !== command.teamId || r.projectId !== command.projectId || r.requestId !== command.requestId
    || r.command !== command.type || r.commandDigest !== v2ObjectDigest(command) || r.personId !== b.actor.personId
    || r.instanceId !== b.actor.instanceId || r.serviceGeneration !== command.serviceGeneration
    || r.result.epoch !== command.epoch || r.result.entityId !== b.order.orderId) return fail("dedup_mismatch");
  if (command.type === "lend.result" && (r.result.operationId !== command.payload.result.operationId
    || r.result.specRev !== command.payload.result.specRev)) return fail("dedup_mismatch");
  return r;
}

function checkFence(a: V2LendOrder, b: V2LendOrder | V2LendLease): void {
  const fence = (v: V2LendOrder | V2LendLease) => ({ serviceGeneration: v.serviceGeneration, epoch: v.epoch, bootId: v.bootId });
  assertFence(fence(a), fence(b));
}

/** A refreshed order snapshot must not silently reinterpret an older outbox entry under new versions. */
export function checkPending(b: LendCentralBinding, c: V2Command, requestId: string): void {
  const o = b.order;
  if (c.type !== "lend.claim" && c.type !== "lend.result") return fail("forbidden");
  const p = c.type === "lend.claim" ? c.payload.claim : c.payload.result;
  if (c.requestId !== requestId || c.teamId !== o.teamId || c.projectId !== o.projectId) return fail("dedup_mismatch");
  assertFence({ serviceGeneration: o.serviceGeneration, epoch: o.epoch, bootId: o.bootId },
    { serviceGeneration: c.serviceGeneration, epoch: c.epoch, bootId: c.bootId });
  for (const field of ["orderId", "taskId", "specRev", "round", "leaseGen"] as const) {
    if (p[field] !== o[field]) return fail("stale_order");
  }
  if (p.executorInstanceId !== b.executorInstanceId || v2ObjectDigest(p.worker) !== v2ObjectDigest(b.worker)) return fail("forbidden");
  if (c.type === "lend.claim") {
    if (c.payload.claim.head !== o.head || c.payload.claim.grantId !== o.grantId
      || c.payload.claim.grantDigest !== o.grantDigest) return fail("stale_order");
  } else if (c.payload.result.expectedHead !== o.head || c.payload.result.operationId !== requestId) return fail("stale_order");
}
