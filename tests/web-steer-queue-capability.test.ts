import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store";
import { recoveryPolicy } from "../src/lib/recovery-policy";
import { observeSteerQueueCapability, steerQueueRecovery } from "../src/lib/steer-queue-recovery";
import { handleSettings } from "../src/bridge/local-api/settings";
import type { Principal } from "../src/lib/principals";
import {
  getSteerQueueRecovery, queueCapability, queueWhenBusy, readSteerQueueSettings, SteerQueueCache, steerQueueMode, SteerQueueStaleRead,
} from "../web/lib/steer-queue-capability";
import { appConfigSync, setAppConfigForTest } from "../web/lib/app-config";
import { sayGate } from "../web/features/collab/collab-action";

describe("QUEUECAP1 strict target capability", () => {
  for (const raw of [true, false, undefined, null, "true", "false", 0, 1, {}, []]) {
    test(`only boolean true permits busy sends: ${JSON.stringify(raw)}`, () => {
      const enabled = queueWhenBusy(raw, "on");
      expect(enabled).toBe(raw === true);
      expect(sayGate(true, "draft", false, enabled).canSend).toBe(raw === true);
      expect(sayGate(false, "draft", false, enabled).canSend).toBe(true);
    });
  }
  test("failure is conservative even after a previous true", () => {
    expect(queueWhenBusy(true, "on", true)).toBe(false);
    expect(queueCapability(true, true)).toBe("failed");
  });
  test("off and observe preserve the baseline parser, including malformed and missing fields", () => {
    for (const raw of [true, false, undefined, null, "false", 0, {}, []]) {
      for (const mode of ["off", "observe"] as const) expect(queueWhenBusy(raw, mode)).toBe(raw !== false);
    }
    expect(steerQueueMode(undefined)).toBe("on");
    expect(steerQueueMode(null)).toBe("on");
    expect(steerQueueMode(false)).toBe("on");
  });
  test("target caches never leak true to an old bridge; late replies cannot publish after A→B→A", () => {
    const cache = new SteerQueueCache();
    const a = cache.begin("a");
    expect(cache.finish(a, "a", true)).toBe(true);
    cache.switchMachine();
    const b = cache.begin("b");
    expect(cache.enabled("b", "on")).toBe(false);
    expect(cache.finish(a, "b", true)).toBe(false);
    cache.switchMachine();
    expect(cache.finish(a, "a", true)).toBe(false);
    expect(cache.finish(b, "a", true)).toBe(false);
    const fresh = cache.begin("a");
    expect(cache.finish(fresh, "a", false)).toBe(true);
    expect(cache.enabled("a", "on")).toBe(false);
  });
  test("a settings write supersedes its earlier read", () => {
    const cache = new SteerQueueCache();
    const get = cache.begin("a"), put = cache.begin("a");
    expect(cache.finish(put, "a", false)).toBe(true);
    expect(cache.finish(get, "a", true)).toBe(false);
    expect(cache.enabled("a", "on")).toBe(false);
  });
});

test("control policy reloads on/observe/off, samples deduplicate by target/version and contain no raw values", () => {
  const dir = mkdtempSync(join(tmpdir(), "queuecap-"));
  const path = join(dir, "recovery.json"), dbPath = join(dir, "ledger.sqlite");
  const policy: typeof recoveryPolicy = (project, key) => recoveryPolicy(project, key, path);
  const db = openLedger(dbPath);
  try {
    expect(steerQueueRecovery(policy)).toEqual({ mode: "on" });
    const sample = { target: "a".repeat(24), version: "b".repeat(24), capability: "missing", text: "private draft", setting: "private value" };
    for (const mode of ["on", "off", "observe"] as const) {
      writeFileSync(path, JSON.stringify({ projects: { "claude-orchestrator": { keys: { steerQueueCapability: mode } } } }));
      expect(steerQueueRecovery(policy)).toEqual({ mode });
      expect(observeSteerQueueCapability(sample, policy, () => db)).toEqual({ ok: true, recorded: mode === "observe" });
      expect(listEvents(db, { project: "claude-orchestrator" })).toHaveLength(mode === "observe" ? 1 : 0);
    }
    observeSteerQueueCapability({ ...sample, capability: "enabled" }, policy, () => db);
    expect(listEvents(db, { project: "claude-orchestrator" })).toHaveLength(1);
    observeSteerQueueCapability({ ...sample, version: "c".repeat(24) }, policy, () => db);
    const events = listEvents(db, { project: "claude-orchestrator" });
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toMatchObject({ mechanism: "steerQueueCapability", capability: "missing", differs: true });
    expect(JSON.stringify(events)).not.toContain("private");
    expect(observeSteerQueueCapability({ ...sample, target: "unhashed-machine" }, policy, () => db).ok).toBe(false);
  } finally { closeLedger(dbPath); rmSync(dir, { recursive: true, force: true }); }
});

test("the authenticated settings handler projects only mode and refuses policy writes", async () => {
  const principal: Principal = { id: "guest:fixture", role: "external", agents: ["worker"], manage: false, createdAt: "2026-01-01" };
  const get = await handleSettings(new Request("http://fixture/api/v1/settings/steer-queue-recovery"), "/settings/steer-queue-recovery", principal);
  expect(get!.status).toBe(200);
  const projection = await get!.json() as { mode: string };
  expect(Object.keys(projection)).toEqual(["mode"]);
  expect(["on", "observe", "off"]).toContain(projection.mode);
  const put = await handleSettings(new Request("http://fixture/api/v1/settings/steer-queue-recovery", { method: "PUT", body: '{"mode":"off"}' }),
    "/settings/steer-queue-recovery", principal);
  expect(put!.status).toBe(405);
});

test("an older control projection cannot restore off after a newer on response", async () => {
  const saved = globalThis.fetch;
  let release!: (r: Response) => void;
  let calls = 0;
  globalThis.fetch = (async () => ++calls === 1 ? new Promise<Response>(r => { release = r; }) : Response.json({ mode: "on" })) as unknown as typeof fetch;
  try {
    const old = getSteerQueueRecovery();
    expect(await getSteerQueueRecovery()).toBe("on");
    release(Response.json({ mode: "off" }));
    expect(await old).toBe("on");
  } finally { globalThis.fetch = saved; }
});

test("the real settings cache rejects a delayed true GET superseded by a false PUT", async () => {
  const saved = globalThis.fetch, config = appConfigSync();
  setAppConfigForTest({ mode: "direct", fp: "fixture", machineName: "fixture", version: "new" });
  let release!: (r: Response) => void;
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    if (String(input).includes("steer-queue-recovery")) return Response.json({ mode: "on" });
    return init?.method === "PUT" ? Response.json({ "steer.queueWhenBusy": false }) : new Promise<Response>(r => { release = r; });
  }) as typeof fetch;
  try {
    const old = readSteerQueueSettings();
    await new Promise(r => setTimeout(r, 0));
    const updated = await readSteerQueueSettings({ "steer.queueWhenBusy": false });
    expect(updated.raw["steer.queueWhenBusy"]).toBe(false);
    release(Response.json({ "steer.queueWhenBusy": true }));
    await expect(old).rejects.toBeInstanceOf(SteerQueueStaleRead);
  } finally { globalThis.fetch = saved; setAppConfigForTest(config); }
});
