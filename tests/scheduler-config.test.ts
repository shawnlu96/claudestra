import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSchedulerConfig } from "../src/lib/doctor-scheduler.js";
import { parseSchedulerConfig, readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { DAEMONS } from "../src/lib/cli-install.js";

const target = { cwd: "/tmp/project", argv: ["bun", "src/manager.ts", "web-release", "deploy"], verifyArgv: ["bun", "src/manager.ts", "doctor", "--json"] };

describe("T68 scheduler service configuration", () => {
  test("the fourth daemon installs before launcher and is visible to doctor/update through one list", () => {
    expect(DAEMONS.map((d) => d.stem)).toEqual(["bridge", "cron", "scheduler", "launcher"]);
  });
  test("missing config stays idle, malformed or unsafe target fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "t68-config-")), path = join(dir, "scheduler.json");
    try {
      expect(readSchedulerConfig(path)).toEqual({ enabled: false, pollMs: 5000, projects: {} });
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "warn" });
      writeFileSync(path, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check", "Guard"], deploy: target } } }));
      expect(readSchedulerConfig(path).projects.p.deploy.argv).toEqual(target.argv);
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "ok" });
      writeFileSync(path, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], deploy: { ...target, cwd: "relative" } } } }));
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "fail" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("rejects empty deploy commands, invalid capacity and unknown poll intervals", () => {
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], deploy: { ...target, argv: [] } } } })).toThrow(/deploy/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 0, requiredChecks: ["check"], deploy: target } } })).toThrow(/maxActiveWorkers/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: [], deploy: target } } })).toThrow(/requiredChecks/);
    expect(() => parseSchedulerConfig({ enabled: true, pollMs: 0, projects: {} })).toThrow(/pollMs/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: {} })).toThrow(/at least one project/);
  });
});
