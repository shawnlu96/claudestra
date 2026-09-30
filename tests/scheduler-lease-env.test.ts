/** T68h scope 1: how a manager / ledger child reads and re-checks the scheduler service's lease (lib/scheduler-lease-env.ts). */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { acquireLock } from "../src/lib/file-lock.js";
import {
  adoptSchedulerLease, assertSchedulerLease, encodeLease, leasedRun, resetSchedulerLeaseForTest, SCHEDULER_LEASE_ENV, schedulerLeaseRefusal,
} from "../src/lib/scheduler-lease-env.js";

const dirs: string[] = [];
afterEach(() => {
  resetSchedulerLeaseForTest();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function twoLocks() {
  const d = mkdtempSync(join(tmpdir(), "t68h-lease-")); dirs.push(d);
  const a = (await acquireLock(join(d, "scheduler.pid"), 0))!, b = (await acquireLock(join(d, "maint.lock"), 0))!;
  return { d, a, b, lease: { singleton: { path: join(d, "scheduler.pid"), token: a.token }, maintenance: { path: join(d, "maint.lock"), token: b.token } } };
}

describe("scheduler lease in a child process", () => {
  test("no lease and no service identity: an ordinary CLI run, every check passes", () => {
    adoptSchedulerLease({});
    expect(leasedRun()).toBe(false);
    expect(() => assertSchedulerLease()).not.toThrow();
  });

  test("the lease is read once and removed from the environment, so nothing this process spawns inherits it", async () => {
    const { lease } = await twoLocks();
    const env: Record<string, string | undefined> = { [SCHEDULER_LEASE_ENV]: encodeLease(lease) };
    adoptSchedulerLease(env);
    expect(env[SCHEDULER_LEASE_ENV]).toBeUndefined();
    expect(leasedRun()).toBe(true);
    expect(schedulerLeaseRefusal()).toBeNull();
  });

  test("either lock lost (released, taken over) fails the check", async () => {
    const one = await twoLocks();
    adoptSchedulerLease({ [SCHEDULER_LEASE_ENV]: encodeLease(one.lease) });
    one.a.release();
    expect(schedulerLeaseRefusal()).toContain("scheduler.pid");
    resetSchedulerLeaseForTest();
    const two = await twoLocks();
    adoptSchedulerLease({ [SCHEDULER_LEASE_ENV]: encodeLease(two.lease) });
    writeFileSync(join(two.d, "maint.lock", "owner"), "update");
    expect(() => assertSchedulerLease()).toThrow("maint.lock");
  });

  test("the service identity without a readable lease fails closed", () => {
    for (const env of [{ CLAUDESTRA_SCHEDULER_SERVICE: "1" }, { [SCHEDULER_LEASE_ENV]: "not json" }, { [SCHEDULER_LEASE_ENV]: "[]" },
      { [SCHEDULER_LEASE_ENV]: JSON.stringify([{ path: "/x" }]) }]) {
      resetSchedulerLeaseForTest();
      adoptSchedulerLease({ ...env });
      expect(schedulerLeaseRefusal()).not.toBeNull();
    }
  });

  test("a readable payload that lacks a lock, names one twice or has the old unnamed shape fails closed (r1 P2-1)", async () => {
    const { lease } = await twoLocks();
    const { singleton, maintenance } = lease;
    for (const payload of [{ v: 1, maintenance }, { v: 1, singleton }, { v: 1, singleton, maintenance: singleton }, { singleton, maintenance },
      [maintenance], [singleton, maintenance]]) {
      resetSchedulerLeaseForTest();
      adoptSchedulerLease({ CLAUDESTRA_SCHEDULER_SERVICE: "1", [SCHEDULER_LEASE_ENV]: JSON.stringify(payload) });
      expect(leasedRun()).toBe(true);
      expect(schedulerLeaseRefusal()).not.toBeNull();
    }
    resetSchedulerLeaseForTest();
    adoptSchedulerLease({ [SCHEDULER_LEASE_ENV]: encodeLease(undefined) });
    expect(schedulerLeaseRefusal()).not.toBeNull();
  });
});
