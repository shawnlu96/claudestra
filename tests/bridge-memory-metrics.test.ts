import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  analyzeMemory, memoryCounters, memoryValues, parseMemoryPoint, probeMode, type MemoryPoint,
} from "../src/lib/bridge-memory-metrics.ts";
import { memoryProbeMain } from "../scripts/bridge-memory-probe.ts";
import { testChildEnv } from "./test-env.ts";

const SCRIPT = resolve(import.meta.dir, "../scripts/bridge-memory-probe.ts");
const ROOT = resolve(import.meta.dir, "..");
const TOKEN = "a".repeat(64);

function series(kind: "plateau" | "growth" | "rss" = "plateau", length = 10): MemoryPoint[] {
  return Array.from({ length }, (_, i) => ({
    index: i, atMs: 1000 + i * 1000, elapsedMs: i * 1000, uptimeSeconds: i,
    phase: i === 0 ? "baseline" : i < 3 ? "warmup" : "measure", pid: 123, identity: TOKEN,
    memory: memoryValues({ rss: (20 + (kind === "plateau" ? Math.min(i, 2) : i * 4)) * 1024 * 1024,
      heapUsed: (10 + (kind === "growth" ? i * 2 : Math.min(i, 2))) * 1024 * 1024,
      heapTotal: 20 * 1024 * 1024, external: 0, arrayBuffers: 0 }),
    counters: memoryCounters({ bufferedEvents: kind === "growth" ? i * 100 : 500 }),
    host: { freeBytes: null, load1: null, swapUsedBytes: null },
  }));
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mem-probe-test-"));
  for (const part of ["home", "state", "runtime", "tmp"]) mkdirSync(join(dir, part));
  const env = testChildEnv({
    HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), TMP: join(dir, "tmp"), TEMP: join(dir, "tmp"),
    CLAUDESTRA_STATE_DIR: join(dir, "state"), CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime"),
  });
  return { dir, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function cli(args: string[], box: ReturnType<typeof sandbox>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", SCRIPT, ...args], {
    cwd: box.dir, env: box.env, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code, result: JSON.parse(stdout) };
}

