import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { boardContext } from "../src/lib/ledger-dag-board.js";
import { eventsByTarget } from "../src/lib/ledger-read-cards.js";
import { schedulerProjectView } from "../src/lib/ledger-scheduler.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";

let db: Database;
beforeEach(() => {
  db = openLedger(":memory:");
  const owner = { actor: "owner", now: 10 };
  setMeta(db, owner, { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, owner, { project: "p", id: "T1", title: "One", kind: "code", agent: "agent-one" });
  createTask(db, owner, { project: "p", id: "T2", title: "Two", kind: "code" });
  createTask(db, owner, { project: "q", id: "Q1", title: "Other", kind: "code" });
  moveStage(db, { ...owner, now: 20 }, { taskId: "T1", from: "spec", to: "restate" });
});
afterEach(() => closeLedger(":memory:"));

test("pre-grouped project events preserve every scheduler field, including an empty event list", () => {
  const events = eventsByTarget(listEvents(db, { project: "p" }));
  const expected = schedulerProjectView(db, "p");
  const before = JSON.stringify([...events]);
  expect(schedulerProjectView(db, "p", events)).toEqual(expected);
  expect(JSON.stringify([...events])).toBe(before);
  // An explicitly provided empty map must not fall back to querying target histories.
  events.delete("T2");
  const prepare = spyOn(db, "prepare");
  try {
    expect(schedulerProjectView(db, "p", events).tasks.find(t => t.taskId === "T2")).toMatchObject({ taskId: "T2", handler: { seq: 0 } });
    expect(prepare.mock.calls.filter(([sql]) => /FROM events.*target/.test(sql))).toHaveLength(0);
  } finally { prepare.mockRestore(); }
});

test("boardContext reads project history exactly once and never queries events by target", () => {
  const prepare = spyOn(db, "prepare");
  try {
    const ctx = db.transaction(() => boardContext(db, "p", 100)).deferred();
    expect(ctx.events.size).toBe(3);
    expect(ctx.events.has("Q1")).toBe(false);
    const queries = prepare.mock.calls.map(([sql]) => sql).filter(sql => /SELECT \* FROM events/.test(sql));
    expect(queries).toEqual(["SELECT * FROM events WHERE project = ? ORDER BY seq"]);
  } finally { prepare.mockRestore(); }
});
