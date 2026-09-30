import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSchedulerConfig } from "../src/lib/doctor-scheduler.js";
import { DEFAULT_RESTART_LABELS, parseSchedulerConfig, readSchedulerConfig } from "../src/lib/scheduler-config.js";
import { DAEMONS } from "../src/lib/cli-install.js";


describe("T68 scheduler service configuration", () => {
  test("the fourth daemon installs before launcher and is visible to doctor/update through one list", () => {
    expect(DAEMONS.map((d) => d.stem)).toEqual(["bridge", "cron", "scheduler", "launcher"]);
  });
  test("missing config stays idle, malformed or relative repoDir fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "t68-config-")), path = join(dir, "scheduler.json");
    try {
      expect(readSchedulerConfig(path)).toEqual({ enabled: false, pollMs: 5000, autoDispatch: false, projects: {} });
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "warn" });
      writeFileSync(path, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check", "Guard"], repoDir: "/tmp/project" } } }));
      expect(readSchedulerConfig(path).projects.p.repoDir).toBe("/tmp/project");
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "ok" });
      writeFileSync(path, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "relative" } } }));
      expect(checkSchedulerConfig(path)[0]).toMatchObject({ status: "fail" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("accepts this repo's CI job names and common GitHub name characters verbatim", () => {
    const names = ["typecheck + test + guard", "web typecheck + lint", "desktop typecheck + cargo test", "e2e (macOS) & lint"];
    const cfg = parseSchedulerConfig({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: names, repoDir: "/tmp/project" } } });
    expect(cfg.projects.p.requiredChecks).toEqual(names);
  });
  test("autoDispatch is off unless set to true; any other type is invalid config", () => {
    const projects = { p: { maxActiveWorkers: 1, requiredChecks: ["check"], repoDir: "/tmp/project" } };
    expect(parseSchedulerConfig({ enabled: true, projects }).autoDispatch).toBe(false);
    expect(parseSchedulerConfig({ enabled: true, autoDispatch: false, projects }).autoDispatch).toBe(false);
    expect(parseSchedulerConfig({ enabled: true, autoDispatch: true, projects }).autoDispatch).toBe(true);
    for (const bad of ["true", 1, null, {}]) expect(() => parseSchedulerConfig({ enabled: true, autoDispatch: bad, projects })).toThrow(/autoDispatch/);
  });
  test("deploy (T68g): defaults to the four daemons; bad argv, labels or timeout and a sandbox pointing at production are invalid", () => {
    const p = { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/project" };
    const parse = (deploy: unknown) => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, deploy } } }).projects.p.deploy;
    expect(parse({})).toEqual({ restartLabels: DEFAULT_RESTART_LABELS, timeoutMs: 2_400_000 });
    expect(new Set(DEFAULT_RESTART_LABELS)).toEqual(new Set(DAEMONS.map((d) => d.label)));
    expect(parse({ relayArgv: ["/x/relay.sh"], restartLabels: ["a.b"], timeoutMs: 60_000 })).toEqual({ relayArgv: ["/x/relay.sh"], restartLabels: ["a.b"], timeoutMs: 60_000 });
    for (const bad of [[], { relayArgv: [] }, { relayArgv: "x" }, { restartLabels: ["a b"] }, { timeoutMs: 10 }]) expect(() => parse(bad)).toThrow(/deploy/);
    const prev = process.env.CLAUDESTRA_SANDBOX;
    process.env.CLAUDESTRA_SANDBOX = "1";
    try { expect(() => parse({})).toThrow(/sandbox/); expect(parse({ restartLabels: ["x.fake"] })?.restartLabels).toEqual(["x.fake"]); }
    finally { if (prev === undefined) delete process.env.CLAUDESTRA_SANDBOX; else process.env.CLAUDESTRA_SANDBOX = prev; }
  });
  test("rejects invalid capacity and unknown poll intervals", () => {
    const p = { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: "/tmp/project" };
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, repoDir: undefined } } })).toThrow(/repoDir/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, maxActiveWorkers: 0 } } })).toThrow(/maxActiveWorkers/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, requiredChecks: [] } } })).toThrow(/requiredChecks/);
    for (const bad of ["a\nb", "a\u0000b", "a\u200bb", "a,b", " check", "x".repeat(81)]) {
      expect(() => parseSchedulerConfig({ enabled: true, projects: { p: { ...p, requiredChecks: [bad] } } })).toThrow(/requiredChecks/);
    }
    expect(() => parseSchedulerConfig({ enabled: true, pollMs: 0, projects: {} })).toThrow(/pollMs/);
    expect(() => parseSchedulerConfig({ enabled: true, projects: {} })).toThrow(/at least one project/);
  });
});
