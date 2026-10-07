import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock } from "../src/lib/file-lock.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { appendEvent } from "../src/lib/ledger-write.js";
import { informKey } from "../src/lib/scheduler-model-wiring.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { recoveryArgs, recoveryFence } from "../src/lib/scheduler-recovery-ports.js";
import { readFileSync } from "node:fs";
import { readonlyFixture, type ReadonlyFixture } from "./scheduler-readonly-fixture.js";

let f: ReadonlyFixture;
afterEach(() => f?.close());
const note = () => ["ledger", "scheduler-model-inform", "T1", "--key", informKey("T1", "cyber_policy"), "--text", "test notice",
  "--data", JSON.stringify({ op: "refusal_owner_inform", kind: "cyber_policy" })];
const snapshot = () => ({ task: getTask(f.db(), "T1"), events: listEvents(f.db(), { project: "p" }) });

test("default reader rejects real appendEvent and task mutation without changing ledger; leased CLI commits visible next query", async () => {
  f = await readonlyFixture();
  const before = snapshot();
  expect(() => appendEvent(f.db(), { actor: "scheduler" }, { project: "p", target: "T1", kind: "note", text: "bad write" })).toThrow(/readonly/);
  expect(() => f.db().query("UPDATE tasks SET title='bad' WHERE id='T1'").run()).toThrow(/readonly/);
  expect(snapshot()).toEqual(before);
  const result = await f.withMaintenance(() => f.manager(...note()));
  expect(result).toMatchObject({ ok: true, duplicate: false });
  expect(snapshot().events).toHaveLength(before.events.length + 1);
  expect(snapshot().events.at(-1)).toMatchObject({ actor: "scheduler", data: { op: "refusal_owner_inform" } });
  expect(snapshot().task).toEqual(before.task);
  expect(f.calls).toMatchObject([{ args: note(), code: 0, timedOut: false, stderr: "", result: { ok: true } }]);
});

test("real SQLite write lock serializes manager writes; failed and forbidden children preserve state and diagnostics", async () => {
  f = await readonlyFixture();
  f.prepare.db.exec("BEGIN IMMEDIATE");
  const before = snapshot();
  let done = false;
  const pending = f.withMaintenance(() => f.manager(...note())).then((r) => { done = true; return r; });
  try {
    await Bun.sleep(350);
    expect(done).toBe(false);
    expect(snapshot()).toEqual(before);
  } finally { f.prepare.db.exec("ROLLBACK"); }
  expect(await pending).toMatchObject({ ok: true });
  const committed = snapshot();
  f.childEnv({ CLAUDESTRA_SCHEDULER_SERVICE: undefined, CLAUDESTRA_SCHEDULER_LEASE: undefined, DISCORD_CHANNEL_ID: "unknown-channel" });
  expect(await f.withMaintenance(() => f.manager(...note()))).toMatchObject({ ok: false, code: "forbidden" });
  expect(snapshot()).toEqual(committed);
  expect(f.calls.at(-1)?.result.ok).toBe(false);
  expect(f.diagnostics.join("\n")).toMatch(/scheduler-model-inform/);
  f.childEnv({});
  f.childPath(join(f.root, "missing-manager.ts"));
  expect(await f.withMaintenance(() => f.manager(...note()))).toMatchObject({ ok: false });
  expect(snapshot()).toEqual(committed);
  expect(f.calls.at(-1)?.stderr).toMatch(/not found/);
  expect(f.diagnostics.join("\n")).toMatch(/missing-manager/);
}, 30_000);

test("lease lost after spawn preparation refuses CLI before commit", async () => {
  f = await readonlyFixture();
  const before = snapshot();
  f.beforeChild(() => writeFileSync(join(f.singletonPath, "owner"), "replacement"));
  expect(await f.withMaintenance(() => f.manager(...note()))).toMatchObject({ ok: false, code: "lease-lost" });
  expect(snapshot()).toEqual(before);
  expect(f.diagnostics.join("\n")).toMatch(/失租|停止/);
});

