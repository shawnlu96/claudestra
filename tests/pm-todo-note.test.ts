import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, setMeta } from "../src/lib/ledger-write.js";
import { recordPmTodo } from "../src/lib/pm-todo-note.js";
import { pmTodos } from "../src/lib/pm-todo.js";
import { runLedger } from "../src/manager/ledger.js";
import type { LedgerDeps } from "../src/manager/ledger-context.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { PMAUTO_SERVICE } from "../src/manager/ledger-observation-wiring.js";

let db: Database, dir: string;
const ctx = { actor: "scheduler", now: 123 };
const input = { project: "p", target: "T1", kind: "followup", text: "确认部署", dedupKey: "deploy:T1" };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pm-todo-note-")); db = openLedger(join(dir, "ledger.sqlite"));
  setMeta(db, { actor: "owner" }, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, { actor: "owner" }, { project: "p", id: "T1", title: "t", kind: "code", agent: "agent-w" });
});
afterEach(() => { closeLedger(join(dir, "ledger.sqlite")); rmSync(dir, { recursive: true, force: true }); });

function deps(actor: string, assertLease?: () => void): LedgerDeps {
  return { db, actor, now: () => 123, projectIds: ["p"], assertLease, autoDispatch: () => true, autoProjects: () => ["p"],
    loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {} };
}
const args = (command: string) => command === "scheduler-pm-todo"
  ? [command, "T1", "--kind", "followup", "--text", "确认部署", "--dedup", "deploy:T1"] : [command, "T1"];

test("[验收线 7] generic notes deduplicate, appear regardless of stage / observation period and close by done key", () => {
  const a = recordPmTodo(db, ctx, input), b = recordPmTodo(db, ctx, input);
  expect(a.event.seq).toBe(b.event.seq);
  expect(b.duplicate).toBe(true);
  expect(pmTodos(db, "p", () => "", 123)).toMatchObject([{ task: "T1", due: true, kind: "followup", dedupKey: "deploy:T1" }]);
  appendEvent(db, { actor: "agent-pm", dedupKey: "pm-todo-done:deploy:T1" }, { project: "p", target: "T1", kind: "note", text: "已处理" });
  expect(pmTodos(db, "p", () => "", 123)).toEqual([]);
});

for (const command of ["scheduler-observation-register", "scheduler-pm-todo"]) {
  test(`[验收线 7] ${command} refuses PM, executor and absent / lost leases`, async () => {
    expect(PMAUTO_SERVICE.has(command)).toBe(true);
    for (const actor of ["agent-pm", "agent-w", "owner", "scheduler"]) {
      expect(await runLedger(args(command), deps(actor))).toMatchObject({ ok: false, code: "forbidden" });
      if (actor !== "scheduler") expect(await runLedger(args(command), deps(actor, () => {}))).toMatchObject({ ok: false, code: "forbidden" });
    }
    expect(await runLedger(args(command), deps("scheduler", () => { throw new SchedulerLeaseLost("lease lost"); }))).toMatchObject({ ok: false, code: "lease-lost" });
    expect(listEvents(db, { project: "p" }).filter((e) => e.data.op === "pm_todo")).toHaveLength(0);
  });
}

test("[验收线 7] leased pm-todo command writes only op=pm_todo and rejects arbitrary data or op flags", async () => {
  const d = deps("scheduler", () => {});
  expect(await runLedger(args("scheduler-pm-todo"), d)).toMatchObject({ ok: true });
  for (const flag of ["--op", "--data"]) expect(await runLedger([...args("scheduler-pm-todo"), flag, "other"], d)).toMatchObject({ ok: false });
  expect(listEvents(db, { project: "p" }).filter((e) => e.kind === "note").map((e) => e.data.op)).toEqual(["pm_todo"]);
});

for (const dedupKey of ["post-verify-done:T1", "pm-todo-done:deploy:T1"]) {
  test(`[验收线 7] both PM todo writers reject the completion namespace ${dedupKey}`, async () => {
    for (const actor of ["scheduler", "agent-pm"]) {
      expect(() => recordPmTodo(db, { ...ctx, actor }, { ...input, dedupKey })).toThrow("去重键");
    }
    const command = args("scheduler-pm-todo");
    command[command.length - 1] = dedupKey;
    expect(await runLedger(command, deps("scheduler", () => {}))).toMatchObject({ ok: false, code: "invalid" });
    expect(listEvents(db, { project: "p" }).some((e) => e.dedupKey === dedupKey)).toBe(false);
  });
}
