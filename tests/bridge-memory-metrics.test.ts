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

  test("same old/new checkout replays real event bus with bounded and growing controls", async () => {
    const box = sandbox();
    try {
      const r = await cli(["replay", "--old-root", ROOT, "--new-root", ROOT], box);
      expect(r.code).toBe(0); expect(r.result.runs).toHaveLength(6);
      expect(r.result.productionAttribution).toBe("unknown");
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
          expect(result.analysis.counters.bufferedEvents.kind).toBe("plateau");
          expect(result.points[12].counters.bufferedEvents).toBe(run.scenario === "steady" ? 2000 : 0);
        }
      }
      expect(pids.size).toBe(6);
      expect(r.stdout).not.toContain(ROOT); expect(r.stdout).not.toContain(box.dir);
      expect(r.stdout).not.toContain("synthetic-0"); expect(r.stderr).toBe("");
    } finally { box.cleanup(); }
  }, 30_000);
});
