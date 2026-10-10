import { expect, test } from "bun:test";
import { restoreArg, restoreObservations, restoreSkip, type RestoreDeps, type RestoreRow } from "../src/manager/restart-expect-restore.js";

import { expectSkip } from "../src/manager/restart-expect.js";

const name = "agent-test";
async function world() {
  const w = { row: { sessionId: "s", channelId: "c", status: "active", runtime: "codex" } as RestoreRow,
    ids: ["@1"], dead: true, exits: 0 };
  const deps: RestoreDeps = { registry: async () => ({ [name]: w.row }), windows: async () => ({ [name]: w.ids }), dead: async () => w.dead, children: async () => false };
  const raw = (await restoreObservations({ [name]: w.row }, deps))[name];
  const consume = async () => { const skip = await expectSkip(name, undefined, undefined, raw, deps); if (!skip) w.exits++; return skip; };
  return { w, deps, raw, consume };
}

test("LSTGUARD1 sampled dead recovers while queued: no exit", async () => {
  const { w, consume } = await world();
  w.dead = false;
  expect(await consume()).toHaveProperty("skipped");
  expect(w.exits).toBe(0);
});

for (const kind of ["session", "window", "pending", "stopped", "missing", "unknown", "read"] as const) {
  test(`LSTGUARD1 ${kind} during lock-held probe: no exit`, async () => {
    const { w, deps, consume } = await world();
    deps.dead = async () => {
      if (kind === "session") w.row = { ...w.row, sessionId: "new" };
      if (kind === "window") w.ids = ["@2"];
      if (kind === "pending") w.row = { ...w.row, pending: { op: "kill" } };
      if (kind === "stopped") w.row = { ...w.row, status: "stopped" };
      if (kind === "missing") deps.registry = async () => ({});
      if (kind === "read") deps.registry = async () => { throw new Error("unreadable"); };
      return kind !== "unknown";
    };
    expect(await consume()).toHaveProperty("skipped");
    expect(w.exits).toBe(0);
  });
}

test("LSTGUARD1 unchanged dead identity exits once; manual reads nothing", async () => {
  const { w, deps, consume } = await world();
  expect(await consume()).toBeNull();
  expect(w.exits).toBe(1);
  deps.registry = async () => { throw new Error("manual must not read"); };
  expect(await restoreSkip(name, undefined, deps)).toBeNull();
});

test("LSTGUARD1 absent window cannot consume same-name replacement", async () => {
  const { w, deps } = await world();
  w.ids = [];
  const raw = (await restoreObservations({ [name]: w.row }, deps))[name];
  expect(await restoreSkip(name, raw, deps)).toBeNull();
  w.ids = ["@2"];
  expect(await restoreSkip(name, raw, deps)).toHaveProperty("skipped");
});

test("LSTGUARD1 observation failure and malformed authority fail closed", async () => {
  const { deps, raw } = await world();
  deps.windows = async () => { throw new Error("tmux unavailable"); };
  expect(await restoreObservations({}, deps)).toEqual({});
  for (const value of [raw, "", "null", JSON.stringify({ ...JSON.parse(raw), agent: "other" })]) {
    expect(await restoreSkip(name, value, deps)).toHaveProperty("skipped");
  }
  expect(restoreArg(["--restore-expect", raw, "--", name])).toBe(raw);
  expect(restoreArg(["--restore-expect", raw])).toBe("");
  expect(restoreArg(["--", name])).toBeUndefined();
});

test("LSTGUARD1 session replaced during initial sampling cannot grant restore", async () => {
  const { w, deps } = await world();
  const sampled = w.row;
  deps.windows = async () => { w.row = { ...w.row, sessionId: "new" }; return { [name]: ["@1"] }; };
  const raw = (await restoreObservations({ [name]: sampled }, deps))[name];
  expect(await expectSkip(name, undefined, undefined, raw, deps, sampled)).toHaveProperty("skipped");
  expect(w.exits).toBe(0);
});

test("LSTGUARD1 manager's cached registry must match the observation too", async () => {
  const { w, raw, deps } = await world();
  expect(await expectSkip(name, undefined, undefined, raw, deps, { ...w.row, sessionId: "other" })).toHaveProperty("skipped");
});

test("LSTGUARD1 conflicts, duplicate flags and malformed wire never authorize restore", async () => {
  const { raw, deps } = await world();
  for (const args of [
    ["--expect", "{}", "--restore-expect", raw, "--", name],
    ["--restore-expect", raw, "--expect", "{}", "--", name],
    ["--restore-expect", raw, "--restore-expect", raw, "--", name],
    ["--restore-expect", "--", name], ["--restore-expect", raw, "--", name, "other"],
  ]) {
    expect(restoreArg(args)).toBe("");
    expect(await expectSkip(name, undefined, undefined, restoreArg(args), deps)).toHaveProperty("skipped");
  }
  for (const over of [{ v: 2 }, { windows: ["bad"] }, { windows: ["@1", "@2"] }, { extra: true },
    { identity: "{}" }, { identity: JSON.stringify([null, "c", null, null, null, null, "active", null]) },
    { identity: "中".repeat(800) }]) {
    expect(await restoreSkip(name, JSON.stringify({ ...JSON.parse(raw), ...over }), deps)).toHaveProperty("skipped");
  }
});

test("LSTGUARD1 pinned launch gate catches startup-wait replacement; invalid created ID cannot start", async () => {
  const { restoreLaunchGuard, restoreExceptionResult } = await import("../src/manager/restart-expect-restore.js");
  const { w, raw, deps } = await world();
  let starts = 0;
  const io = { name, target: "@1", capture: async () => "shell %", sendLine: async (_text?: string) => { starts++; },
    sendLiteral: async () => { starts++; }, sendKey: async () => { starts++; }, sendEscape: async () => { starts++; },
    getOption: async () => null, setOption: async () => true, childPids: async () => [], sleep: async () => {} };
  const send: typeof import("../src/lib/tmux-helper.js").tmuxSendLine = async (_target, text, _delay, _strict, hook) => {
    await hook?.("literal"); await io.sendLine(text); await hook?.("enter");
  };
  const guard = restoreLaunchGuard(name, raw, "@1", deps, send);
  const win = guard.wrap(io);
  await win.sendLine("launch");
  expect(starts).toBe(1);
  w.ids = ["@2"];
  try { await win.capture(); throw new Error("must skip"); }
  catch (e) { expect(restoreExceptionResult(name, e)).toHaveProperty("skipped"); }
  expect(guard.skipped()).toHaveProperty("skipped");
  expect(starts).toBe(1);
  const invalid = restoreLaunchGuard(name, raw, "", deps, send);
  await expect(invalid.wrap(io).sendLine("launch")).rejects.toThrow("invalid restore observation");
  expect(starts).toBe(1);
});

test("LSTGUARD1 automatic runtime admission preserves sandbox and ACP compatibility rejection", async () => {
  const { restoreAdapter } = await import("../src/manager/restart-expect-restore.js");
  let checks = 0;
  const deps = { sandbox: () => true, ready: async (install?: boolean) => {
    expect(install).toBe(false); checks++; return { ok: false as const, reason: "incompatible" };
  } };
  expect(await restoreAdapter(name, { runtime: "codex", transport: "tmux" }, deps)).toBeNull();
  expect(await restoreAdapter(name, { runtime: "unknown" }, deps)).toBeNull();
  await expect(restoreAdapter(name, { runtime: "codex", transport: "acp" }, deps)).rejects.toThrow("incompatible");
  expect(checks).toBe(1);
});
