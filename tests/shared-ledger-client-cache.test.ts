import { expect, test } from "bun:test";
import { SharedLedgerCache } from "../src/lib/shared-ledger-cache.js";
const identity = { centerId: "fake-center", teamId: "fake-team", personId: "fake-person", projectId: "fake-project" };
test("cache isolates all identity dimensions, drops late successes and refusals, marks stale", () => {
  const cache = new SharedLedgerCache<{ value: string }>();
  const old = cache.select(identity);
  const original = { value: "original" };
  expect(cache.store(old, original, 10, 100)).toBe(true);
  original.value = "mutated";
  expect(cache.read(30100)?.stale).toBe(false);
  expect(cache.read(30101)?.stale).toBe(true);
  for (const field of ["centerId", "teamId", "personId", "projectId"] as const) {
    const ticket = cache.select({ ...identity, [field]: "different" });
    expect(cache.read()).toBeNull();
    expect(cache.store(old, { value: "late" }, 11)).toBe(false);
    cache.store(ticket, { value: field }, 11, 200);
    cache.invalidate(old);
    expect(cache.read(200)?.value.value).toBe(field);
  }
  const current = cache.select(identity);
  expect(cache.store(old, { value: "late after switching back" }, 12)).toBe(false);
  expect(cache.read(100)?.value.value).toBe("original");
  cache.store(current, { value: "rollback snapshot" }, 2, 200);
  expect(cache.read(200)?.serverSeq).toBe(2);
  cache.store(current, { value: "gap snapshot" }, 100, 300);
  expect(cache.read(300)?.serverSeq).toBe(100);
  cache.invalidate(current);
  expect(cache.read()).toBeNull();
});

test("identity switch aborts the old request signal", () => {
  const cache = new SharedLedgerCache<unknown>();
  const ticket = cache.select(identity);
  expect(ticket.signal.aborted).toBe(false);
  cache.select(identity);
  expect(ticket.signal.aborted).toBe(true);
  const next = cache.select(identity);
  cache.select({ ...identity, personId: "fake-other-person" });
  expect(next.signal.aborted).toBe(true);
  expect(ticket.signal.aborted).toBe(true);
});
