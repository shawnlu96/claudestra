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
    expect(alerts).toHaveLength(2);
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
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain(agent.name);
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
    expect(alerts).toHaveLength(2);
  });

  test.each(["ready", "created", "sessionId"])("observed %s change unlocks an agent", async (change) => {
    const agent = dead(), gate = make();
    for (let i = 0; i < 3; i++) await gate.restart(agent, failed);
    expect(await make().select([agent])).toEqual([]);
    const next = change === "ready" ? agent : { ...agent, [change]: "new-generation" };
    if (change === "ready") expect(await make().select([{ ...agent, status: "active", runtime: "claude-code", idle: true }])).toEqual([]);
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
    const invalidCount = { generation: "same", failures: 4, missingAlert: false, failureAlert: false };
    for (const raw of ["broken-json", '{"version":1,"agents":{"x":{"failures":-1}}}', JSON.stringify({ version: 1, agents: { x: invalidCount } })]) {
      writeFileSync(path, raw);
      expect(await make().select([dead()])).toEqual([]);
      expect(await make().select([dead()])).toEqual([]);
      expect(alerts).toHaveLength(1);
      expect(readFileSync(path, "utf8")).toBe(raw);
    }
  });

  test("state-lock contention skips restores instead of writing unlocked", async () => {
    const lock = await acquireLock(`${path}.lock`);
    try {
      expect(await make().select([dead()])).toEqual([]);
      expect(await make().select([dead()])).toEqual([]);
      expect(alerts).toHaveLength(1);
    }
    finally { lock?.release(); }
    expect(await make().select([dead()])).toEqual([dead()]);
  });

  test.each([undefined, false])("transient active with idle=%s never erases failed attempts", async (idle) => {
    const agent = dead();
    let runs = 0;
    for (let round = 0; round < 5; round++) {
      const gate = make();
      for (const a of await gate.select([agent])) {
        await gate.restart(a, async () => { runs++; return failed(); });
      }
      await gate.select([{ ...agent, status: "active", runtime: "claude-code", idle }]);
    }
    expect(runs).toBe(3);
    expect(await make().select([agent])).toEqual([]);
    expect(alerts).toHaveLength(2); // First failure and the third-failure stop, once each.
  });

  test.each(["pi", "codex", undefined])("%s synthetic idle does not prove a successful recovery", async (runtime) => {
    const agent = dead(), gate = make();
    for (let i = 0; i < 3; i++) await gate.restart(agent, failed);
    await gate.select([{ ...agent, status: "active", idle: true, runtime }]);
    expect(await make().select([agent])).toEqual([]);
  });

  test.each(["pi", "codex"])("%s sustained active after manual restart unlocks the same generation", async (runtime) => {
    const agent = { ...dead(), runtime };
    for (let i = 0; i < 3; i++) await make().restart(agent, failed);
    expect(await make().select([agent])).toEqual([]);
    const active = { ...agent, status: "active", idle: true };
    await make().select([active]);
    expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(3);
    await make().select([active]);
    const entry = JSON.parse(readFileSync(path, "utf8")).agents[agent.name];
    expect(entry.failures).toBe(0);
    expect(entry.failureAlert).toBe(false);
    expect(entry.lastFailureAlert).toBeUndefined();
    expect(await make().select([agent])).toEqual([agent]);
    for (let i = 0; i < 3; i++) await make().restart(agent, failed);
    expect(await make().select([agent])).toEqual([]);
    expect(alerts).toHaveLength(4); // Each failure cycle gets its own first-failure and stop alerts.
  });

  test.each(["pi", "codex"])("%s transient active between failures cannot bypass the limit", async (runtime) => {
    const agent = { ...dead(), runtime };
    let runs = 0;
    for (let round = 0; round < 5; round++) {
      for (const a of await make().select([agent])) {
        await make().restart(a, async () => { runs++; return failed(); });
      }
      await make().select([{ ...agent, status: "active", idle: true }]);
    }
    expect(runs).toBe(3);
    expect(await make().select([agent])).toEqual([]);
    expect(alerts).toHaveLength(2);
  });

  test.each(["creating", "unknown"])("%s interrupts hook runtime active observations", async (status) => {
    const agent = { ...dead(), runtime: "pi" };
    for (let i = 0; i < 3; i++) await make().restart(agent, failed);
    const active = { ...agent, status: "active", idle: true };
    await make().select([active]);
    await make().select([{ ...agent, status }]);
    await make().select([active]);
    expect(await make().select([agent])).toEqual([]);
  });

  test.each(["pi", "codex"])("%s sustained active clears an unfinished restart reservation", async (runtime) => {
    const agent = { ...dead(), runtime };
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<Awaited<ReturnType<typeof success>>>();
    const pending = make().restart(agent, () => { started.resolve(); return finish.promise; });
    await started.promise;
    try {
      expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(1);
      const active = { ...agent, status: "active", idle: true };
      await make().select([active]);
      await make().select([active]);
      expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(0);
      expect(await make().select([agent])).toEqual([agent]);
    } finally { finish.resolve(await success()); await pending; }
  });

  test.each(["dead", "active"])("a repaired cwd re-arms its missing alert while %s across launcher restarts", async (status) => {
    const agent = { ...dead(), cwd: join(root, "repaired") };
    expect(await make().select([agent])).toEqual([]);
    mkdirSync(agent.cwd);
    const repaired = { ...agent, status };
    expect(await make().select([repaired])).toEqual(status === "dead" ? [repaired] : []);
    rmSync(agent.cwd, { recursive: true });
    expect(await make().select([agent])).toEqual([]);
    expect(await make().select([agent])).toEqual([]);
    expect(alerts).toHaveLength(2);
  });

  test("storage failure after restart keeps the attempt and does not abort the remaining wave", async () => {
    const first = dead(), second = dead("agent-second");
    let lock: Awaited<ReturnType<typeof acquireLock>>;
    const gate = make(async (text) => { alerts.push(text); lock?.release(); return true; });
    const results: (string | null)[] = [];
    for (const a of await gate.select([first, second])) {
      results.push(await gate.restart(a, async () => {
        if (a.name === first.name) { lock = await acquireLock(`${path}.lock`); return failed(); }
        return success();
      }));
    }
    expect(results[0]).toBeTruthy();
    expect(results[1]).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).agents[first.name].failures).toBe(1);
    await gate.restart(first, failed);
    await gate.restart(first, failed);
    expect(await make().select([first, second])).toEqual([second]);
  });

  test("post-run corrupt state is reported without throwing or overwriting the evidence", async () => {
    const gate = make();
    expect(await gate.restart(dead(), async () => {
      writeFileSync(path, "broken");
      return failed();
    })).toBeTruthy();
    expect(await make().select([dead()])).toEqual([]);
    expect(alerts).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe("broken");
  });

  test("state corruption re-arms its alert only after repair", async () => {
    writeFileSync(path, "broken");
    expect(await make().select([dead()])).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 1, agents: {} }));
    expect(await make().select([dead()])).toEqual([dead()]);
    writeFileSync(path, "broken again");
    expect(await make().select([dead()])).toEqual([]);
    expect(alerts).toHaveLength(2);
  });

  test("first-failure alerts retain their 30-minute cooldown across launcher restarts", async () => {
    const agent = dead();
    await make().restart(agent, failed);
    expect(alerts).toHaveLength(1);
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.agents[agent.name].lastFailureAlert = Date.now() - 31 * 60_000;
    writeFileSync(path, JSON.stringify(state));
    await make().restart(agent, failed);
    expect(alerts).toHaveLength(2);
    await make().restart(agent, failed);
    expect(alerts).toHaveLength(3); // The stop alert is independent of the per-failure cooldown.
  });
});