test("uncommitted writer data is invisible; close and reopen preserves SQLite query_only and later CLI commits", async () => {
  f = await readonlyFixture();
  const before = snapshot();
  f.prepare.db.exec("BEGIN IMMEDIATE");
  try {
    appendEvent(f.prepare.db, { actor: "owner" }, { project: "p", target: "T1", kind: "note", text: "uncommitted" });
    f.prepare.db.query("UPDATE tasks SET title='uncommitted' WHERE id='T1'").run();
    expect(snapshot()).toEqual(before);
    f.reader.close();
    expect(snapshot()).toEqual(before);
    expect(() => f.db().run("UPDATE tasks SET title='bad'")).toThrow(/readonly/);
  } finally { f.prepare.db.exec("ROLLBACK"); }
  await f.withMaintenance(() => f.manager(...note()));
  f.reader.close();
  expect(snapshot().events).toHaveLength(before.events.length + 1);
  expect(snapshot().task).toEqual(before.task);
  expect(() => appendEvent(f.db(), { actor: "owner" }, { project: "p", target: "T1", kind: "note" })).toThrow(/readonly/);
});

test("pass respects maintenance, dispatch off, stop and concurrent maintenance exclusion", async () => {
  f = await readonlyFixture();
  const before = snapshot(), lock = (await acquireLock(f.maintenance.path, 0))!;
  try { expect(await f.pass()).toEqual({ ran: false, failed: [] }); } finally { lock.release(); }
  expect(snapshot()).toEqual(before);
  expect(f.calls).toEqual([]);
  expect(await f.pass({}, false)).toEqual({ ran: true, failed: [] });
  expect(snapshot()).toEqual(before);
  expect(f.calls).toEqual([]);
  await expect(f.pass({ assertOwner: () => { throw new SchedulerStopped("stop requested"); } })).rejects.toThrow(/stop requested/);
  expect(snapshot()).toEqual(before);
  let unblock!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { unblock = r; });
  const pass = f.pass({ trainTick: async () => { entered(); await gate; } }, false);
  await waiting;
  expect(await f.pass({}, false)).toEqual({ ran: false, failed: [] });
  unblock();
  expect(await pass).toEqual({ ran: true, failed: [] });
  expect(existsSync(f.maintenance.path)).toBe(false);
});

test("all new writers refuse owner, PM, executor and lending worker; scheduler still cannot invoke workflow-resume", async () => {
  f = await readonlyFixture();
  const registry = JSON.parse(readFileSync(f.prepare.registryPath, "utf8"));
  registry.agents.pm.channelId = "ch-pm";
  writeFileSync(f.prepare.registryPath, JSON.stringify(registry));
  const args = recoveryArgs(recoveryFence(f.db(), f.prepare.task()));
  const commands = [
    ["scheduler-manual-resume", ...args, "--mode", "on", "--reason", "not authorized", "--max-workers", "2"],
    ["scheduler-review-hold", ...args, "--action", "prepare", "--review-seq", "1"],
    ["scheduler-review-downgrade", ...args, "--review-seq", "1"],
  ];
  const before = snapshot();
  for (const channel of [undefined, "ch-pm", "ch-one"]) {
    f.childEnv({ CLAUDESTRA_SCHEDULER_SERVICE: undefined, CLAUDESTRA_SCHEDULER_LEASE: undefined, DISCORD_CHANNEL_ID: channel });
    for (const command of commands) expect(await f.withMaintenance(() => f.manager("ledger", ...command))).toMatchObject({ ok: false, code: "forbidden" });
  }
  f.childEnv({ CLAUDESTRA_LEND_WORKER: "1" });
  for (const command of commands) expect(await f.withMaintenance(() => f.manager("ledger", ...command))).toMatchObject({ ok: false, code: "forbidden" });
  f.childEnv({});
  expect(await f.withMaintenance(() => f.manager("ledger", "workflow-resume", "T1", "--rev", "1", "--workflow-rev", "1", "--reason", "test")))
    .toMatchObject({ ok: false, code: "forbidden" });
  expect(snapshot()).toEqual(before);
  for (const command of commands) {
    f.childEnv({ CLAUDESTRA_SCHEDULER_LEASE: "" });
    expect(await f.withMaintenance(() => f.manager("ledger", ...command))).toMatchObject({ ok: false, code: "lease-lost" });
    expect(snapshot()).toEqual(before);
  }
}, 30_000);
