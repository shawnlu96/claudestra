import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiRateBucket, apiRateBucket, createApiRateLimiter } from "../src/lib/api-rate-bucket.js";
import { ApiRejectCounter, SecondRejectCounter, type RejectCounterObservation } from "../src/lib/api-rate-reject-counter.js";
import { newTokenPrincipal, type Principal } from "../src/lib/principals.js";
import { OWNER_PRINCIPAL_ID } from "../src/lib/devices.js";
import { recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const modePort = (mode: RecoveryMode): RecoveryPolicyPort => () => ({ mode, source: "config", manualAfterMs: null });
const dir = mkdtempSync(join(tmpdir(), "reject-counter-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Inspect retained storage, rather than trusting a reported capacity. */
function arraySizes(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  return [...(Array.isArray(value) ? [value.length] : []), ...Object.values(value).flatMap(arraySizes)];
}

/** Original FIFO expiration, deliberately preserving its behavior under backward timestamps. */
class Baseline {
  hits: number[] = [];
  rejects: number[] = [];
  prune(now: number) {
    for (const queue of [this.hits, this.rejects]) {
      while (queue.length && queue[0]! <= now - 60_000) queue.shift();
    }
  }
  charge(now: number, limit: number): boolean {
    this.prune(now);
    const accepted = this.hits.length < limit;
    (accepted ? this.hits : this.rejects).push(now);
    return accepted;
  }
}

describe("bounded diagnostic storage and expiration", () => {
  test("200,000 simultaneous rejects retain exactly 60 cells; expiration remains bounded", () => {
    const counter = new ApiRejectCounter({ policy: modePort("on") });
    let count = 0;
    for (let i = 0; i < 200_000; i++) count = counter.update(999, true);
    expect(count).toBe(200_000);
    expect(arraySizes(counter)).toEqual([60]);
    expect(counter.update(59_999)).toBe(200_000);
    expect(counter.update(60_000)).toBe(0); // original exact window would retain these until 60,999
    expect(counter.update(10 ** 15)).toBe(0);
    expect(arraySizes(counter)).toEqual([60]);
  });

  test("cross-window stress matches one-second lower-bound semantics with constant storage", () => {
    const counter = new SecondRejectCounter();
    for (let second = 0; second < 180; second++) {
      let count = 0;
      for (let i = 0; i < 2_000; i++) count = counter.update(second * 1_000 + 999, true);
      expect(count).toBe(Math.min(60, second + 1) * 2_000);
      expect(arraySizes(counter)).toEqual([60]);
    }
    expect(counter.update(240_000)).toBe(0);
  });

  test("clock rollback within/across seconds, negative epochs and nonfinite time never resurrect counts", () => {
    const counter = new SecondRejectCounter();
    expect(counter.update(100_999, true)).toBe(1);
    expect(counter.update(100_998)).toBe(0);
    expect(counter.update(100_999)).toBe(0);
    expect(counter.update(-2_001, true)).toBe(1);
    expect(counter.update(-2_000, true)).toBe(2);
    expect(counter.update(57_000)).toBe(1);
    expect(counter.update(58_000)).toBe(0);
    for (const now of [NaN, Infinity, -Infinity]) {
      counter.update(0, true);
      expect(counter.update(now, true)).toBe(0);
      expect(counter.update(0)).toBe(0);
    }
    expect(counter.update(10 ** 15, true)).toBe(1);
    expect(counter.update(0)).toBe(0);
    expect(counter.update(10 ** 15)).toBe(0);
  });

  test("n error is confined to the oldest fractional second", () => {
    const counter = new SecondRejectCounter();
    const rejects = [1, 500, 999, 1_000, 1_001, 59_999];
    for (const now of rejects) counter.update(now, true);
    for (const now of [59_999, 60_000, 60_001, 60_999, 61_000, 119_999, 120_000]) {
      const exact = rejects.filter((t) => t > now - 60_000).length;
      const early = rejects.filter((t) => t > now - 60_000 && t < (Math.floor(now / 1_000) - 59) * 1_000).length;
      expect(counter.update(now)).toBe(exact - early);
    }
  });
});

describe("quota decisions remain the original sliding window", () => {
  for (const mode of ["on", "observe", "off"] as const) {
    test(`${mode}: every decision and capacity change matches original FIFO, including time jumps`, () => {
      const bucket = new ApiRateBucket(120, { policy: modePort(mode), observe: () => {} });
      const baseline = new Baseline();
      const times = [999, 1_000, 59_999, 60_000, 60_999, 61_000, 10 ** 12, 10, -1, 60_010, 120_010];
      for (const [index, now] of times.entries()) {
        bucket.limit = index % 2 ? 600 : 120;
        for (let i = 0; i < 700; i++) expect(bucket.tryAcquire(now)).toBe(baseline.charge(now, bucket.limit));
        expect(bucket.used(now)).toBe(baseline.hits.length);
        if (mode !== "on") expect(bucket.attempts(now)).toBe(baseline.hits.length + baseline.rejects.length);
      }
    });
  }

  test("200,000 real denied requests never expand bucket storage beyond accepted hits plus 60 cells", () => {
    const bucket = new ApiRateBucket(120, { policy: modePort("on") });
    for (let i = 0; i < 120; i++) expect(bucket.tryAcquire(0)).toBe(true);
    let allowed = 0;
    for (let i = 0; i < 200_000; i++) if (bucket.tryAcquire(0)) allowed++;
    expect(allowed).toBe(0);
    expect(bucket.attempts(0)).toBe(200_120);
    expect(arraySizes(bucket).sort((a, b) => a - b)).toEqual([60, 120]);
    expect(bucket.tryAcquire(60_000)).toBe(true);
    expect(bucket.attempts(60_000)).toBe(1);
  });

  test("live on/observe/off switches preserve accepted quota, actual 429 limit and log throttle", () => {
    let mode: RecoveryMode = "on";
    const lines: string[] = [], samples: RejectCounterObservation[] = [];
    const limiter = createApiRateLimiter((line) => lines.push(line), {
      policy: (...args) => modePort(mode)(...args), observe: (sample) => samples.push(sample),
    });
    const owner: Principal = { ...newTokenPrincipal("device-name-secret", ["*"]), id: OWNER_PRINCIPAL_ID, role: "external" };
    const path = "/api/v1/devices/Secret_ID1?token=SECRET&ip=192.168.1.1";
    for (let i = 0; i < 600; i++) expect(limiter.charge(owner, path, 999)).toBeNull();
    for (const next of ["on", "observe", "off", "observe", "on", "off", "on"] as const) {
      mode = next;
      for (let i = 0; i < 10; i++) expect(limiter.charge(owner, path, 1_000)).toEqual({ limit: 600 });
      expect(limiter.buckets.get(apiRateBucket(owner).key)!.used(1_000)).toBe(600);
    }
    expect(lines).toEqual(["[api-rate] 429 who=owner path=/api/v1/devices/:id n=601 limit=600"]);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ op: "recovery_observe", mechanism: "apiRejectCounter", version: "seconds-v1" });
    for (const secret of ["SECRET", "Secret_ID1", "device-name-secret", "192.168.1.1", OWNER_PRINCIPAL_ID, owner.secret!]) {
      expect(JSON.stringify(samples)).not.toContain(secret);
    }
    expect(limiter.charge(owner, path, 60_999)).toBeNull();
    for (let i = 1; i < 600; i++) expect(limiter.charge(owner, path, 60_999)).toBeNull();
    expect(limiter.charge(owner, path, 61_000)).toEqual({ limit: 600 });
    expect(lines).toHaveLength(2);
  });

  test("switching only resets reject representation; off/observe retain the same exact history", () => {
    let mode: RecoveryMode = "off";
    const bucket = new ApiRateBucket(1, { policy: (...args) => modePort(mode)(...args), observe: () => {} });
    bucket.tryAcquire(0);
    for (let i = 0; i < 10; i++) bucket.tryAcquire(0);
    mode = "observe";
    expect(bucket.attempts(0)).toBe(11);
    mode = "off";
    expect(bucket.attempts(0)).toBe(11);
    mode = "on";
    expect(bucket.attempts(0)).toBe(1);
    expect(bucket.tryAcquire(0)).toBe(false);
    expect(bucket.attempts(0)).toBe(2);
    mode = "off";
    expect(bucket.attempts(0)).toBe(1);
    expect(bucket.tryAcquire(0)).toBe(false);
    expect(bucket.attempts(0)).toBe(2);
  });
});

describe("recovery configuration and observation", () => {
  test("missing defaults on; live project/key combinations and upstream keys do not affect decisions", () => {
    const path = join(dir, "policy.json");
    const policy: RecoveryPolicyPort = (project, key) => recoveryPolicy(project, key, path);
    expect(policy("claude-orchestrator", "apiRejectCounter").mode).toBe("on");
    const samples: RejectCounterObservation[] = [];
    const bucket = new ApiRateBucket(1, { policy, observe: (sample) => samples.push(sample) });
    bucket.tryAcquire(500);
    for (const projectMode of [undefined, "on", "observe", "off"] as const) {
      for (const keyMode of [undefined, "on", "observe", "off"] as const) {
        for (const teamBody of ["on", "observe", "off"] as const) {
          writeFileSync(path, JSON.stringify({ projects: { "claude-orchestrator": {
            mode: projectMode, keys: { apiRejectCounter: keyMode, teamBody },
          } } }));
          const effective = keyMode ?? projectMode ?? "on";
          expect(policy("claude-orchestrator", "apiRejectCounter").mode).toBe(effective);
          expect(bucket.tryAcquire(500)).toBe(false);
          expect(bucket.used(500)).toBe(1);
          const arrays = arraySizes(bucket);
          if (effective === "on") expect(arrays).toEqual([1, 60]);
        }
      }
    }
    expect(samples).toHaveLength(1);
    const beforeCorruption = bucket.attempts(500);
    writeFileSync(path, "broken");
    expect(policy("claude-orchestrator", "apiRejectCounter").mode).toBe("off");
    expect(bucket.tryAcquire(500)).toBe(false);
    expect(bucket.attempts(500)).toBe(beforeCorruption + 1);
  });

  test("observer is deduplicated by target/version and never runs off; failure cannot affect quota", () => {
    const samples: RejectCounterObservation[] = [];
    for (let target = 0; target < 2; target++) {
      const bucket = new ApiRateBucket(0, { policy: modePort("observe"), observe: (sample) => samples.push(sample) });
      for (let i = 0; i < 100; i++) expect(bucket.tryAcquire(i)).toBe(false);
    }
    expect(samples).toHaveLength(2);
    expect(samples[0]!.target).not.toBe(samples[1]!.target);
    expect(samples[0]!.version).toBe(samples[1]!.version);
    const broken = new ApiRateBucket(1, { policy: modePort("observe"), observe: () => { throw new Error("output unavailable"); } });
    expect(broken.tryAcquire(0)).toBe(true);
    expect(broken.tryAcquire(0)).toBe(false);
    expect(broken.attempts(0)).toBe(2);
    const off = new ApiRateBucket(0, { policy: modePort("off"), observe: (sample) => samples.push(sample) });
    expect(off.tryAcquire(0)).toBe(false);
    expect(samples).toHaveLength(2);
  });

  test("throwing or error-source policy restores legacy diagnostics without resetting accepted quota", () => {
    let broken = false;
    const bucket = new ApiRateBucket(1, { policy: (...args) => {
      if (broken) throw new Error("unreadable");
      return modePort("on")(...args);
    } });
    expect(bucket.tryAcquire(0)).toBe(true);
    expect(bucket.tryAcquire(0)).toBe(false);
    broken = true;
    expect(bucket.tryAcquire(0)).toBe(false);
    expect(bucket.used(0)).toBe(1);
    expect(bucket.attempts(0)).toBe(2);
    const counter = new ApiRejectCounter({ policy: () => ({ mode: "on", source: "error", manualAfterMs: null }) });
    counter.update(999, true);
    expect(counter.update(60_000)).toBe(1);
  });
});