describe("memory attribution is numeric and conservative", () => {
  test("default observe; off does not inspect even a nonexistent PID", async () => {
    expect(probeMode(undefined)).toBe("observe");
    expect(probeMode("on")).toBe("on");
    expect(() => probeMode("enable")).toThrow("invalid_mode");
    expect(await memoryProbeMain(["sample", "--pid", "2147483647", "--mode", "off"])).toEqual({ schema: 1, mode: "off", status: "off" });
  });

  test("allowlist drops credentials, paths, names, nonnumeric and negative values", () => {
    const raw = { ...series()[0], secret: "credential", memory: { rss: Infinity, heapUsed: -1, external: 42, text: "/private/secret" } };
    const point = parseMemoryPoint(raw);
    expect(point.memory).toEqual({ rss: null, heapUsed: null, heapTotal: null, external: 42, arrayBuffers: null });
    expect(JSON.stringify(point)).not.toMatch(/credential|private|secret/);
    expect(() => parseMemoryPoint({ ...raw, identity: "/private/path" })).toThrow("invalid_point");
  });

  test("two RSS points are unknown; warmup plateau is not a leak", () => {
    expect(analyzeMemory(series("rss", 2)).classification).toBe("unknown");
    const report = analyzeMemory(series());
    expect(report.classification).toBe("plateau_observed");
    expect(report.baseline?.rss).toBe(20 * 1024 * 1024);
    expect(report.leakProven).toBe(false);
    expect(report.measuredPoints).toBe(7);
  });

  test("retained counts and heap corroborate growth; RSS alone remains unattributed", () => {
    expect(analyzeMemory(series("growth")).classification).toBe("retention_growth_observed");
    expect(analyzeMemory(series("rss")).classification).toBe("rss_growth_unattributed");
    const points = series();
    for (const p of points) p.counters.bufferedEvents = p.index * 100;
    expect(analyzeMemory(points).classification).toBe("retained_counts_growing");
  });

  test("monotonic growth below amplitude tolerance cannot establish a plateau", () => {
    for (const [metric, base, step, interval] of [
      ["rss", 1000 * 1024 * 1024, 3 * 1024 * 1024, 1000],
      ["heapUsed", 10 * 1024 * 1024, 64 * 1024, 25],
    ] as const) {
      const points = series("plateau", 12);
      for (const p of points) {
        p.phase = p.index === 0 ? "baseline" : p.index <= 4 ? "warmup" : "measure";
        p.memory[metric] = base + p.index * step;
        p.elapsedMs = p.index * interval;
      }
      const report = analyzeMemory(points);
      expect(report.memory[metric].kind).toBe("unknown");
      expect(report.memory[metric].perSecond).toBe(step * 1000 / interval);
      expect(report.classification).toBe("unknown");
      expect(report.limitations).toContain("sub_tolerance_growth_requires_longer_window");
      expect(report.limitations).not.toContain("some_runtime_metrics_unavailable");
      expect(report.leakProven).toBe(false);
    }
    const staircase = series();
    for (const p of staircase) p.memory.rss = (1000 + Math.floor(p.index / 2)) * 1024 * 1024;
    expect(analyzeMemory(staircase).classification).toBe("unknown");
  });

  test("heap, external and array buffer growth remain visible without retained counters", () => {
    for (const metric of ["heapUsed", "external", "arrayBuffers"] as const) {
      const points = series();
      for (const p of points) p.memory[metric] = p.index * 2 * 1024 * 1024;
      expect(analyzeMemory(points).classification).toBe("heap_growth_unattributed");
    }
  });

  test("noisy sub-tolerance growth stays unknown while a balanced plateau is observable", () => {
    for (const values of [
      [1000, 1002, 1004, 1003, 1006, 1008, 1007, 1010],
      [1000, 1003, 1002, 1005, 1004, 1007, 1006, 1009],
    ]) {
      for (const metric of ["rss", "heapUsed", "external", "arrayBuffers"] as const) {
        const points = series("plateau", 13);
        for (const p of points) {
          p.phase = p.index === 0 ? "baseline" : p.index <= 4 ? "warmup" : "measure";
          p.memory = memoryValues({ [metric]: values[Math.max(0, p.index - 5)] * 1024 * 1024 });
        }
        const report = analyzeMemory(points);
        expect(report.memory[metric].kind).toBe("unknown");
        expect(report.memory[metric].perSecond).toBeGreaterThan(1024 * 1024);
        expect(report.classification).toBe("unknown");
        expect(report.limitations).toContain("sub_tolerance_growth_requires_longer_window");
        expect(report.leakProven).toBe(false);
      }
    }
    const plateau = series("plateau", 13), values = [1000, 1001, 1000, 1001, 1001, 1000, 1001, 1000];
    for (const p of plateau) {
      p.phase = p.index === 0 ? "baseline" : p.index <= 4 ? "warmup" : "measure";
      p.memory = memoryValues({ rss: values[Math.max(0, p.index - 5)] * 1024 * 1024 });
    }
    expect(analyzeMemory(plateau).classification).toBe("plateau_observed");
    // A final GC dip can erase the endpoint gain while the last third still sits above the first.
    const raisedTail = [1000, 1000, 1000, 1001, 1002, 1003, 1004, 1000];
    for (const p of plateau) p.memory.rss = raisedTail[Math.max(0, p.index - 5)] * 1024 * 1024;
    expect(analyzeMemory(plateau).memory.rss.delta).toBe(0);
    expect(analyzeMemory(plateau).classification).toBe("unknown");
  });

  test("oscillation, missing metrics, gaps, identity replacement and clock reversal stay uncertain", () => {
    const oscillating = series();
    for (const p of oscillating) p.memory.rss = (p.index % 2 ? 100 : 20) * 1024 * 1024;
    expect(analyzeMemory(oscillating).memory.rss.kind).toBe("variable");
    for (const mutate of [
      (p: MemoryPoint) => { p.identity = "b".repeat(64); },
      (p: MemoryPoint) => { p.index += 1; },
      (p: MemoryPoint) => { p.elapsedMs = 0; },
      (p: MemoryPoint) => { p.uptimeSeconds = 0; },
      (p: MemoryPoint) => { p.phase = "warmup"; },
    ]) {
      const points = series(); mutate(points[5]);
      expect(analyzeMemory(points).classification).toBe("unknown");
    }
    const missing = series(); missing[5].memory.heapUsed = null;
    expect(analyzeMemory(missing).memory.heapUsed.kind).toBe("unknown");
  });
});

