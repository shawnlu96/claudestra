import { describe, expect, test } from "bun:test";
import { parseCenterDeployConfig, centerScriptPath } from "../src/lib/center-deploy-config.js";

describe("[验收线 7] center deployment configuration", () => {
  test("accepts bounded project configuration", () => {
    expect(parseCenterDeployConfig({ projects: { p: { repo: "a/private", script: "scripts/deploy.sh", dryRunArgs: ["--dry-run"], timeoutMinutes: 20 } } }))
      .toEqual({ p: { repo: "a/private", script: "scripts/deploy.sh", dryRunArgs: ["--dry-run"], timeoutMinutes: 20 } });
  });
  test("rejects traversal, absolute paths, malformed arguments and unbounded timeouts", () => {
    for (const script of ["/tmp/deploy", "../deploy", "scripts/../deploy", "scripts\\deploy", "./deploy", "", "scripts//deploy"]) {
      expect(() => centerScriptPath(script)).toThrow();
    }
    for (const patch of [{ timeoutMinutes: 0 }, { timeoutMinutes: 61 }, { dryRunArgs: [] }, { repo: "https://github.com/a/b" }]) {
      expect(() => parseCenterDeployConfig({ projects: { p: { repo: "a/b", script: "deploy.sh", dryRunArgs: ["--dry-run"], timeoutMinutes: 20, ...patch } } })).toThrow();
    }
  });
});
