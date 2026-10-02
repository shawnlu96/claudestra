import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LauncherRestoreGate } from "../src/lib/launcher-restore-gate.js";
import { acquireLock } from "../src/lib/file-lock.js";

describe("launcher restore gate", () => {
  let root: string;
  let path: string;
  let alerts: string[];
  let logs: string[];
  const make = (alert = async (text: string) => { alerts.push(text); return true; }) =>
    new LauncherRestoreGate({ path, alert, log: (text) => logs.push(text) });
  const dead = (name = "agent-test") => ({ name, status: "dead", cwd: root, created: "creation-1", sessionId: "session-1" });
  const failed = async () => ({ ok: true, out: JSON.stringify({ ok: false, results: [{ ok: false, error: "timeout" }] }) });
  const success = async () => ({ ok: true, out: '{"ok":true}' });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "launcher-restore-gate-"));
    path = join(root, "state.json");
    alerts = []; logs = [];
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("missing cwd skips restart, logs once and survives launcher reconstruction", async () => {
    const agent = { ...dead(), cwd: join(root, "gone") };
    let restarts = 0;
    for (let round = 0; round < 5; round++) {
      const gate = make();
      for (const a of await gate.select([agent])) await gate.restart(a, async () => { restarts++; return success(); });
    }
    expect(restarts).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(alerts[0]).toContain(agent.cwd);
    expect(alerts[0]).toContain(`manager kill ${agent.name}`);
    mkdirSync(agent.cwd);
    expect(await make().select([agent])).toEqual([agent]);
  });

  test("a file in place of cwd is also blocked", async () => {
    const cwd = join(root, "not-directory");
    writeFileSync(cwd, "file");
    expect(await make().select([{ ...dead(), cwd }])).toEqual([]);
    expect(alerts).toHaveLength(1);
  });

  test("filesystem inspection errors do not prevent other agents from recovering", async () => {
    const cwd = join(root, "loop");
    symlinkSync(cwd, cwd);
    const broken = { ...dead("agent-loop"), cwd }, healthy = dead("agent-healthy");
    const gate = make();
    for (let i = 0; i < 3; i++) {
      expect(await gate.select([broken, healthy])).toEqual([broken, healthy]);
      await gate.restart(broken, failed);
    }
    expect(await make().select([broken, healthy])).toEqual([healthy]);
    expect(alerts).toHaveLength(1);
  });

  test("three failures of different kinds stop the fourth round across restarts", async () => {
    const runs = [failed, async () => ({ ok: false, out: "", err: "process crashed" }), async () => { throw new Error("spawn failed"); }];
    const agent = dead();
    for (const run of runs) {
      const gate = make();
      expect(await gate.select([agent])).toEqual([agent]);
      expect(await gate.restart(agent, run)).toBeTruthy();
    }
    for (let i = 0; i < 4; i++) expect(await make().select([agent])).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain(agent.name);
    expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(3);
  });

  test("successful automatic restart resets consecutive failures", async () => {
    const gate = make(), agent = dead();
    await gate.select([agent]);
    await gate.restart(agent, failed);
    await gate.restart(agent, failed);
    expect(await gate.restart(agent, success)).toBeNull();
    await make().restart(agent, failed);
    expect(await make().select([agent])).toEqual([agent]);
    expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(1);
    expect(alerts).toHaveLength(0);
  });

  test.each(["active", "created", "sessionId"])("observed %s change unlocks an agent", async (change) => {
    const agent = dead(), gate = make();
    for (let i = 0; i < 3; i++) await gate.restart(agent, failed);
    expect(await make().select([agent])).toEqual([]);
    const next = change === "active" ? agent : { ...agent, [change]: "new-generation" };
    if (change === "active") expect(await make().select([{ ...agent, status: "active" }])).toEqual([]);
    expect(await make().select([next])).toEqual([next]);
    await make().restart(next, failed);
    expect(await make().select([next])).toEqual([next]);
    expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(1);
  });

  test("removal retires the old gate; other healthy dead agents are unaffected", async () => {
    const blocked = dead("agent-blocked"), healthy = dead("agent-healthy");
    const gate = make();
    for (let i = 0; i < 3; i++) await gate.restart(blocked, failed);
    expect(await gate.select([blocked, healthy, { ...dead("agent-alive"), status: "active" }])).toEqual([healthy]);
    expect(await gate.restart(healthy, success)).toBeNull();
    await gate.select([]);
    expect(await make().select([blocked])).toEqual([blocked]);
  });

  test("restoring cwd does not unlock a three-failure stop", async () => {
    const agent = dead(), gate = make();
    for (let i = 0; i < 3; i++) await gate.restart(agent, failed);
    expect(await make().select([agent])).toEqual([]);
  });

  test("concurrent missing-cwd inspections claim only one alert", async () => {
    const agent = { ...dead(), cwd: join(root, "missing") };
    const results = await Promise.all([make().select([agent]), make().select([agent])]);
    expect(results).toEqual([[], []]);
    expect(alerts).toHaveLength(1);
  });

  test("failed alert delivery never enables a restart or repeats on launcher restart", async () => {
    const agent = { ...dead(), cwd: join(root, "missing") };
    await make(async (text) => { alerts.push(text); return false; }).select([agent]);
    expect(await make().select([agent])).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(logs).toContain("launcher restore gate: alert undelivered");
  });

  test("corrupt state fails closed without overwriting its evidence", async () => {
    for (const raw of ["broken-json", '{"version":1,"agents":{"x":{"failures":-1}}}']) {
      writeFileSync(path, raw);
      await expect(make().select([dead()])).rejects.toThrow("launcher restore gate");
      expect(readFileSync(path, "utf8")).toBe(raw);
    }
  });

  test("state-lock contention skips restores instead of writing unlocked", async () => {
    const lock = await acquireLock(`${path}.lock`);
    try { await expect(make().select([dead()])).rejects.toThrow("state lock unavailable"); }
    finally { lock?.release(); }
  });
});
