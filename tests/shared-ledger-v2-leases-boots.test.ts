import { expect, test } from "bun:test";
import { parseLease, type V2TransactionScope } from "../src/lib/shared-ledger-contract-v2";
import { baseScope, setupLeaseTest } from "./shared-ledger-v2-leases-fixture.test";

type Harness = ReturnType<typeof setupLeaseTest>;
function addTask(h: Harness, taskId: string, featureId = "feature", homeInstanceId = "local") {
  h.transact(ctx => {
    h.put(ctx, "task", taskId, { ...h.get(ctx, "task", "task"), id: taskId, featureId, homeInstanceId });
    h.put(ctx, "workflow", taskId, { rev: 1 });
    if (featureId !== "feature") h.put(ctx, "feature", featureId, {
      ...h.get(ctx, "feature", "feature"), id: featureId, homeInstanceId,
    });
  });
}
function leaseEpoch(h: Harness, taskId: string) {
  return h.transact(ctx => (ctx.all("leases.get", { taskId })[0] as { epoch: number }).epoch);
}
function featureEpoch(h: Harness) {
  return h.transact(ctx => h.get(ctx, "feature", "feature").epoch as number);
}
function rejectedOldBoot(h: Harness, taskId: string, epoch: number) {
  const scope = { epoch, now: 20000 };
  for (const type of ["lease.renew", "lease.release", "lease.acquire"] as const) {
    expect(() => h.apply(type, { taskId }, scope)).toThrow("stale_epoch");
  }
  expect(() => h.transact(ctx => h.domain.assertWritable(ctx, taskId), scope)).toThrow("stale_epoch");
}

test("restarting on one task fences every old task and rejects old boot acquisition of an unseen task", () => {
  const h = setupLeaseTest();
  for (const task of ["task-two", "task-three"]) addTask(h, task);
  addTask(h, "task-other-feature", "other-feature");
  const first = parseLease(h.apply("lease.acquire"));
  const second = parseLease(h.apply("lease.acquire", { taskId: "task-two" }, { epoch: first.epoch }));
  const other = parseLease(h.apply("lease.acquire", { taskId: "task-other-feature" }));
  const fresh = parseLease(h.apply("lease.acquire", {}, { epoch: first.epoch, bootId: "boot-new", now: 2000 }));
  for (const lease of [first, second, other]) {
    rejectedOldBoot(h, lease.taskId, lease.epoch);
    rejectedOldBoot(h, lease.taskId, leaseEpoch(h, lease.taskId));
    expect(leaseEpoch(h, lease.taskId)).toBeGreaterThan(lease.epoch);
  }
  expect(() => h.apply("lease.acquire", { taskId: "task-three" }, { epoch: fresh.epoch })).toThrow("stale_epoch");
  const next = parseLease(h.apply("lease.acquire", { taskId: "task-two" }, {
    epoch: leaseEpoch(h, "task-two"), bootId: "boot-new", now: 2000,
  }));
  expect(next.epoch).toBeGreaterThan(fresh.epoch);
  h.transact(ctx => h.domain.assertWritable(ctx, "task"), { epoch: fresh.epoch, bootId: "boot-new", now: 2000 });
});

test("a new boot's first acquisition on an unseen task retires the home process too", () => {
  const h = setupLeaseTest();
  addTask(h, "task-two");
  const first = parseLease(h.apply("lease.acquire"));
  const fresh = parseLease(h.apply("lease.acquire", { taskId: "task-two" }, { epoch: first.epoch, bootId: "boot-new" }));
  rejectedOldBoot(h, "task", first.epoch);
  rejectedOldBoot(h, "task", leaseEpoch(h, "task"));
  expect(fresh.epoch).toBeGreaterThan(first.epoch);
});

test("retirement is isolated by team, project and home instance", () => {
  const h = setupLeaseTest();
  const scopes: Partial<V2TransactionScope>[] = [
    { projectId: "project-other", actor: { ...baseScope.actor, projects: ["project-other"] } },
    { teamId: "team-other" },
  ];
  for (const scope of scopes) { h.seed(scope); h.apply("lease.acquire", {}, scope); }
  addTask(h, "task-peer", "feature-peer", "peer-a");
  const peer = { actor: { ...baseScope.actor, instanceId: "peer-a" } };
  const peerLease = parseLease(h.apply("lease.acquire", { taskId: "task-peer", homeInstanceId: "peer-a" }, peer));
  const first = parseLease(h.apply("lease.acquire"));
  h.apply("lease.acquire", {}, { epoch: first.epoch, bootId: "boot-new" });
  for (const scope of scopes) h.transact(ctx => h.domain.assertWritable(ctx, "task"), { ...scope, epoch: first.epoch });
  h.transact(ctx => h.domain.assertWritable(ctx, "task-peer"), { ...peer, epoch: peerLease.epoch });
});

test("retirement survives expiry, cancellation and repeated restarts without per-task duplication", () => {
  const h = setupLeaseTest();
  addTask(h, "task-two");
  h.apply("lease.acquire");
  h.apply("lease.acquire", { taskId: "task-two" }, { epoch: featureEpoch(h) });
  for (const bootId of ["boot-new", "boot-newer"]) {
    const lease = parseLease(h.apply("lease.acquire", {}, { epoch: leaseEpoch(h, "task"), bootId, now: 70000 }));
    h.apply("lease.acquire", { taskId: "task-two" }, { epoch: leaseEpoch(h, "task-two"), bootId, now: 70000 });
    h.apply("lease.release", {}, { epoch: lease.epoch, bootId, now: 70000 });
  }
  expect(h.db.query("SELECT count(*) AS n FROM v2_scheduler_boots").get()).toEqual({ n: 3 });
  for (const bootId of ["boot-local", "boot-new"]) {
    expect(() => h.apply("lease.acquire", {}, { epoch: leaseEpoch(h, "task"), bootId, now: 140000 })).toThrow("stale_epoch");
  }
});

test("a failed restart rolls back other features' fences and the boot registry together", () => {
  const h = setupLeaseTest();
  addTask(h, "task-other", "feature-other");
  const first = parseLease(h.apply("lease.acquire"));
  const other = parseLease(h.apply("lease.acquire", { taskId: "task-other" }));
  const scope = { epoch: first.epoch, bootId: "boot-new" };
  expect(() => h.transact(ctx => {
    h.domain.applyInTransaction(ctx, h.command("lease.acquire", {}, scope));
    throw Error("receipt failed");
  }, scope)).toThrow("receipt failed");
  for (const lease of [first, other]) {
    h.transact(ctx => expect(h.domain.assertWritable(ctx, lease.taskId)).toEqual(lease), { epoch: lease.epoch });
  }
  expect(h.db.query("SELECT count(*) AS n FROM v2_scheduler_boots").get()).toEqual({ n: 1 });
});
