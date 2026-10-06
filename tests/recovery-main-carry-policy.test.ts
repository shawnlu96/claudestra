/** MAINP2 mainCarry switch: read through the one recovery policy file, default observe, any unreadable state is off. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { MAIN_CARRY_KEY, mainCarryMode } from "../src/lib/recovery-main-carry-policy.js";
import { RECOVERY_KEYS, recoveryPolicy, setRecovery } from "../src/lib/recovery-policy.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const policyFile = (data: unknown | string) => {
  const dir = mkdtempSync(join(tmpdir(), "mainp2-policy-")), path = join(dir, "recovery-policy.json");
  dirs.push(dir);
  if (data !== undefined) writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
  return { dir, path, port: (p: string, k: Parameters<typeof recoveryPolicy>[1]) => recoveryPolicy(p, k, path) };
};

describe("MAINP2 mainCarry policy", () => {
  test("registered once as a recovery key", () => {
    expect(MAIN_CARRY_KEY).toBe("mainCarry");
    expect(RECOVERY_KEYS.filter((k) => k === "mainCarry")).toHaveLength(1);
  });
  test("missing file / project = observe (default); key and project overrides; key wins", () => {
    expect(mainCarryMode("p", policyFile(undefined).port)).toEqual({ mode: "observe", source: "default" });
    expect(mainCarryMode("p", policyFile({ projects: { p: { mode: "on" } } }).port)).toEqual({ mode: "on", source: "config" });
    expect(mainCarryMode("p", policyFile({ projects: { p: { mode: "on", keys: { mainCarry: "off" } } } }).port)).toMatchObject({ mode: "off" });
    expect(mainCarryMode("q", policyFile({ projects: { p: { keys: { mainCarry: "on" } } } }).port)).toMatchObject({ mode: "observe" });
  });
  test("corrupt file, unknown key and a throwing port all read as off with a diagnostic", () => {
    expect(mainCarryMode("p", policyFile("{nope").port)).toMatchObject({ mode: "off", source: "error" });
    expect(mainCarryMode("p", policyFile({ projects: { p: { keys: { mainCarryX: "on" } } } }).port)).toMatchObject({ mode: "off", source: "error" });
    expect(mainCarryMode("p", () => { throw new Error("boom"); })).toMatchObject({ mode: "off", diagnostic: expect.stringContaining("boom") });
    expect(mainCarryMode("p", () => ({ mode: "maybe" as never, manualAfterMs: null, source: "config" }))).toMatchObject({ mode: "off" });
  });
  test("set through the existing audited writer (PM), never by default; a non-PM is refused", async () => {
    const f = policyFile(undefined), db = openLedger(join(f.dir, "ledger.sqlite"));
    try {
      db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"pm\"]')").run();
      await expect(setRecovery(db, { actor: "agent-x", now: 1 }, { project: "p", set: { key: "mainCarry", mode: "on" }, reason: "x" }, { path: f.path }))
        .rejects.toThrow(/PM/);
      expect(mainCarryMode("p", f.port).mode).toBe("observe");
      await setRecovery(db, { actor: "pm", now: 2 }, { project: "p", set: { key: "mainCarry", mode: "on" }, reason: "上线观察后打开" }, { path: f.path });
      expect(mainCarryMode("p", f.port)).toEqual({ mode: "on", source: "config" });
    } finally { closeLedger(join(f.dir, "ledger.sqlite")); }
  });
});

describe("MAINP2 auto carry hop limit follows mainCarry", () => {
  test("16 hops only when every project on the repoDir is on; observe / off / unmatched / unreadable stay single-hop", async () => {
    const { writeFileSync: write, rmSync: rm, existsSync } = await import("node:fs");
    const { policyHops } = await import("../src/lib/review-main-carry-manual-auto.js");
    const { SCHEDULER_CONFIG_PATH, parseSchedulerConfig } = await import("../src/lib/scheduler-config.js");
    const { RECOVERY_POLICY_PATH } = await import("../src/lib/recovery-policy.js");
    expect(existsSync(SCHEDULER_CONFIG_PATH) || existsSync(RECOVERY_POLICY_PATH)).toBe(false); // the test guard's private state dir
    const proj = (repoDir: string) => parseSchedulerConfig({ enabled: true, projects: { x: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir } } }).projects.x!;
    try {
      write(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, projects: { p: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/r" },
        q: { maxActiveWorkers: 1, requiredChecks: ["ci"], repoDir: "/r" } } }));
      expect(policyHops(proj("/r"))).toBe(1); // no policy file: observe
      write(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mainCarry: "on" } } } }));
      expect(policyHops(proj("/r"))).toBe(1); // q still observe
      write(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mainCarry: "on" } }, q: { mode: "on" } } }));
      expect(policyHops(proj("/r"))).toBe(16);
      expect(policyHops(proj("/other"))).toBe(1);
      write(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { mainCarry: "on" } }, q: { keys: { mainCarry: "off" } } } }));
      expect(policyHops(proj("/r"))).toBe(1);
      write(SCHEDULER_CONFIG_PATH, "{bad");
      expect(policyHops(proj("/r"))).toBe(1);
    } finally { rm(SCHEDULER_CONFIG_PATH, { force: true }); rm(RECOVERY_POLICY_PATH, { force: true }); }
  });
});
