import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LauncherRestoreGate } from "../src/lib/launcher-restore-gate.js";

test("LSTGUARD1 skipped consumption preserves restore failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lstguard1-"));
  const path = join(dir, "gate.json");
  const gate = new LauncherRestoreGate({ path, alert: async () => true, log: () => {} });
  const agent = { name: "agent-test", status: "dead", sessionId: "s", channelId: "c", cwd: dir };
  try {
    await gate.select([agent]);
    await gate.restart(agent, async () => ({ ok: true, out: JSON.stringify({ ok: false, results: [{ name: agent.name, ok: false, skipped: "recovered", error: "skipped" }] }) }));
    expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("LSTGUARD1 manager restore entry + queued gate skips then records real failure", async () => {
  const { restoreObservations } = await import("../src/manager/restart-expect-restore.js");
  const { expectSkip } = await import("../src/manager/restart-expect.js");
  const dir = mkdtempSync(join(tmpdir(), "lstguard1-wave-"));
  const path = join(dir, "gate.json");
  const alerts: string[] = [];
  const gate = new LauncherRestoreGate({ path, alert: async (text) => { alerts.push(text); return true; }, log: () => {} });
  const row = { sessionId: "s", channelId: "c", status: "active", cwd: dir };
  let alive = false;
  let exits = 0;
  const deps = { registry: async () => ({ "agent-test": row }), windows: async () => ({ "agent-test": ["@1"] }), dead: async () => !alive, children: async () => false };
  try {
    const restoreExpect = (await restoreObservations({ "agent-test": row }, deps))["agent-test"];
    const [agent] = await gate.select([{ ...row, name: "agent-test", status: "dead", restoreExpect }]);
    const run = async () => {
      const skip = await expectSkip(agent.name, undefined, undefined, agent.restoreExpect, deps);
      if (!skip) exits++;
      return { ok: true, out: JSON.stringify({ ok: false, results: [skip ?? { name: agent.name, ok: false, error: "launch failed" }] }) };
    };
    alive = true; // preceding restart in the serial wave recovered this target
    expect(await gate.restart(agent, run)).toStartWith("skipped:");
    expect(exits).toBe(0);
    expect(alerts).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(0);
    alive = false;
    expect(await gate.restart(agent, run)).toBe("launch failed");
    expect(exits).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8")).agents[agent.name].failures).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
