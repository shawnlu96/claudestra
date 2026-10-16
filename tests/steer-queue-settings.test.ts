import { expect, mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { readConfig, setLang, setSteerQueueWhenBusy, writeConfig } from "../src/lib/config-store.js";
import { CONFIG_PATH } from "../src/lib/paths.js";
import { steerQueueWhenBusy } from "../src/lib/steer-queue-policy.js";
import { messageWaitForIdle, parseWaitForIdle } from "../src/bridge/api-message-queue-policy.js";
import { handleSettings } from "../src/bridge/local-api/settings.js";
import type { Principal } from "../src/lib/principals.js";
import { isolatedStateSuite } from "./isolated-state.js";

const { test } = isolatedStateSuite(import.meta.path);
const owner: Principal = { id: "owner:self", role: "owner", agents: ["*"], createdAt: "t" };
const guest: Principal = { id: "guest:x", role: "external", agents: ["agent-calm"], createdAt: "t" };
const call = (method: string, principal: Principal, body?: unknown) => handleSettings(new Request("http://fixture/settings", {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
}), "/settings", principal);

test("[验收线 3] settings defaults on, manage-only boolean write, reopen, and unrelated edits survive", async () => {
  writeFileSync(CONFIG_PATH, JSON.stringify({ lang: "zh", steer: { futureField: "preserve" }, unrelated: { keep: 1 } }));
  expect(await (await call("GET", guest))!.json()).toMatchObject({ "steer.queueWhenBusy": true });
  expect((await call("PUT", guest, { "steer.queueWhenBusy": false }))!.status).toBe(403);
  expect(steerQueueWhenBusy(await readConfig())).toBe(true);
  expect((await call("PUT", owner, { "steer.queueWhenBusy": "false" }))!.status).toBe(400);
  expect(await (await call("PUT", owner, { "steer.queueWhenBusy": false }))!.json()).toMatchObject({ "steer.queueWhenBusy": false });
  expect(steerQueueWhenBusy(await readConfig())).toBe(false);
  const stale = await readConfig();
  await setLang("en");
  stale.steer = { queueWhenBusy: true };
  await expect(writeConfig(stale)).rejects.toThrow("config changed");
  await setSteerQueueWhenBusy(true);
  const cfg = await readConfig();
  expect(cfg.lang).toBe("en");
  expect(cfg.steer).toEqual({ queueWhenBusy: true, futureField: "preserve" });
  expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).unrelated).toEqual({ keep: 1 });
});

test("[验收线 2] wire validation is strict and rollback affects only ingress, not existing envelope metadata", () => {
  expect(steerQueueWhenBusy({})).toBe(true);
  for (const value of [undefined, null, [], true, "false", { queueWhenBusy: "false" }]) expect(steerQueueWhenBusy({ steer: value })).toBe(true);
  expect(steerQueueWhenBusy({ steer: { queueWhenBusy: false } })).toBe(false);
  const cfg = { autoUpdate: { claudestra: false, claudeCode: false }, lang: "zh" as const, steer: { queueWhenBusy: false } };
  expect(messageWaitForIdle(true, cfg)).toBe(false);
  expect(parseWaitForIdle(undefined, false)).toBe(false);
  expect(parseWaitForIdle(true, false)).toBe(true);
  expect(parseWaitForIdle("true", true)).toBe(true);
  expect(() => parseWaitForIdle("true", false)).toThrow();
  expect(() => parseWaitForIdle(true, true)).toThrow();
});


test("[验收线 3] queue setter replays its intent once on a stale config and preserves the concurrent edit", async () => {
  const path = new URL("../src/lib/floka-config/store.ts", import.meta.url).pathname;
  const real = await import("../src/lib/floka-config/store.js");
  const write = real.writeCompatibleConfig;
  let attempts = 0;
  mock.module(path, () => ({ ...real, writeCompatibleConfig: async (file: string, cfg: Parameters<typeof write>[1]) => {
    if (++attempts === 1) {
      const disk = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({ ...disk, concurrentField: "survives" }));
    }
    await write(file, cfg);
  } }));
  try {
    await setSteerQueueWhenBusy(false);
    expect(attempts).toBe(2);
    expect(steerQueueWhenBusy(await readConfig())).toBe(false);
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).concurrentField).toBe("survives");
  } finally { mock.module(path, () => real); }
});
