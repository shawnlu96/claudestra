import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeLendCheckProcess, observeLendCheckResources } from "../src/lib/lend-check-observation.ts";
import { testChildEnv } from "./test-env.ts";

test("process identity is stable across reads and includes an OS start/boot identity", () => {
  const a = observeLendCheckProcess(process.pid), b = observeLendCheckProcess(process.pid);
  expect(a).toEqual(b);
  expect(a.kind).toBe("present");
  if (a.kind === "present") {
    expect(a.process.pid).toBe(process.pid);
    expect(a.process.start).toMatch(/^(darwin|linux):.+:.+$/);
  }
});

test("invalid identities remain unknown rather than being interpreted as a free slot", () => {
  for (const pid of [0, -1, NaN, 1.5, Infinity]) expect(observeLendCheckProcess(pid).kind).toBe("unknown");
});

test("real isolated process exit is observed; no process is killed by observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "check-observation-"));
  const child = Bun.spawn([process.execPath, "--no-env-file", "--config=/dev/null", "-e", 'console.log("ready"); await Bun.stdin.text();'], {
    cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: testChildEnv({ HOME: dir, TMPDIR: dir, CLAUDESTRA_STATE_DIR: join(dir, "state"), CLAUDESTRA_RUNTIME_DIR: join(dir, "runtime") }),
  });
  try {
    await child.stdout.getReader().read();
    expect(observeLendCheckProcess(child.pid).kind).toBe("present");
    child.stdin.end(); await child.exited;
    expect(observeLendCheckProcess(child.pid).kind).toBe("absent");
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; } // Owned fixture only, even if an assertion failed.
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resource snapshot is diagnostic only and has no quota, permit or family decision", () => {
  const observed = observeLendCheckResources();
  expect(observed.sampledAt).toBeGreaterThan(0);
  expect(observed.loadAverage).toHaveLength(3);
  expect(observed.freeMemoryBytes).toBeGreaterThanOrEqual(0);
  expect(observed.totalMemoryBytes).toBeGreaterThan(0);
  expect(Object.keys(observed).sort()).toEqual(["freeMemoryBytes", "loadAverage", "sampledAt", "totalMemoryBytes"]);
});


test("Darwin identity uses immutable boot session, never the wall-clock-dependent boottime", () => {
  const calls: string[][] = [];
  const command = (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("kern.bootsessionuuid")) return "11111111-2222-3333-4444-555555555555";
    if (args.includes("lstart=")) return "Mon Oct  5 12:34:56 2026";
    throw new Error("mutable clock source must not be used");
  };
  const first = observeLendCheckProcess(process.pid, { platform: "darwin", command });
  expect(first).toEqual(observeLendCheckProcess(process.pid, { platform: "darwin", command }));
  expect(first).toEqual({ kind: "present", process: {
    pid: process.pid, start: "darwin:11111111-2222-3333-4444-555555555555:Mon Oct  5 12:34:56 2026",
  } });
  expect(calls).toHaveLength(4);
  expect(calls.some((args) => args.includes("kern.boottime"))).toBe(false);
  expect(observeLendCheckProcess(process.pid, { platform: "darwin", command: () => "invalid" }).kind).toBe("unknown");
});
