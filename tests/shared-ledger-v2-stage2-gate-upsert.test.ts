import { describe, expect, test } from "bun:test";
import * as writes from "../src/lib/ledger-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { tx } from "../src/lib/ledger-tx.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { execution, fixture, rejected } from "./shared-ledger-v2-stage2-gate-helpers.test.js";

// S2G2 r1 upsert-aborts-under-tracking: the tracker must not turn the DO UPDATE branch of an UPSERT into a gate_rows key conflict.
describe("S2G2 UPSERT under execution tracking", () => {
  test("project-level and unshared-card UPSERTs keep working", () => {
    const f = fixture();
    try {
      writes.createTask(f.db, f.owner, { project: "p", id: "local", title: "local", kind: "code", agent: "agent-one" });
      writes.setMeta(f.db, f.owner, { project: "p", key: "pms", value: ["pm-one"] });
      f.setMode(execution);
      expect(writes.setMeta(f.db, f.owner, { project: "p", key: "pms", value: ["pm-two"] }).row.pms).toEqual(["pm-two"]);
      writes.setFrozen(f.db, f.owner, { project: "p", frozen: true, reason: "hold" });
      writes.setFrozen(f.db, f.owner, { project: "p", frozen: false });
      expect(writes.setFrozen(f.db, f.owner, { project: "p", frozen: true, reason: "again" }).row.queueFrozen.frozen).toBe(true);
      const input = { taskId: "local", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "hold" } as const;
      setWorkflow(f.db, f.owner, { ...input, taskRev: getTask(f.db, "local")!.rev });
      expect(setWorkflow(f.db, f.owner, { ...input, authorFamily: "codex", taskRev: getTask(f.db, "local")!.rev, workflowRev: 1 }).workflow)
        .toMatchObject({ authorFamily: "codex", rev: 2 });
      f.db.query("UPDATE tasks SET stage='build' WHERE id='local'").run();
      assignStep(f.db, f.owner, { taskId: "local", step: "write", executor: "agent-one", executorKind: "agent" });
      expect(assignStep(f.db, f.owner, { taskId: "local", step: "write", executor: "agent-two", executorKind: "agent" }).row[0])
        .toMatchObject({ executor: "agent-two", rev: 2 });
      expect(writes.moveStage(f.db, f.owner, { taskId: "local", from: "build", to: "review" }).row.stage).toBe("review");
      expect(f.db.query("SELECT state FROM task_steps WHERE taskId='local' AND step='write'").get()).toEqual({ state: "delivered" });
    } finally { f.close(); }
  });
  test("an UPSERT rewriting a shared execution card is refused by the gate", () => {
    const f = fixture();
    try {
      f.setMode(execution);
      rejected(f, () => tx(f.db, () => f.db.query(`INSERT INTO tasks (id,project,title,kind,stage,rev,extra,createdAt,updatedAt)
        SELECT id,project,'upserted',kind,stage,rev,extra,createdAt,updatedAt FROM tasks WHERE id='T' ON CONFLICT (id) DO UPDATE SET title=excluded.title`).run()));
    } finally { f.close(); }
  });
});

// S2G2 r1 gate-rows-not-cleared-on-begin: a leftover origin image (e.g. a swallowed endTracking failure) must not be reused.
test("S2G2 beginTracking discards leftover gate_rows", () => {
  const f = fixture();
  try {
    writes.createTask(f.db, f.owner, { project: "p", id: "local", title: "local", kind: "code" });
    f.setMode(execution);
    writes.setTask(f.db, f.owner, { id: "local", rev: 1, patch: { title: "installs the tracker" } });
    const row = f.db.query("SELECT rowid AS rid, * FROM tasks WHERE id='T'").get() as Record<string, unknown>;
    const { rid, ...task } = row;
    f.db.query("INSERT INTO temp.gate_rows VALUES ('tasks', ?, ?)").run(rid as number, JSON.stringify({ ...task, featureId: null, extra: "{}" }));
    rejected(f, () => writes.setTask(f.db, f.owner, { id: "T", rev: 1, patch: { title: "stale origin" } }));
  } finally { f.close(); }
});
