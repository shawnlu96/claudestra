import { expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store";
import { createTask } from "../src/lib/ledger-write";
import { assignStep } from "../src/lib/ledger-steps-write";
import { teamTasks } from "../src/lib/team-tasks";

test("team cards use current explicit step, exact peer and project, with legacy fallback", () => {
  const db = openLedger(":memory:");
  const ctx = { actor: "owner", now: 1000 };
  try {
    createTask(db, ctx, { project: "P", id: "T1", title: "one", kind: "code", extra: { delegate: "agent-old@A", reviewer: "agent-r@B" } });
    db.run("UPDATE tasks SET stage='build' WHERE id='T1'");
    expect(teamTasks(db, "P", "A", "old").map((t) => t.id)).toEqual(["T1"]);
    expect(teamTasks(db, "elsewhere", "A", "old")).toEqual([]);
    assignStep(db, ctx, { taskId: "T1", step: "write", executor: "agent-new@A", executorKind: "peer" });
    expect(teamTasks(db, "P", "A", "old")).toEqual([]);
    expect(teamTasks(db, "P", "A", "new").map((t) => t.id)).toEqual(["T1"]);
    expect(teamTasks(db, "P", "other", "new")).toEqual([]);
    db.run("UPDATE tasks SET stage='review' WHERE id='T1'");
    expect(teamTasks(db, "P", "A", "new")).toEqual([]);
    expect(teamTasks(db, "P", "B", "r").map((t) => t.id)).toEqual(["T1"]);
    db.run("UPDATE tasks SET stage='done' WHERE id='T1'");
    expect(teamTasks(db, "P", "B", "r")).toEqual([]);
  } finally { closeLedger(":memory:"); }
});