describe("real isolated processes", () => {
  test("explicit PID + startup identity only; no foreign runtime metrics or secret output", async () => {
    const box = sandbox();
    const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", "setInterval(() => {}, 1000)"], {
      cwd: box.dir, env: box.env, stdout: "ignore", stderr: "ignore",
    });
    try {
      const id = await cli(["identity", "--pid", String(child.pid)], box);
      expect(id.code).toBe(0); expect(id.result.token).toMatch(/^[a-f0-9]{64}$/);
      const sampled = await cli(["sample", "--pid", String(child.pid), "--identity", id.result.token,
        "--count", "8", "--warmup", "0", "--interval-ms", "10"], box);
      expect(sampled.code).toBe(0); expect(sampled.result.points).toHaveLength(8);
      expect(sampled.result.points.every((p: MemoryPoint) => p.pid === child.pid && p.memory.rss! > 0
        && p.memory.heapUsed === null && p.memory.external === null && p.counters.bufferedEvents === null)).toBe(true);
      expect(sampled.stdout).not.toContain(box.dir);
      const mismatch = await cli(["sample", "--pid", String(child.pid), "--identity", TOKEN, "--count", "1"], box);
      expect(mismatch.code).toBe(1); expect(mismatch.result.failure).toBe("identity_changed");
      expect(mismatch.result.points).toEqual([]);
      child.kill(); await child.exited;
      const gone = await cli(["sample", "--pid", String(child.pid), "--identity", id.result.token, "--count", "1"], box);
      expect(gone.code).toBe(1); expect(gone.result.status).toBe("failed");
    } finally {
      if (child.exitCode === null) { child.kill(); await child.exited; }
      box.cleanup();
    }
  }, 15_000);

  test("invalid PID/options and analysis input never echo arbitrary text", async () => {
    const box = sandbox();
    try {
      for (const args of [["identity", "--pid", "-1"], ["identity", "--pid", "1;secret"], ["sample"], ["identity", "--pid", "1", "--pid", "2"]]) {
        const r = await cli(args, box); expect(r.code).toBe(1); expect(r.stdout).not.toContain("secret");
      }
      const path = join(box.dir, "report.json");
      writeFileSync(path, JSON.stringify({ points: series(), body: "secret" }));
      const r = await cli(["analyze", "--input", path], box);
      expect(r.code).toBe(0); expect(r.result.analysis.classification).toBe("plateau_observed");
      expect(r.stdout).not.toContain("secret"); expect(r.stdout).not.toContain(box.dir);
      writeFileSync(path, JSON.stringify({ points: series(), status: "failed", failure: "identity_changed" }));
      const partial = await cli(["analyze", "--input", path], box);
      expect(partial.code).toBe(1); expect(partial.result.sourceFailure).toBe("identity_changed");
      writeFileSync(path, "secret invalid json");
      const bad = await cli(["analyze", "--input", path], box);
      expect(bad.code).toBe(1); expect(bad.stdout).not.toContain("secret");
    } finally { box.cleanup(); }
  }, 15_000);

  test("offline analysis preserves only validated source provenance", async () => {
    const box = sandbox(), path = join(box.dir, "report.json");
    const replayVersion = { commit: "b".repeat(40), dirty: false, eventBusSha256: TOKEN,
      bun: "1.3.14", platform: "darwin", arch: "arm64" };
    try {
      for (const version of ["b".repeat(40), replayVersion]) {
        const provenance = { version, versionSource: "operator_supplied_not_verified", intervalMs: 1000, identityPrecision: "kernel_ticks" };
        writeFileSync(path, JSON.stringify({ points: series(), ...provenance }));
        const r = await cli(["analyze", "--input", path], box);
        expect(r.code).toBe(0);
        expect(r.result).toMatchObject(provenance);
      }
      writeFileSync(path, JSON.stringify({ points: series(), version: { ...replayVersion, secret: box.dir },
        versionSource: box.dir, identityPrecision: box.dir, intervalMs: "secret" }));
      const safe = await cli(["analyze", "--input", path], box);
      expect(safe.result.version).toEqual(replayVersion);
      expect(safe.result.versionSource).toBe("unknown");
      expect(safe.result.identityPrecision).toBe("unknown");
      expect(safe.result.intervalMs).toBeNull();
      expect(safe.stdout).not.toContain(box.dir); expect(safe.stdout).not.toContain("secret");
      writeFileSync(path, JSON.stringify({ points: series(), version: box.dir }));
      expect((await cli(["analyze", "--input", path], box)).result.version).toBeNull();
      writeFileSync(path, JSON.stringify({ points: series(), version: Object.fromEntries(
        Object.keys(replayVersion).map((key) => [key, box.dir])), identityPrecision: ["kernel_ticks"] }));
      const invalid = await cli(["analyze", "--input", path], box);
      expect(Object.values(invalid.result.version).every((v) => v === null)).toBe(true);
      expect(invalid.result.identityPrecision).toBe("unknown");
      expect(invalid.stdout).not.toContain(box.dir);
    } finally { box.cleanup(); }
  }, 15_000);

  test("offline replay/comparison analysis preserves nested interval, failures and safe provenance", async () => {
    const box = sandbox(), path = join(box.dir, "report.json");
    const version = { commit: "b".repeat(40), dirty: false, eventBusSha256: TOKEN,
      bun: "1.3.14", platform: "darwin", arch: "arm64" };
    const worker = { kind: "replay", points: series(), version: { ...version, secret: box.dir },
      workload: { intervalMs: 25, secret: box.dir }, status: "complete", scenario: "steady" };
    try {
      writeFileSync(path, JSON.stringify(worker));
      const single = await cli(["analyze", "--input", path], box);
      expect(single.code).toBe(0);
      expect(single.result.intervalMs).toBe(25);
      expect(single.result.version).toEqual(version);
      expect(single.result.analysis.classification).toBe("plateau_observed");
      const comparison = { kind: "comparison", comparisonScope: "event_bus_only", status: "complete", secret: box.dir,
        workload: worker.workload, runs: [{ side: "old", scenario: "steady", result: worker },
          { side: "new", scenario: "steady", result: { ...worker, points: series("growth") } }] };
      writeFileSync(path, JSON.stringify(comparison));
      const pair = await cli(["analyze", "--input", path], box);
      expect(pair.code).toBe(0);
      expect(pair.result.comparisonScope).toBe("event_bus_only");
      expect(pair.result.productionAttribution).toBe("unknown");
      expect(pair.result.runs).toHaveLength(2);
      expect(pair.result.runs[0].result.intervalMs).toBe(25);
      expect(pair.result.runs[0].result.version).toEqual(version);
      expect(pair.result.runs[0].result.analysis.classification).toBe("plateau_observed");
      expect(pair.result.runs[1].result.analysis.classification).toBe("retention_growth_observed");
      expect(pair.result.limitations).toContain("event_bus_plateau_does_not_establish_bridge_plateau");
      for (const output of [single.stdout, pair.stdout]) {
        expect(output).not.toContain(box.dir); expect(output).not.toContain("secret");
      }
      writeFileSync(path, JSON.stringify({ ...comparison, runs: [comparison.runs[0],
        { side: "new", scenario: "steady", failure: "worker_failed", secret: box.dir }] }));
      const partial = await cli(["analyze", "--input", path], box);
      expect(partial.code).toBe(1);
      expect(partial.result.status).toBe("failed");
      expect(partial.result.runs[0].result.analysis.classification).toBe("plateau_observed");
      expect(partial.result.runs[1].failure).toBe("worker_failed");
      expect(partial.stdout).not.toContain(box.dir);
      writeFileSync(path, JSON.stringify({ ...comparison, runs: [comparison.runs[0],
        { side: "new", scenario: "steady", result: { ...worker, status: "failed", failure: "identity_changed" } }] }));
      const failedChild = await cli(["analyze", "--input", path], box);
      expect(failedChild.code).toBe(1);
      expect(failedChild.result.runs[1].result.sourceFailure).toBe("identity_changed");
      writeFileSync(path, failedChild.stdout);
      const repeated = await cli(["analyze", "--input", path], box);
      expect(repeated.code).toBe(1);
      expect(repeated.result.runs[1].result.sourceFailure).toBe("identity_changed");
      writeFileSync(path, JSON.stringify({ ...comparison, runs: [comparison.runs[0],
        { side: "new", scenario: "steady", failure: box.dir }] }));
      const unknownFailure = await cli(["analyze", "--input", path], box);
      expect(unknownFailure.code).toBe(1);
      expect(unknownFailure.result.runs[1].failure).toBe("probe_failed");
      expect(unknownFailure.stdout).not.toContain(box.dir);
      writeFileSync(path, JSON.stringify({ ...comparison, status: "failed", runs: comparison.runs }));
      expect((await cli(["analyze", "--input", path], box)).code).toBe(1);
      for (const run of [{ side: box.dir, scenario: "steady", result: worker },
        { side: "old", scenario: box.dir, result: worker },
        { side: "old", scenario: "steady", result: { ...worker, points: [{}] } }]) {
        writeFileSync(path, JSON.stringify({ ...comparison, runs: [run] }));
        const invalid = await cli(["analyze", "--input", path], box);
        expect(invalid.code).toBe(1); expect(invalid.stdout).not.toContain(box.dir);
      }
      for (const runs of [[], [comparison.runs[0], comparison.runs[0]], Array(7).fill(comparison.runs[0])]) {
        writeFileSync(path, JSON.stringify({ ...comparison, runs }));
        const invalid = await cli(["analyze", "--input", path], box);
        expect(invalid.result.failure).toBe("invalid_report");
      }
    } finally { box.cleanup(); }
  }, 15_000);

  test("same old/new checkout replays real event bus with bounded and growing controls", async () => {
    const box = sandbox();
    try {
      const r = await cli(["replay", "--old-root", ROOT, "--new-root", ROOT], box);
      expect(r.code).toBe(0); expect(r.result.runs).toHaveLength(6);
      expect(r.result.productionAttribution).toBe("unknown");
      expect(r.result.comparisonScope).toBe("event_bus_only");
      expect(r.result.limitations).toContain("event_bus_plateau_does_not_establish_bridge_plateau");
      expect(r.result.comparisons.every((p: { sameSource: boolean }) => p.sameSource)).toBe(true);
      const pids = new Set<number>();
      for (const run of r.result.runs) {
        const result = run.result;
        expect(result.version.commit).toMatch(/^[a-f0-9]{40}$/);
        expect(result.points).toHaveLength(13);
        expect(result.points[0].phase).toBe("baseline");
        expect(result.points[12].phase).toBe("measure");
        expect(result.points[12].memory.heapUsed).toBeGreaterThan(0);
        expect(result.points[12].counters.subscribers).toBe(0);
        pids.add(result.points[0].pid);
        if (run.scenario === "retention-control") {
          expect(result.analysis.classification).toBe("retention_growth_observed");
          expect(result.analysis.counters.controlObjects.kind).toBe("sustained_growth");
          expect(result.points[12].counters.controlBytes).toBe(24 * 1024 * 1024);
        } else {
          // Bounded event counts cannot prove the runtime settled during this short observation window.
          expect(["plateau_observed", "unknown"]).toContain(result.analysis.classification);
          if (result.analysis.classification === "unknown") {
            expect(result.analysis.limitations).toContain("sub_tolerance_growth_requires_longer_window");
          }
          expect(result.analysis.counters.bufferedEvents.kind).toBe("plateau");
          expect(result.points[12].counters.bufferedEvents).toBe(run.scenario === "steady" ? 2000 : 0);
        }
      }
      expect(pids.size).toBe(6);
      expect(r.stdout).not.toContain(ROOT); expect(r.stdout).not.toContain(box.dir);
      expect(r.stdout).not.toContain("synthetic-0"); expect(r.stderr).toBe("");
      const path = join(box.dir, "comparison.json");
      writeFileSync(path, r.stdout);
      const analyzed = await cli(["analyze", "--input", path], box);
      expect(analyzed.code).toBe(0); expect(analyzed.result.runs).toHaveLength(6);
      for (let i = 0; i < r.result.runs.length; i++) {
        expect(analyzed.result.runs[i].result.analysis).toEqual(r.result.runs[i].result.analysis);
        expect(analyzed.result.runs[i].result.intervalMs).toBe(r.result.workload.intervalMs);
      }
      expect(analyzed.stdout).not.toContain(ROOT); expect(analyzed.stdout).not.toContain(box.dir);
    } finally { box.cleanup(); }
  }, 30_000);
});
