import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createItem, createTask, importTask, setTask } from "../src/lib/ledger-write.js";
import { rejectPriorityFields } from "../src/lib/ledger-priority-guard.js";
import { readPriority } from "../src/lib/ledger-priority-read.js";

let db: Database;
const project = "compat", ctx = { actor: "owner", now: 1000 };
const controlled = ["workPriority", "effectivePriority", "priorityRecordId", "priorityOrder",
  "prioritySort", "priorityNowStart", "priorityStall", "priorityPanel"];
beforeEach(() => { db = openLedger(":memory:"); });
afterEach(() => closeLedger(":memory:"));

test("createItem preserves skippedTasks.T9.priority as legacy display text", () => {
  const extra = { skippedTasks: { T9: { priority: "现在做" } } };
  const result = createItem(db, ctx, { project, id: "legacy", title: "Legacy item", priority: "P0", extra });
  expect(result.row.extra).toEqual(extra);
  expect(result.row.priority).toBe("P0");
  expect(result.event.data.patch).toMatchObject({ extra });
});

test("importTask preserves extra.priority without registering a scheduling priority", () => {
  const extra = { priority: "now" };
  const result = importTask(db, ctx, { task: { project, id: "T9", title: "Legacy task", kind: "code", extra }, createdTs: 1, events: [] });
  expect(result.row.extra).toEqual(extra);
  expect(result.event.data).toMatchObject({ imported: true, patch: { extra } });
  expect(readPriority(db, project, { kind: "task", id: "T9" })).toMatchObject({ effective: "next", source: "system", ownerRegistered: false });
});

test("setTask preserves notes.Priority and supports an unchanged read-modify-write of old extra", () => {
  createTask(db, ctx, { project, id: "T9", title: "Old task", kind: "code" });
  const extra = { notes: { Priority: "P1" }, history: [{ PRIORITY: "later", pRiOrItY: "next" }] };
  const first = setTask(db, ctx, { id: "T9", rev: 1, patch: { extra } });
  const next = setTask(db, ctx, { id: "T9", rev: first.row.rev, patch: { extra: first.row.extra } });
  expect(next.row.extra).toEqual(extra);
  expect(next.row.rev).toBe(3);
  expect(readPriority(db, project, { kind: "task", id: "T9" }).effective).toBe("next");
});

test("all exact controlled names reject at root, nested object and array depths with unchanged error text", () => {
  createTask(db, ctx, { project, id: "T9", title: "Old task", kind: "code" });
  const before = listEvents(db), task = getTask(db, "T9");
  for (const key of controlled) {
    const message = `受控字段 ${key} 只能经 priority 专用入口登记`;
    for (const value of [{ [key]: "now" }, { nested: { [key]: "now" } }, { nested: [{ deeper: { [key]: "now" } }] }]) {
      expect(() => rejectPriorityFields(value)).toThrow(message);
      expect(() => createItem(db, ctx, { project, id: "bad-item", title: "Rejected", extra: value })).toThrow(message);
      expect(() => importTask(db, ctx, { task: { project, id: "bad-task", title: "Rejected", kind: "code", extra: value },
        createdTs: 1, events: [] })).toThrow(message);
      expect(() => setTask(db, ctx, { id: "T9", rev: 1, patch: { extra: value } })).toThrow(message);
    }
  }
  expect(listEvents(db)).toEqual(before);
  expect(getTask(db, "T9")).toEqual(task);
});

test("controlled names are case sensitive; ordinary priority is allowed at every depth", () => {
  for (const key of [...controlled.map((key) => key.toLowerCase()), ...controlled.map((key) => key.toUpperCase()),
    ...controlled.map((key) => `${key}\n`), ...controlled.map((key) => ` ${key}`),
    "priority", "Priority", "PRIORITY", "pRiOrItY"]) {
    expect(() => rejectPriorityFields({ [key]: "now", nested: [{ [key]: "now" }] })).not.toThrow();
  }
});
