import { expect, test } from "bun:test";
import { parseGeneration, parseLease, type V2TransactionScope } from "../src/lib/shared-ledger-contract-v2";
import { readGeneration } from "../src/shared-ledger/leases/generation";
import { baseScope, setupLeaseTest } from "./shared-ledger-v2-leases-fixture.test";

function restoreValue(h: ReturnType<typeof setupLeaseTest>, next = 2, now = 2000) {
  return h.transact(ctx => {
    const previous = readGeneration(ctx)!;
    return parseGeneration({ ...previous, serviceGeneration: next, bootId: "service-restored", state: "frozen", startedAt: now,
      restoredFrom: { serviceGeneration: previous.serviceGeneration, serverSeq: previous.serverSeq, snapshotDigest: "a".repeat(64) },
      restoreReconciledAt: null });
  });
}
test("restore advances the service-wide generation and revokes every project's old lease", () => {
  const h = setupLeaseTest(), lease = parseLease(h.apply("lease.acquire"));
  const other: Partial<V2TransactionScope> = { projectId: "project-other", actor: { ...baseScope.actor, projects: ["project-other"] } };
  h.seed(other); h.apply("lease.acquire", {}, other);
  const restore = restoreValue(h);
  h.transact(ctx => h.generation.restore(ctx, restore), { now: 2000 });
  expect(h.db.query("SELECT count(*) AS n FROM v2_scheduler_leases WHERE active = 1").get()).toEqual({ n: 0 });
  expect(() => h.apply("lease.renew", {}, { epoch: lease.epoch, now: 2000 })).toThrow("stale_generation");
  expect(() => h.apply("home.change", {}, { epoch: lease.epoch, now: 2000 })).toThrow("stale_generation");
  expect(() => h.apply("lease.acquire", {}, { serviceGeneration: 2, epoch: lease.epoch, now: 2000 })).toThrow("migration_blocked");
  h.recovery.reconciled = false;
  expect(() => h.transact(ctx => h.generation.activate(ctx), { serviceGeneration: 2, now: 3000 })).toThrow("unknown_operation");
  h.recovery.reconciled = true;
  const active = h.transact(ctx => h.generation.activate(ctx), { serviceGeneration: 2, now: 3000 });
  expect(active.restoreReconciledAt).toBe(3000);
  expect(() => h.transact(ctx => h.domain.assertWritable(ctx, "task"), { serviceGeneration: 2, epoch: lease.epoch, now: 3000 })).toThrow("stale_generation");
  const fresh = parseLease(h.apply("lease.acquire", {}, { serviceGeneration: 2, epoch: lease.epoch, now: 3000 }));
  expect(fresh.serviceGeneration).toBe(2);
  expect(fresh.epoch).toBeGreaterThan(lease.epoch);
  expect(() => h.apply("lease.renew", {}, { epoch: fresh.epoch, now: 3000 })).toThrow("stale_generation");
});
test("rollback to an old backup cannot reuse a generation previously issued by the service", () => {
  const h = setupLeaseTest();
  h.recovery.highWater = 7;
  expect(() => h.transact(ctx => h.generation.restore(ctx, restoreValue(h, 7)), { now: 2000 })).toThrow("stale_generation");
  const next = restoreValue(h, 8);
  expect(h.transact(ctx => h.generation.restore(ctx, next), { now: 2000 }).serviceGeneration).toBe(8);
  h.transact(ctx => expect(readGeneration(ctx)?.state).toBe("frozen"));
});
test("generation revoke/update rolls back atomically when a later recovery action fails", () => {
  const h = setupLeaseTest(), lease = parseLease(h.apply("lease.acquire")), next = restoreValue(h);
  expect(() => h.transact(ctx => {
    h.generation.restore(ctx, next);
    throw Error("recovery audit failed");
  }, { now: 2000 })).toThrow("recovery audit failed");
  expect(h.recovery.highWater).toBe(2);
  expect(() => h.transact(ctx => h.generation.restore(ctx, next), { now: 2000 })).toThrow("stale_generation");
  h.transact(ctx => {
    expect(readGeneration(ctx)?.serviceGeneration).toBe(1);
    expect(h.domain.assertWritable(ctx, "task")).toEqual(lease);
  }, { epoch: lease.epoch });
});
test("recovery authority and snapshot linkage are required before any global mutation", () => {
  const h = setupLeaseTest(), next = restoreValue(h);
  h.recovery.authorized = false;
  expect(() => h.transact(ctx => h.generation.restore(ctx, next), { now: 2000 })).toThrow("forbidden");
  h.recovery.authorized = true;
  expect(() => h.transact(ctx => h.generation.restore(ctx, { ...next, serviceId: "other" }), { now: 2000 })).toThrow("invalid_field");
  expect(() => h.transact(ctx => h.generation.restore(ctx, { ...next, serverSeq: 2 }), { now: 2000 })).toThrow("invalid_field");
  expect(() => h.transact(ctx => h.generation.activate(ctx))).toThrow("conflict");
  expect(() => h.transact(ctx => h.generation.initialize(ctx, next))).toThrow("conflict");
  h.transact(ctx => expect(readGeneration(ctx)?.serviceGeneration).toBe(1));
});
