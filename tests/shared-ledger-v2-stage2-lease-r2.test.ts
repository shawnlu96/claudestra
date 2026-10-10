import { describe, expect, test } from "bun:test";
import { type Stage2LeaseReceipt } from "../src/lib/scheduler-v2-lease.js";
import { deferred, feature, fixture } from "./shared-ledger-v2-stage2-lease-fixture.js";

describe("stage2 lease shutdown and failure backoff", () => {
  test("stop before first grant bounds hung release by the late grant deadline", async () => {
    const f = fixture(), pending = deferred<Stage2LeaseReceipt>();
    f.respond(async (_feature, type) => type === "lease.acquire" ? pending.promise : new Promise<never>(() => {}));
    const loop = f.start();
    let doneAt: number | null = null;
    void loop.stop().then(() => { doneAt = f.clock.time; });
    await f.clock.advance(1000);
    pending.resolve({ ...f.receipt(feature(), "boot-1"), renewedAt: 1000, expiresAt: 61000, centerNow: 46000 });
    await f.clock.advance(3999);
    expect(loop.current("F")).toBeNull();
    expect(doneAt).toBeNull();
    await f.clock.advance(1);
    const atDeadline = doneAt;
    await f.clock.advance(10_000);
    expect(atDeadline as number | null).toBe(5000);
    expect(f.calls.map(c => [c.type, c.at])).toEqual([["lease.acquire", 0], ["lease.release", 1000]]);
    expect(f.lost).toEqual([]);
  });

  test("stop before an already expired first grant does not await hung release", async () => {
    const f = fixture(), pending = deferred<Stage2LeaseReceipt>();
    f.respond(async (_feature, type) => type === "lease.acquire" ? pending.promise : new Promise<never>(() => {}));
    const loop = f.start();
    let done = false;
    void loop.stop().then(() => { done = true; });
    await f.clock.advance(1000);
    pending.resolve({ ...f.receipt(feature(), "boot-1"), renewedAt: 1000, expiresAt: 61000, centerNow: 51000 });
    await f.clock.advance(0);
    const doneOnReceipt = done;
    await f.clock.advance(10_000);
    expect(doneOnReceipt).toBe(true);
    expect(loop.current("F")).toBeNull();
    expect(f.calls.map(c => c.type)).toEqual(["lease.acquire", "lease.release"]);
  });

  for (const failure of ["timeout", "slow unavailable"] as const) {
    test(failure + " starts acquire backoff when failure is processed", async () => {
      const f = fixture();
      f.respond(async () => failure === "timeout" ? new Promise<never>(() => {})
        : new Promise((_resolve, reject) => { f.clock.schedule(() => reject(new Error("offline")), 8000); }));
      const loop = f.start();
      const duration = failure === "timeout" ? 10_000 : 8000;
      await f.clock.advance(duration * 2 + 14_999);
      const attempts = f.calls.map(c => c.at);
      await f.clock.advance(30_000);
      expect(attempts).toEqual([0, duration + 5000]);
      expect(f.calls.slice(0, 3).map(c => c.at)).toEqual([0, duration + 5000, duration * 2 + 15000]);
      expect(loop.current("F")).toBeNull();
      expect(f.lost).toEqual([]);
      const stopping = loop.stop();
      await f.clock.advance(10_000);
      await stopping;
    });
  }
});
