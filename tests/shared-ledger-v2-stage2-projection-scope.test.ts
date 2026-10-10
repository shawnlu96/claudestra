/** S2P round-2 review findings: absent-card orphans, local project of the feature, first-migration workflows (incl. an empty first view), whole-card peer executor, corrupt extra. */
import { describe, expect, test } from "bun:test";
import { createTask } from "../src/lib/ledger-write.js";
import { activeOf, stepAtStage, stepsOf } from "../src/lib/ledger-steps.js";
import { getTask } from "../src/lib/ledger-store.js";
import { planIntent } from "../src/lib/ledger-scheduler-write.js";
import { paceCards } from "../src/lib/scheduler-yield.js";
import { landedCenterSeq, writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import { center, executionMode, intent, ledger, ref, tables, task, view, workflow } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

function caught(fn: () => unknown): Error & { code?: string } {
  try { fn(); } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected a refusal");
}
const { epoch: _epoch, ...planned } = executionMode.centerExecution!;

describe("S2P round-2 review fixes", () => {
  test("absent-orphan: a card leaving the view keeps its live center intent and lock and reports projection_orphan", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      writeExecutionProjection(l.db, view(10, { tasks: [task("T1")], intents: [intent("i1", "T1")] }), ref);
      const seen: string[] = [];
      const out = writeExecutionProjection(l.db, view(11, { tasks: [] }), { ...ref, observe: (t, c) => seen.push(`${t} ${c}`) });
      expect(out).toMatchObject({ kind: "written", orphans: ["i1"] });
      expect(seen).toEqual(["T1 projection_orphan:i1"]);
      expect(l.rows("SELECT id, status FROM scheduler_intents")).toEqual([{ id: "i1", status: "pending" }]);
      expect(l.rows("SELECT intentId FROM scheduler_resources")).toEqual([{ intentId: "i1" }]);
    } finally { l.close(); }
  });

  test("local-project-scope: a local feature row of another project refuses a new card with zero writes", () => {
    const l = ledger();
    try {
      l.db.prepare("INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt) "
        + "VALUES ('F','q','Other','', 'active', 0, 1, 'owner', 1, 1)").run();
      l.setMode(executionMode);
      const before = tables(l);
      const error = caught(() => writeExecutionProjection(l.db, view(10, { tasks: [task("T1")] }), ref));
      expect(error.code).toBe("conflict");
      expect(error.message.startsWith("projection_scope:")).toBe(true);
      expect(tables(l)).toEqual(before);
    } finally { l.close(); }
  });

  test("first-sync-absent-workflow: a stage-one card of the feature absent from the first migration view loses its workflow", () => {
    const l = ledger();
    try {
      l.setMode({ authorityMode: "planning", sharedPlanning: true, centerPlanned: planned });
      createTask(l.db, { actor: "owner", now: 100 }, { project: "p", id: "T1", title: "stage one", kind: "code", agent: "worker", extra: { sharedFeatureId: "F" } });
      l.db.prepare(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, rev, createdAt, updatedAt)
        VALUES ('T1', 'p', 'code', 2, 'auto', 'claude', 'codex', 1, 1, 100, 100)`).run();
      l.setMode({ authorityMode: "planning", sharedPlanning: true, centerPlanned: planned, migrating: { batchId: "B", kind: "execute" } });
      const v = view(10, { tasks: [task("T2")], workflows: [workflow("T2")], intents: [intent("p2", "T2")] });
      expect(writeExecutionProjection(l.db, v, { ...ref, batchId: "B", center }).kind).toBe("written");
      expect(l.rows("SELECT taskId FROM task_workflows")).toEqual([{ taskId: "T2" }]);
      expect(paceCards(l.db, { p: {} }, "auto").map(c => c.taskId)).toEqual(["T2"]);
    } finally { l.close(); }
  });

  test("first-empty-view: an empty first migration view drops the stage-one card's workflow and lands its watermark", () => {
    const l = ledger();
    try {
      l.setMode({ authorityMode: "planning", sharedPlanning: true, centerPlanned: planned });
      createTask(l.db, { actor: "owner", now: 100 }, { project: "p", id: "T1", title: "stage one", kind: "code", agent: "worker", extra: { sharedFeatureId: "F" } });
      l.db.prepare(`INSERT INTO task_workflows (taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, rev, createdAt, updatedAt)
        VALUES ('T1', 'p', 'code', 2, 'auto', 'claude', 'codex', 1, 1, 100, 100)`).run();
      const causalSeq = (l.db.query("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE project='p'").get() as { seq: number }).seq;
      planIntent(l.db, { actor: "scheduler", now: 200 }, { id: "i1", taskId: "T1", taskRev: getTask(l.db, "T1")!.rev, workflowRev: 1, causalSeq,
        node: "build", action: "dispatch", reason: "stage-one dispatch", resources: ["task:t1"] });
      l.setMode({ authorityMode: "planning", sharedPlanning: true, centerPlanned: planned, migrating: { batchId: "B", kind: "execute" } });
      expect(paceCards(l.db, { p: {} }, "auto").map(c => c.taskId)).toEqual(["T1"]);
      expect(writeExecutionProjection(l.db, view(10, { tasks: [] }), { ...ref, batchId: "B", center, observe: () => {} }))
        .toMatchObject({ kind: "written", centerSeq: 10, tasks: [], orphans: ["i1"] });
      expect(l.rows("SELECT taskId FROM task_workflows")).toEqual([]);
      // absent-guard: the absent stage-one card is guarded too, so a token-less delete of its live center lock changes nothing.
      expect(l.rows("SELECT taskId FROM v2_projection_guard")).toEqual([{ taskId: "T1" }]);
      expect(l.db.query("DELETE FROM scheduler_resources WHERE taskId = 'T1'").run().changes).toBe(0);
      expect(l.rows("SELECT intentId FROM scheduler_resources")).toEqual([{ intentId: "i1" }]);
      expect(paceCards(l.db, { p: {} }, "auto")).toEqual([]);
      expect(landedCenterSeq(l.db, "F")).toBe(10);
      expect(writeExecutionProjection(l.db, view(10, { tasks: [] }), { ...ref, batchId: "B", center }).kind).toBe("stale");
    } finally { l.close(); }
  });

  test("peer-without-steps: a whole-card remote executor reads back as agent@peer through the derived steps", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      const peerA = { kind: "peer_agent", instanceId: "peer-a", agentId: "worker" };
      writeExecutionProjection(l.db, view(10, { tasks: [task("T1", { executor: peerA, executorInstanceId: "peer-a" })] }), ref);
      const t = getTask(l.db, "T1")!;
      expect(t.extra.delegate).toBe("worker@peer-a-name");
      expect(activeOf(stepAtStage(stepsOf(l.db, t), t))).toEqual({ peer: "peer-a-name", agent: null });
    } finally { l.close(); }
  });

  test("extra-parse: a bound card with corrupt extra is refused with zero writes instead of being rebuilt from {}", () => {
    const l = ledger();
    try {
      l.setMode({ authorityMode: "planning", sharedPlanning: false });
      l.db.prepare("INSERT INTO features (id,project,title,ownerWords,status,currentVersion,rev,createdBy,createdAt,updatedAt) "
        + "VALUES ('F','p','Mine','', 'active', 0, 1, 'owner', 1, 1)").run();
      createTask(l.db, { actor: "owner", now: 100 }, { project: "p", id: "T1", title: "stage one", kind: "code", agent: "worker" });
      l.db.prepare("UPDATE tasks SET featureId = 'F', extra = '{broken' WHERE id = 'T1'").run();
      l.setMode(executionMode);
      const before = tables(l);
      const error = caught(() => writeExecutionProjection(l.db, view(10, { tasks: [task("T1")] }), ref));
      expect(error.code).toBe("conflict");
      expect(error.message.startsWith("projection_extra:")).toBe(true);
      expect(tables(l)).toEqual(before);
    } finally { l.close(); }
  });
});
