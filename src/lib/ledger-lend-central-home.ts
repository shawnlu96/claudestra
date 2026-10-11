import type { Database } from "bun:sqlite";
import type { LendFamily } from "./lend-config.js";
import type { LendStep } from "./lend-git.js";
import type { LendCentralBinding, LendCentralView } from "./ledger-lend-central-checks.js";
import { assertFence, fail, parseLendLease, parseLendOrder, timestamp, v2ObjectDigest } from "./shared-ledger-contract-v2.js";

/** S2F2: the home's lend_orders row of a central order. It is keyed by the center's order id (the create receipt's entityId),
 * so the existing trusted lookup (the routing port's bindingFor: home row + center view under one id) reads it unchanged.
 * These functions write only the lend_orders row: no ledger event, no task / step / lease row. Callers hold a writable
 * ledger connection (the scheduler process); the bridge's read-only connection is not used here. */
export interface LendCentralHomeOrder {
  taskId: string; project: string; peer: string; family: LendFamily; step: LendStep; specRev: number; round: number; head: string;
  repo: string; pr: number | null; wire: Record<string, unknown>; text: string; sha256: string; leaseMs: number; createdBy: string;
  branch: string | null; base: string | null; supersedes?: string | null;
}
type HomeRow = { orderId: string; taskId: string; project: string; peer: string; step: string; specRev: number; round: number;
  status: string; leaseGen: number; worker: string | null; leaseUntil: number | null };
const homeRow = (db: Database, orderId: string) =>
  db.query("SELECT orderId, taskId, project, peer, step, specRev, round, status, leaseGen, worker, leaseUntil FROM lend_orders WHERE orderId = ?")
    .get(orderId) as HomeRow | null;

/** Writes the pooled home row under the center's order id. A replay with the same order returns "exists" and writes nothing;
 * the same id for another card / peer / step / version, or another live order on the card, is a conflict. */
export function writeLendCentralOrder(db: Database, centerOrderId: string, row: LendCentralHomeOrder, now = Date.now()): "inserted" | "exists" {
  if (!centerOrderId || (row.step !== "review" && (!row.branch || !row.base))) return fail("invalid_field");
  // The wire a lender later claims must name this order, not the home's attempt key.
  if (row.wire.orderId !== centerOrderId) return fail("invalid_field");
  return db.transaction((): "inserted" | "exists" => {
    const old = homeRow(db, centerOrderId);
    if (old) {
      if (old.taskId !== row.taskId || old.project !== row.project || old.peer !== row.peer || old.step !== row.step
        || old.specRev !== row.specRev || old.round !== row.round) return fail("conflict");
      return "exists";
    }
    if (db.query("SELECT 1 FROM lend_orders WHERE taskId = ? AND status IN ('pooled','claimed','unknown') LIMIT 1").get(row.taskId)) return fail("conflict");
    db.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, pr, wire, text, sha256, status, leaseMs,
      supersedes, createdBy, createdAt, updatedAt, branch, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pooled', ?, ?, ?, ?, ?, ?, ?)`).run(
      centerOrderId, row.taskId, row.project, row.peer, row.family, row.step, row.specRev, row.round, row.head, row.repo, row.pr,
      JSON.stringify(row.wire), row.text, row.sha256, row.leaseMs, row.supersedes ?? null, row.createdBy, now, now, row.branch, row.base);
    return "inserted";
  }).immediate();
}

/**
 * E16 ②: after the center confirmed a claim, the home projection of that order becomes claimed (worker, lease generation and
 * lease deadline as the center holds them). `view` is the center's online lend view; it must be the bound order, claimed by
 * the bound executor under a live central lease. The binding's own leaseGen is the pre-claim snapshot and is not compared.
 * Never moves a row backwards: an older generation or a settled row is left as it is (false).
 */
export function projectLendCentralClaim(db: Database, binding: LendCentralBinding, view: LendCentralView, now = Date.now()): boolean {
  const o = parseLendOrder(view.order), lease = view.lease === null ? null : parseLendLease(view.lease), at = timestamp(view.now), b = binding.order;
  const fence = (v: { serviceGeneration: number; epoch: number; bootId: string }) => ({ serviceGeneration: v.serviceGeneration, epoch: v.epoch, bootId: v.bootId });
  for (const field of ["teamId", "projectId", "orderId", "taskId", "featureId", "homeInstanceId", "specRev", "round", "step", "family"] as const) {
    if (o[field] !== b[field]) return fail("stale_order");
  }
  if (o.homeInstanceId !== binding.homeInstanceId || o.status !== "claimed" || !lease || o.worker === null || o.worker.kind === "human") return fail("stale_order");
  assertFence(fence(o), fence(lease));
  if (o.executorInstanceId !== binding.executorInstanceId || lease.executorInstanceId !== binding.executorInstanceId
    || v2ObjectDigest(lease.worker) !== v2ObjectDigest(o.worker)) return fail("forbidden");
  if (lease.orderId !== o.orderId || lease.taskId !== o.taskId || lease.leaseGen !== o.leaseGen) return fail("stale_lease_gen");
  if (lease.expiresAt <= at) return fail("lease_expired");
  const worker = o.worker.agentId;
  return db.transaction((): boolean => {
    const row = homeRow(db, o.orderId);
    if (!row) return fail("not_found");
    if (row.peer !== binding.peer || row.step !== o.step || row.specRev !== o.specRev || row.round !== o.round) return fail("stale_order");
    if (row.status !== "pooled" && row.status !== "claimed") return false;
    if (row.leaseGen > o.leaseGen || (row.status === "claimed" && row.leaseGen === o.leaseGen && row.worker === worker
      && (row.leaseUntil ?? 0) >= lease.expiresAt)) return false;
    return db.prepare(`UPDATE lend_orders SET status = 'claimed', reason = NULL, worker = ?, leaseGen = ?, leaseUntil = ?, updatedAt = ?
      WHERE orderId = ? AND status IN ('pooled','claimed') AND leaseGen <= ?`).run(worker, o.leaseGen, lease.expiresAt, now, o.orderId, o.leaseGen).changes > 0;
  }).immediate();
}

export type LendCentralRoute = (taskId: string) => "local" | "skip" | "central";
/**
 * E16 ②: must the legacy poll / push leave this home order alone? True for every order whose card is not on the local route:
 * a central order is handed out only through the center's claim, and a held (skip) execution card is not dispatched at all.
 * False (local route) means the legacy result is unchanged.
 */
export function lendCentralLegacySkip(order: { taskId: string }, route: LendCentralRoute): boolean {
  return route(order.taskId) !== "local";
}
/** The legacy poll / push candidate list without the orders lendCentralLegacySkip holds back; local-route rows keep their order. */
export function legacyLendOrders<T extends { taskId: string }>(orders: readonly T[], route: LendCentralRoute): T[] {
  return orders.filter(o => !lendCentralLegacySkip(o, route));
}
