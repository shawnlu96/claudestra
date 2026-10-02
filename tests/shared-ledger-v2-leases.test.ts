import { expect, test } from "bun:test";
import { parseLease, type V2TransactionContext, type V2Lease } from "../src/lib/shared-ledger-contract-v2";
import { baseScope, setupLeaseTest } from "./shared-ledger-v2-leases-fixture.test";

test("only the registered home can acquire; body home cannot impersonate the verified actor", () => {
  const h = setupLeaseTest();
  expect(() => h.apply("lease.acquire", {}, { actor: { ...baseScope.actor, instanceId: "peer-a" } })).toThrow("wrong_home");
  expect(() => h.apply("lease.acquire", { homeInstanceId: "peer-a" })).toThrow("wrong_home");
  const lease = parseLease(h.apply("lease.acquire"));
  expect(lease.epoch).toBe(2);
  expect(h.apply("lease.acquire", {}, { epoch: lease.epoch, now: 2000 })).toEqual(lease);
  expect(() => h.apply("lease.acquire")).toThrow("stale_epoch");
  expect(h.db.query("SELECT count(*) AS n FROM v2_scheduler_leases WHERE active = 1").get()).toEqual({ n: 1 });
});
test("60-second central lease, 15-second renewal schedule, exact expiry rejects reads and renewals", () => {
  const h = setupLeaseTest();
  const lease = parseLease(h.apply("lease.acquire"));
  expect(lease.expiresAt).toBe(61000);
  const renewed = parseLease(h.apply("lease.renew", {}, { epoch: lease.epoch, now: 1000 + h.domain.policy.renewMs }));
  expect(renewed.acquiredAt).toBe(1000);
  expect(renewed.renewedAt).toBe(16000);
  expect(renewed.expiresAt).toBe(76000);
  h.transact(ctx => h.domain.assertWritable(ctx, "task"), { epoch: lease.epoch, now: 75999 });
  expect(() => h.apply("lease.renew", {}, { epoch: lease.epoch, now: 76000 })).toThrow("lease_expired");
  expect(() => h.transact(ctx => h.domain.assertWritable(ctx, "task"), { epoch: lease.epoch, now: 76000 })).toThrow("lease_expired");
  expect(() => h.apply("lease.acquire", { homeInstanceId: "peer-a" }, {
    epoch: lease.epoch, now: 76000, actor: { ...baseScope.actor, instanceId: "peer-a" },
  })).toThrow("wrong_home");
  h.transact(ctx => expect(h.get(ctx, "feature", "feature").homeInstanceId).toBe("local"));
  const fresh = parseLease(h.apply("lease.acquire", {}, { epoch: lease.epoch, now: 76000 }));
  expect(fresh.epoch).toBeGreaterThan(lease.epoch);
});
test("injected timing stays within the frozen DTO; caller timestamps cannot extend a lease", () => {
  const h = setupLeaseTest({ leaseMs: 60, renewMs: 15 });
  expect(parseLease(h.apply("lease.acquire")).expiresAt).toBe(1060);
  expect(() => h.apply("lease.acquire", { now: 900000 })).toThrow("invalid_field");
  expect(() => setupLeaseTest({ leaseMs: 60001 })).toThrow("invalid_field");
});
test("restart replaces the holder, fences old boot/epoch and permanently rejects a retired boot's reacquire", () => {
  const h = setupLeaseTest(), first = parseLease(h.apply("lease.acquire"));
  const second = parseLease(h.apply("lease.acquire", {}, { epoch: first.epoch, bootId: "boot-new", now: 2000 }));
  expect(second.epoch).toBeGreaterThan(first.epoch);
  for (const fence of [{ epoch: first.epoch }, { epoch: second.epoch }, { epoch: first.epoch, bootId: "boot-new" }]) {
    expect(() => h.transact(ctx => h.domain.assertWritable(ctx, "task"), fence)).toThrow("stale_epoch");
    expect(() => h.apply("lease.renew", {}, fence)).toThrow("stale_epoch");
  }
  expect(() => h.apply("lease.acquire", {}, { epoch: second.epoch, now: 3000 })).toThrow("stale_epoch");
  h.transact(ctx => h.domain.assertWritable(ctx, "task"), { epoch: second.epoch, bootId: "boot-new", now: 2000 });
});
test("release consumes an epoch, keeps its tombstone and never revives the released fence", () => {
  const h = setupLeaseTest(), lease = parseLease(h.apply("lease.acquire"));
  const released = h.apply("lease.release", {}, { epoch: lease.epoch });
  expect(released.epoch).toBeGreaterThan(lease.epoch);
  expect(() => h.apply("lease.renew", {}, { epoch: lease.epoch })).toThrow("stale_epoch");
  const next = parseLease(h.apply("lease.acquire", {}, { epoch: released.epoch }));
  expect(next.epoch).toBeGreaterThan(released.epoch);
  expect(() => h.transact(ctx => h.domain.assertWritable(ctx, "task"), { epoch: lease.epoch })).toThrow("stale_epoch");
});
test("home change checks current unknown/worker/lend rows even when the command claims all are settled", () => {
  const h = setupLeaseTest();
  for (const [state, error] of [
    [{ unknownCount: 1, workersSettled: true, lendSettled: true }, "unknown_operation"],
    [{ unknownCount: 0, workersSettled: false, lendSettled: true }, "migration_blocked"],
    [{ unknownCount: 0, workersSettled: true, lendSettled: false }, "migration_blocked"],
  ] as const) {
    h.transact(ctx => h.put(ctx, "settlement", "feature", state));
    expect(() => h.apply("home.change")).toThrow(error);
    h.transact(ctx => expect(h.get(ctx, "feature", "feature").epoch).toBe(1));
  }
  expect(() => h.apply("home.change", { oldHomeStopped: false })).toThrow("invalid_field");
  expect(() => h.apply("home.change", {}, { actor: { ...baseScope.actor, personId: "member" } })).toThrow("forbidden");
});
test("explicit authorized home change revokes all feature leases and advances every task home", () => {
  const h = setupLeaseTest();
  h.transact(ctx => {
    h.put(ctx, "task", "task-two", { ...h.get(ctx, "task", "task"), id: "task-two" });
    h.put(ctx, "workflow", "task-two", { rev: 1 });
  });
  const first = parseLease(h.apply("lease.acquire"));
  const second = parseLease(h.apply("lease.acquire", { taskId: "task-two" }, { epoch: first.epoch }));
  h.transact(ctx => h.domain.assertWritable(ctx, "task"), { epoch: first.epoch });
  const moved = h.apply("home.change", {}, { epoch: second.epoch });
  expect(moved.epoch).toBe(second.epoch + 1);
  expect(h.db.query("SELECT count(*) AS n FROM v2_scheduler_leases WHERE active = 1").get()).toEqual({ n: 0 });
  expect(() => h.apply("lease.renew", {}, { epoch: first.epoch })).toThrow("wrong_home");
  const next = parseLease(h.apply("lease.acquire", { homeInstanceId: "peer-a" }, {
    epoch: moved.epoch, bootId: "boot-peer-a", actor: { ...baseScope.actor, instanceId: "peer-a" },
  }));
  expect(next.epoch).toBeGreaterThan(moved.epoch);
  expect(next.homeInstanceId).toBe("peer-a");
});
test("task CAS, execution mode, scoped actions and immutable scope are checked before mutation", () => {
  const h = setupLeaseTest();
  for (const key of ["expectedRev", "expectedSpecRev", "expectedWorkflowRev"]) {
    expect(() => h.apply("lease.acquire", { [key]: 2 })).toThrow("conflict");
  }
  expect(() => h.apply("lease.acquire", {}, { actor: { ...baseScope.actor, actions: [] } })).toThrow("forbidden");
  h.transact(ctx => h.put(ctx, "feature", "feature", { ...h.get(ctx, "feature", "feature"), authorityMode: "planning" }));
  expect(() => h.apply("lease.acquire")).toThrow("execution_not_shared");
  expect(() => h.transact(ctx => h.domain.applyInTransaction(ctx, { ...h.command("lease.acquire"), projectId: "other" }))).toThrow("forbidden");
});
test("later domain/event/receipt failure rolls back lease, feature epoch and boot retirement together", () => {
  const h = setupLeaseTest(), lease = parseLease(h.apply("lease.acquire"));
  const overrides = { epoch: lease.epoch, bootId: "boot-new", now: 2000 };
  expect(() => h.transact(ctx => {
    h.domain.applyInTransaction(ctx, h.command("lease.acquire", {}, overrides));
    h.put(ctx, "event", "event", { summary: "lease" });
    throw Error("receipt failed");
  }, overrides)).toThrow("receipt failed");
  h.transact(ctx => {
    expect(h.domain.assertWritable(ctx, "task")).toEqual(lease);
    expect(h.get(ctx, "feature", "feature").epoch).toBe(lease.epoch);
    expect(ctx.all("leases.retired", { taskId: "task", candidateBoot: "boot-local" })).toEqual([]);
    expect(() => h.get(ctx, "event", "event")).toThrow("not_found");
  }, { epoch: lease.epoch });
});
test("home move is rolled back with task rows and leases on later failure", () => {
  const h = setupLeaseTest(), lease = parseLease(h.apply("lease.acquire"));
  expect(() => h.transact(ctx => {
    h.domain.applyInTransaction(ctx, h.command("home.change", {}, { epoch: lease.epoch }));
    throw Error("audit failed");
  }, { epoch: lease.epoch })).toThrow("audit failed");
  h.transact(ctx => expect(h.domain.assertWritable(ctx, "task")).toEqual(lease), { epoch: lease.epoch });
});
test("closed/forged contexts cannot read or mutate the lease domain", () => {
  const h = setupLeaseTest();
  let context!: V2TransactionContext;
  h.transact(ctx => { context = ctx; });
  expect(() => h.domain.applyInTransaction(context, h.command("lease.acquire"))).toThrow("transaction_closed");
  expect(() => h.domain.assertWritable({} as V2TransactionContext, "task")).toThrow("transaction_required");
});
test("identical task IDs are isolated by team and project", () => {
  const h = setupLeaseTest(), first = h.apply("lease.acquire") as V2Lease;
  const other = { teamId: "team-other", projectId: "project-other", actor: { ...baseScope.actor, projects: ["project-other"] } };
  h.seed(other);
  const second = h.apply("lease.acquire", {}, other) as V2Lease;
  expect(first.teamId).not.toBe(second.teamId);
  expect(first.epoch).toBe(second.epoch);
  h.apply("lease.release", {}, { epoch: first.epoch });
  h.transact(ctx => expect(h.domain.assertWritable(ctx, "task")).toEqual(second), { ...other, epoch: second.epoch });
});
