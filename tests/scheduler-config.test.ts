import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSchedulerConfig } from "../src/lib/doctor-scheduler.js";
import { parseSchedulerConfig, readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { DAEMONS } from "../src/lib/cli-install.js";


describe("T68 scheduler service configuration", () => {
  test("the fourth daemon installs before launcher and is visible to doctor/update through one list", () => {
    expect(DAEMONS.map((d) => d.stem)).toEqual(["bridge", "cron", "scheduler", "launcher"]);
  });
  test("missing config stays idle, malformed or relative repoDir fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "t68-config-")), path = join(dir, "scheduler.json");
    try {
      expect(readSchedulerConfig(path)).toEqual({ enabled: false, pollMs: 5000, projects: {} });
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "warn" });
      writeFileSync(path, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check", "Guard"], repoDir: "/tmp/project" } } }));
      expect(readSchedulerConfig(path).projects.p.repoDir).toBe("/tmp/project");
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "ok" });
      writeFileSync(path, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "relative" } } }));
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "fail" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("rejects an automatic deploy target, invalid capacity and unknown poll intervals", () => {
    const p = { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/project" };
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, deploy: { cwd: "/tmp/project", argv: ["deploy"] } } } }))
      .toThrow(/automatic deploy is not supported/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, repoDir: undefined } } })).toThrow(/repoDir/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, maxActiveWorkers: 0 } } })).toThrow(/maxActiveWorkers/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, requiredChecks: [] } } })).toThrow(/requiredChecks/);
    expect(() => parseSchedulerConfig({ enabled: true, pollMs: 0, projects: {} })).toThrow(/pollMs/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: {} })).toThrow(/at least one project/);
  });
});
