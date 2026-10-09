import { afterEach, describe, expect, test } from "bun:test";
import {
  startStage2Leases, type Stage2LeaseClock, type Stage2LeaseFeature, type Stage2LeasePort, type Stage2LeaseReceipt,
} from "../src/lib/scheduler-v2-lease.js";
import { V2ContractError, type V2Fence } from "../src/lib/shared-ledger-contract-v2.js";

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
class Clock implements Stage2LeaseClock {
  time = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => { this.timers.delete(id); };
  }
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await flush();
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = target;
    await flush();
  }
}
type Controller = ReturnType<typeof startStage2Leases>;
const controllers: Controller[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.stop(); });
function feature(id = "F"): Stage2LeaseFeature {
  return { localFeatureId: id, projectId: "local-project", homeInstanceId: "home",
    centerExecution: { centerId: "center", teamId: "team", projectId: "project", centerFeatureId: id, epoch: 1 } };
}
function fixture(bootId: string | undefined = "boot-1") {
  const clock = new Clock();
  let mode: "off" | "observe" | "on" = "on";
  let features = [feature()];
  const calls: { feature: Stage2LeaseFeature; type: string; bootId: string; fence: V2Fence | null; at: number }[] = [];
  const lost: { id: string; reason: string }[] = [];
  const receipt = (f: Stage2LeaseFeature, boot: string): Stage2LeaseReceipt => {
    const centerNow = 1_700_000_000_000 + clock.time;
    return { fence: { serviceGeneration: 7, epoch: f.centerExecution!.epoch, bootId: boot },
      centerNow, renewedAt: centerNow, expiresAt: centerNow + 60_000 };
  };
  let respond: Stage2LeasePort["command"] = async (f, _type, boot) => receipt(f, boot);
  const port: Stage2LeasePort = {
    instanceId: "home", bootId, clock, features: () => features, mode: () => mode,
    async command(f, type, boot, fence) {
      calls.push({ feature: f, type, bootId: boot, fence, at: clock.time });
      return respond(f, type, boot, fence);
    },
    onLost: (id, reason) => { lost.push({ id, reason }); },
    leasePolicy: () => ({ leaseMs: 60_000, renewMs: 15_000, clock: "central" }),
  };
  const start = () => { const controller = startStage2Leases(port); controllers.push(controller); return controller; };
  return { clock, calls, lost, port, start, receipt, setMode: (m: typeof mode) => { mode = m; },
    setFeatures: (fs: Stage2LeaseFeature[]) => { features = fs; },
    respond: (fn: Stage2LeasePort["command"]) => { respond = fn; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("stage2 home leases with fake center and monotonic clock", () => {
  test("acquire at startup, renew every 15 seconds, expose exact center fence, release on stop", async () => {
    const f = fixture(), loop = f.start();
    expect(loop.current("F")).toBeNull();
    await flush();
    expect(loop.current("F")).toEqual({ serviceGeneration: 7, epoch: 1, bootId: "boot-1" });
    const copy = loop.current("F")!;
    copy.epoch = 99;
    expect(loop.current("F")!.epoch).toBe(1);
    await f.clock.advance(60_000);
    expect(f.calls.map(c => [c.type, c.at])).toEqual([
      ["lease.acquire", 0], ["lease.renew", 15000], ["lease.renew", 30000], ["lease.renew", 45000], ["lease.renew", 60000],
    ]);
    expect(f.calls.slice(1).every(c => c.fence?.bootId === "boot-1")).toBe(true);
    expect(f.lost).toEqual([]);
    const stopping = loop.stop();
    expect(loop.current("F")).toBeNull();
    expect(loop.stop()).toBe(stopping);
    await stopping;
    expect(f.calls.at(-1)!.type).toBe("lease.release");
    expect(f.calls.at(-1)!.fence).toEqual({ serviceGeneration: 7, epoch: 1, bootId: "boot-1" });
    await f.clock.advance(120_000);
    expect(f.calls).toHaveLength(6);
    expect(f.lost).toHaveLength(0);
  });

  for (const code of ["stale_epoch", "lease_expired", "stale_generation", "forbidden"] as const) {
    test(code + " loses immediately once and never acquires again", async () => {
      const f = fixture(), loop = f.start();
      await flush();
      f.respond(async (_feature, type) => {
        if (type !== "lease.release") throw new V2ContractError(code);
      });
      await f.clock.advance(15_000);
      expect(loop.current("F")).toBeNull();
      expect(f.lost).toEqual([{ id: "F", reason: code }]);
      await f.clock.advance(120_000);
      expect(loop.current("F")).toBeNull();
      expect(f.lost).toHaveLength(1);
      expect(f.calls.filter(c => c.type === "lease.acquire")).toHaveLength(1);
      expect(f.calls.filter(c => c.type === "lease.renew")).toHaveLength(1);
    });
  }

  test("unavailable preserves the grant through second 49, loses at second 50 without a reader", async () => {
    const f = fixture(), loop = f.start();
    await flush();
    f.respond(async (_feature, type) => {
      if (type !== "lease.release") throw new V2ContractError("unavailable");
    });
    for (let second = 1; second <= 49; second++) {
      await f.clock.advance(1000);
      expect(loop.current("F")).not.toBeNull();
      expect(f.lost).toHaveLength(0);
    }
    await f.clock.advance(1000);
    expect(f.lost).toEqual([{ id: "F", reason: "lease_expired" }]);
    expect(loop.current("F")).toBeNull();
    await f.clock.advance(120_000);
    expect(f.calls.map(c => c.at)).toEqual([0, 15000, 30000, 45000]);
    expect(f.lost).toHaveLength(1);
  });

  test("a hung renewal cannot keep the fence alive or resurrect it with a late grant", async () => {
    const f = fixture(), pending = deferred<Stage2LeaseReceipt>();
    f.port.commandTimeoutMs = 600_000;
    const loop = f.start();
    await flush();
    f.respond(async (feature, type, boot) => type === "lease.renew" ? pending.promise : f.receipt(feature, boot));
    await f.clock.advance(15_000);
    await f.clock.advance(35_000);
    expect(loop.current("F")).toBeNull();
    expect(f.lost).toHaveLength(1);
    pending.resolve(f.receipt(feature(), "boot-1"));
    await flush();
    expect(loop.current("F")).toBeNull();
    await f.clock.advance(120_000);
    expect(f.calls.filter(c => c.type === "lease.renew")).toHaveLength(1);
    expect(f.lost).toHaveLength(1);
  });

  test("current checks the deadline synchronously even if the timer has not run", async () => {
    const f = fixture(), loop = f.start();
    await flush();
    f.clock.time = 50_000;
    expect(loop.current("F")).toBeNull();
    expect(loop.current("F")).toBeNull();
    expect(f.lost).toHaveLength(1);
  });

  test("a delayed initial grant subtracts request latency and expires 10 seconds early", async () => {
    const f = fixture(), pending = deferred<Stage2LeaseReceipt>();
    const grant = f.receipt(feature(), "boot-1");
    f.respond(async (_feature, type) => type === "lease.acquire" ? pending.promise : undefined);
    f.port.commandTimeoutMs = 600_000;
    const loop = f.start();
    await f.clock.advance(20_000);
    expect(loop.current("F")).toBeNull();
    pending.resolve(grant);
    await flush();
    expect(loop.current("F")).not.toBeNull();
    f.clock.time = 50_000;
    expect(loop.current("F")).toBeNull();
    expect(f.lost).toHaveLength(1);
  });

  test("a replayed grant uses the live center sample, never a new full 60-second duration", async () => {
    const f = fixture(), old = f.receipt(feature(), "boot-1");
    const loop = f.start();
    await flush();
    f.respond(async (_feature, type) => type === "lease.release" ? undefined
      : { ...old, centerNow: old.centerNow + f.clock.time });
    await f.clock.advance(49_000);
    expect(loop.current("F")).not.toBeNull();
    await f.clock.advance(1000);
    expect(loop.current("F")).toBeNull();
    expect(f.lost).toHaveLength(1);
  });

  test("initial unavailable backs off from 5 seconds up to 60 and acquires once the center answers", async () => {
    const f = fixture();
    f.respond(async () => { throw new Error("offline"); });
    const loop = f.start();
    await f.clock.advance(120_000);
    expect(loop.current("F")).toBeNull();
    expect(f.calls.map(c => c.at)).toEqual([0, 5000, 15000, 35000, 75000]);
    expect(f.lost).toEqual([]);
    f.respond(async (feature, _type, boot) => f.receipt(feature, boot));
    await f.clock.advance(15_000);
    expect(loop.current("F")).toEqual({ serviceGeneration: 7, epoch: 1, bootId: "boot-1" });
    expect(f.calls.map(c => [c.type, c.at]).slice(5)).toEqual([["lease.acquire", 135000]]);
  });

  test("fresh bootId on restart acquires without reusing a prior fence", async () => {
    const f = fixture(), first = f.start();
    await flush();
    const previous = first.current("F");
    await first.stop();
    f.port.bootId = "boot-2";
    const second = f.start();
    expect(second.current("F")).toBeNull();
    await flush();
    expect(second.current("F")!.bootId).toBe("boot-2");
    expect(second.current("F")).not.toEqual(previous);
    expect(f.calls.at(-1)).toMatchObject({ type: "lease.acquire", bootId: "boot-2", fence: null });
  });

  test("bootId defaults to a fresh generated incarnation", async () => {
    const f = fixture();
    delete f.port.bootId;
    const first = f.start();
    await flush();
    const boot = first.current("F")!.bootId;
    await first.stop();
    const second = f.start();
    await flush();
    expect(second.current("F")!.bootId).not.toBe(boot);
  });

  for (const mode of ["off", "observe"] as const) {
    test(mode + " sends zero center requests, including stop", async () => {
      const f = fixture();
      f.setMode(mode);
      const loop = f.start();
      await f.clock.advance(120_000);
      expect(loop.current("F")).toBeNull();
      await loop.stop();
      expect(f.calls).toHaveLength(0);
      expect(f.lost).toHaveLength(0);
    });
  }
  test("null port has no center calls or fence", async () => {
    const loop = startStage2Leases(null);
    expect(loop.current("F")).toBeNull();
    await loop.stop();
  });

  test("only home centerExecution features without migrating qualify; new features are discovered", async () => {
    const f = fixture();
    f.setFeatures([{ ...feature("other"), homeInstanceId: "peer" },
      { ...feature("planning"), centerExecution: undefined }, { ...feature("migrating"), migrating: { batchId: "batch" } }]);
    f.port.idleTickMs = 1000;
    const loop = f.start();
    await f.clock.advance(30_000);
    expect(f.calls).toHaveLength(0);
    f.setFeatures([feature()]);
    await f.clock.advance(1000);
    expect(loop.current("F")).not.toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  for (const change of ["switch", "home", "epoch", "migrating", "remove"] as const) {
    test(change + " invalidates synchronously and reactivation does not reacquire", async () => {
      const f = fixture(), loop = f.start();
      await flush();
      if (change === "switch") f.setMode("off");
      else if (change === "home") f.setFeatures([{ ...feature(), homeInstanceId: "peer" }]);
      else if (change === "epoch") f.setFeatures([{ ...feature(), centerExecution: { ...feature().centerExecution!, epoch: 2 } }]);
      else if (change === "migrating") f.setFeatures([{ ...feature(), migrating: { batchId: "batch" } }]);
      else f.setFeatures([]);
      expect(loop.current("F")).toBeNull();
      f.setMode("on"); f.setFeatures([feature()]);
      await f.clock.advance(120_000);
      expect(loop.current("F")).toBeNull();
      expect(f.lost).toHaveLength(1);
      expect(f.calls).toHaveLength(1);
    });
  }

  test("switch off while acquire is pending exposes no fence and makes no release request", async () => {
    const f = fixture(), pending = deferred<Stage2LeaseReceipt>();
    f.respond(async () => pending.promise);
    const loop = f.start();
    f.setMode("off");
    expect(loop.current("F")).toBeNull();
    pending.resolve(f.receipt(feature(), "boot-1"));
    await flush();
    await loop.stop();
    expect(f.calls).toHaveLength(1);
    expect(f.lost).toHaveLength(1);
  });

  test("stop during acquire releases the late grant, without ever exposing it", async () => {
    const f = fixture(), pending = deferred<Stage2LeaseReceipt>();
    f.respond(async (_feature, type) => type === "lease.acquire" ? pending.promise : undefined);
    const loop = f.start(), stopped = loop.stop();
    pending.resolve(f.receipt(feature(), "boot-1"));
    await stopped;
    expect(loop.current("F")).toBeNull();
    expect(f.calls.map(c => c.type)).toEqual(["lease.acquire", "lease.release"]);
    expect(f.lost).toHaveLength(0);
  });

  test("losing one feature does not stop another feature's renewals", async () => {
    const f = fixture();
    f.setFeatures([feature("A"), feature("B")]);
    f.respond(async (feature, type, boot) => {
      if (feature.localFeatureId === "A" && type === "lease.renew") throw new V2ContractError("stale_epoch");
      return f.receipt(feature, boot);
    });
    const loop = f.start();
    await f.clock.advance(60_000);
    expect(loop.current("A")).toBeNull();
    expect(loop.current("B")).not.toBeNull();
    expect(f.lost).toEqual([{ id: "A", reason: "stale_epoch" }]);
    expect(f.calls.filter(c => c.feature.localFeatureId === "B" && c.type === "lease.renew")).toHaveLength(4);
  });

  test("temporary unavailability recovers by renew within the original safe deadline", async () => {
    const f = fixture(), loop = f.start();
    await flush();
    f.respond(async (feature, type, boot) => {
      if (type === "lease.renew" && f.clock.time === 15000) throw new Error("connection lost");
      return f.receipt(feature, boot);
    });
    await f.clock.advance(60_000);
    expect(loop.current("F")).not.toBeNull();
    expect(f.lost).toHaveLength(0);
    expect(f.calls.filter(c => c.type === "lease.acquire")).toHaveLength(1);
    expect(f.calls.filter(c => c.type === "lease.renew")).toHaveLength(4);
  });

  for (const mutation of ["boot", "epoch", "duration", "clock", "expired", "missing"] as const) {
    test("invalid acquire " + mutation + " cannot expose a fence", async () => {
      const f = fixture();
      f.respond(async (feature, type, boot) => {
        if (type === "lease.release" || mutation === "missing") return;
        const raw = f.receipt(feature, boot);
        if (mutation === "boot") raw.fence.bootId = "old-boot";
        if (mutation === "epoch") raw.fence.epoch++;
        if (mutation === "duration") raw.expiresAt++;
        if (mutation === "clock") raw.centerNow--;
        if (mutation === "expired") raw.centerNow = raw.expiresAt - 10000;
        return raw;
      });
      const loop = f.start();
      await f.clock.advance(60_000);
      expect(loop.current("F")).toBeNull();
      expect(f.lost).toHaveLength(1);
      expect(f.calls.filter(c => c.type === "lease.acquire")).toHaveLength(1);
    });
  }

  test("a renewal cannot replace the grant with a new generation", async () => {
    const f = fixture(), loop = f.start();
    await flush();
    f.respond(async (feature, type, boot) => {
      const raw = f.receipt(feature, boot);
      if (type === "lease.renew") raw.fence.serviceGeneration++;
      return raw;
    });
    await f.clock.advance(15_000);
    expect(loop.current("F")).toBeNull();
    expect(f.lost).toEqual([{ id: "F", reason: "stale_generation" }]);
  });

  test("pending acquire is sent once even while multiple ticks run", async () => {
    const f = fixture(), pending = deferred<Stage2LeaseReceipt>();
    f.port.commandTimeoutMs = 600_000;
    f.respond(async (_feature, type) => type === "lease.acquire" ? pending.promise : undefined);
    const loop = f.start();
    await f.clock.advance(60_000);
    expect(f.calls).toHaveLength(1);
    pending.resolve({ ...f.receipt(feature(), "boot-1"), centerNow: 1_700_000_000_000,
      renewedAt: 1_700_000_000_000, expiresAt: 1_700_000_060_000 });
    await flush();
    expect(loop.current("F")).toBeNull();
    expect(f.lost).toHaveLength(1);
  });

  test("switching a never-acquired feature on starts its first acquire", async () => {
    const f = fixture();
    f.setMode("observe");
    f.port.idleTickMs = 1000;
    const loop = f.start();
    await f.clock.advance(10_000);
    f.setMode("on");
    await f.clock.advance(1000);
    expect(loop.current("F")).not.toBeNull();
    expect(f.calls.map(c => c.type)).toEqual(["lease.acquire"]);
  });

  test("same epoch never reacquires after loss; a newer center epoch gets a fresh entry and holds", async () => {
    const f = fixture(), loop = f.start();
    await flush();
    f.respond(async (_feature, type) => { if (type === "lease.renew") throw new V2ContractError("stale_epoch"); });
    await f.clock.advance(15_000);
    f.respond(async (feature, _type, boot) => f.receipt(feature, boot));
    await f.clock.advance(60_000);
    expect(f.calls.filter(c => c.type === "lease.acquire")).toHaveLength(1);
    const next = { ...feature(), centerExecution: { ...feature().centerExecution!, epoch: 2 } };
    f.setFeatures([next]);
    await f.clock.advance(10_000);
    expect(loop.current("F")).toEqual({ serviceGeneration: 7, epoch: 2, bootId: "boot-1" });
    expect(f.calls.at(-1)).toMatchObject({ type: "lease.acquire", fence: null, feature: next });
    f.setMode("observe");
    expect(loop.current("F")).toBeNull();
    f.setMode("on");
    await f.clock.advance(60_000);
    expect(loop.current("F")).toBeNull();
    f.setFeatures([{ ...next, centerExecution: { ...next.centerExecution, epoch: 3 } }]);
    await f.clock.advance(10_000);
    expect(loop.current("F")!.epoch).toBe(3);
    expect(f.lost.map(l => l.reason)).toEqual(["stale_epoch", "inactive"]);
    expect(f.calls.filter(c => c.type === "lease.acquire")).toHaveLength(3);
  });

  for (const broken of ["features", "mode"] as const) {
    test(broken + "() throwing suspends the fence, keeps the timer, and resumes renewing within the deadline", async () => {
      const f = fixture(), loop = f.start(), base = { features: f.port.features, mode: f.port.mode };
      await flush();
      const fence = loop.current("F");
      f.port[broken] = () => { throw new Error("port down"); };
      expect(loop.current("F")).toBeNull();
      await f.clock.advance(20_000);
      expect(loop.current("F")).toBeNull();
      expect(f.calls.map(c => c.type)).toEqual(["lease.acquire"]);
      Object.assign(f.port, base);
      expect(loop.current("F")).toEqual(fence);
      await f.clock.advance(60_000);
      expect(loop.current("F")).toEqual(fence);
      expect(f.calls.filter(c => c.type === "lease.renew").length).toBeGreaterThanOrEqual(4);
      expect(f.lost).toEqual([]);
    });
  }

  test("a suspension past the deadline loses the lease and the same epoch is not reacquired", async () => {
    const f = fixture(), loop = f.start(), features = f.port.features;
    await flush();
    f.port.features = () => { throw new Error("port down"); };
    await f.clock.advance(50_000);
    expect(f.lost).toEqual([{ id: "F", reason: "lease_expired" }]);
    f.port.features = features;
    await f.clock.advance(60_000);
    expect(loop.current("F")).toBeNull();
    expect(f.calls.map(c => c.type)).toEqual(["lease.acquire"]);
  });

  test("features() throwing at startup neither throws nor stops the loop", async () => {
    const f = fixture(), features = f.port.features;
    f.port.features = () => { throw new Error("port down"); };
    const loop = f.start();
    await f.clock.advance(30_000);
    expect(f.calls).toHaveLength(0);
    f.port.features = features;
    await f.clock.advance(10_000);
    expect(loop.current("F")).not.toBeNull();
  });

  test("release answering lease_expired still lets stop() resolve", async () => {
    const f = fixture(), loop = f.start();
    await flush();
    f.respond(async () => { throw new V2ContractError("lease_expired"); });
    await loop.stop();
    expect(f.calls.map(c => c.type)).toEqual(["lease.acquire", "lease.release"]);
  });

  test("a hung renewal holds stop() no longer than the grant's deadline", async () => {
    const f = fixture();
    f.port.commandTimeoutMs = Infinity;
    const loop = f.start();
    await flush();
    f.respond(async (_feature, type) => type === "lease.renew" ? new Promise<never>(() => {}) : undefined);
    await f.clock.advance(15_000);
    let done = false;
    void loop.stop().then(() => { done = true; });
    await f.clock.advance(34_000);
    expect(done).toBe(false);
    await f.clock.advance(1000);
    expect(done).toBe(true);
    expect(f.calls.at(-1)!.type).toBe("lease.release");
  });

  test("commands time out after 10 seconds by default: unavailable, and stop() is not held by a hung release", async () => {
    const f = fixture(), loop = f.start();
    await flush();
    f.respond(async () => new Promise<never>(() => {}));
    await f.clock.advance(30_000);
    expect(f.calls.filter(c => c.type === "lease.renew").map(c => c.at)).toEqual([15000, 30000]);
    expect(loop.current("F")).not.toBeNull();
    let done = false;
    void loop.stop().then(() => { done = true; });
    await f.clock.advance(19_000);
    expect(done).toBe(false);
    await f.clock.advance(1000);
    expect(done).toBe(true);
    expect(f.lost).toEqual([]);
  });

  for (const policy of ["missing", "throws", "invalid"] as const) {
    test("leasePolicy " + policy + " never holds, then holds once the center policy is readable", async () => {
      const f = fixture(), read = f.port.leasePolicy;
      f.port.leasePolicy = () => {
        if (policy === "throws") throw new Error("center down");
        return policy === "missing" ? undefined : { leaseMs: 30_000, renewMs: 15_000, clock: "central" };
      };
      const loop = f.start();
      await f.clock.advance(120_000);
      expect(loop.current("F")).toBeNull();
      expect(f.calls).toHaveLength(0);
      f.port.leasePolicy = async () => read();
      await f.clock.advance(60_000);
      expect(loop.current("F")).not.toBeNull();
      expect(f.lost).toEqual([]);
    });
  }

  for (const state of ["no features", "lost"] as const) {
    test("idle with " + state + " polls features() at most 7 times a minute", async () => {
      const f = fixture(), features = f.port.features;
      if (state === "no features") f.setFeatures([]);
      else f.respond(async () => { throw new V2ContractError("forbidden"); });
      const loop = f.start();
      await f.clock.advance(1000);
      let reads = 0;
      f.port.features = () => { reads++; return features(); };
      await f.clock.advance(60_000);
      expect(loop.current("F")).toBeNull();
      expect(reads).toBeLessThanOrEqual(7);
    });
  }
});
