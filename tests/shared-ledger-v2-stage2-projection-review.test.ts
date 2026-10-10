/** S2P round-1 review findings: empty-view watermark, guard follows the local mode, full task fields, absent workflows, peer identity. */
import { describe, expect, test } from "bun:test";
import { createTask } from "../src/lib/ledger-write.js";
import { activeOf, stepPeer, type TaskStep } from "../src/lib/ledger-steps.js";
import { paceCards } from "../src/lib/scheduler-yield.js";
import { PROJECTION_ACTOR } from "../src/lib/shared-ledger-v2-write-gate.js";
import { centerTaskFields } from "../src/lib/shared-ledger-v2-projection-rows.js";
import { landedCenterSeq, writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import { center, executionMode, HEAD_A, intent, ledger, ref, step, tables, task, view, workflow } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

function caught(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected a refusal");
}
const peerA = { kind: "peer_agent", instanceId: "peer-a", agentId: "worker" };

describe("S2P review fixes", () => {
  test("empty-seq: an empty view lands its serverSeq on the absent cards; an older view is then stale; nothing to anchor is refused", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      const before = tables(l);
      const empty = caught(() => writeExecutionProjection(l.db, view(5, { tasks: [] }), ref));
      expect(empty).toMatchObject({ code: "conflict" });
      expect((empty as Error).message.startsWith("projection_empty:")).toBe(true);
      expect(tables(l)).toEqual(before);

      writeExecutionProjection(l.db, view(10, { tasks: [task("T1")] }), ref);
      expect(writeExecutionProjection(l.db, view(20, { tasks: [] }), ref)).toMatchObject({ kind: "written", centerSeq: 20, tasks: [] });
      expect(landedCenterSeq(l.db, "F")).toBe(20);
      expect(l.rows("SELECT target, data FROM events WHERE actor = ? ORDER BY seq DESC LIMIT 1", PROJECTION_ACTOR).map(e => [e.target, JSON.parse(e.data as string)]))
        .toEqual([["T1", { op: "center-projection", centerFeatureId: "feature", serverSeq: 20, absent: true, centerSeq: 20, featureId: "F" }]]);
      const after = tables(l);
      expect(writeExecutionProjection(l.db, view(15, { tasks: [task("T1", { stage: "review" })] }), ref)).toMatchObject({ kind: "stale", landed: 20 });
      expect(tables(l)).toEqual(after);
    } finally { l.close(); }
  });

  test("guard-mode: a planning view cannot release an execution feature's guard; only a controlled revert does", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      const d = intent("d1", "T1", { status: "submitted" });
      writeExecutionProjection(l.db, view(10, { tasks: [task("T1")], intents: [d] }), ref);
      const planning = (seq: number) => view(seq, { tasks: [task("T1")], intents: [d] }, { authorityMode: "planning" });
      const refused = caught(() => writeExecutionProjection(l.db, planning(11), ref));
      expect(refused).toMatchObject({ code: "conflict" });
      expect((refused as Error).message.startsWith("projection_scope:")).toBe(true);
      expect(l.rows("SELECT taskId FROM v2_projection_guard")).toEqual([{ taskId: "T1" }]);
      expect(l.db.query("DELETE FROM scheduler_resources WHERE intentId='d1'").run().changes).toBe(0);
      expect(l.rows("SELECT intentId FROM scheduler_resources")).toEqual([{ intentId: "d1" }]);

      // migrating execute keeps guarding even when the center still reports planning.
      const { epoch: _epoch, ...planned } = executionMode.centerExecution!;
      l.setMode({ authorityMode: "planning", sharedPlanning: true, centerPlanned: planned, migrating: { batchId: "B", kind: "execute" } });
      expect(writeExecutionProjection(l.db, planning(12), { ...ref, batchId: "B", center }).kind).toBe("written");
      expect(l.rows("SELECT taskId FROM v2_projection_guard")).toEqual([{ taskId: "T1" }]);
      // A revert batch landing the execution view still guards; its planning view releases.
      l.setMode({ authorityMode: "planning", sharedPlanning: true, centerPlanned: planned, migrating: { batchId: "R", kind: "revert" } });
      expect(writeExecutionProjection(l.db, view(13, { tasks: [task("T1")], intents: [d] }), { ...ref, batchId: "R", center }).kind).toBe("written");
      expect(l.rows("SELECT taskId FROM v2_projection_guard")).toEqual([{ taskId: "T1" }]);
      expect(writeExecutionProjection(l.db, planning(14), { ...ref, batchId: "R", center }).kind).toBe("written");
      expect(l.rows("SELECT taskId FROM v2_projection_guard")).toEqual([]);
    } finally { l.close(); }
  });

  test("task-fields: plan / collaboration / review / delivery land in extra.centerTask and the event; home-only extra keys stay", () => {
    const l = ledger();
    try {
      l.setMode({ authorityMode: "planning", sharedPlanning: false });
      createTask(l.db, { actor: "owner", now: 100 }, { project: "p", id: "T1", title: "stage one", kind: "code", agent: "worker",
        extra: { sharedFeatureId: "F", reviewer: "old-reviewer", homeNote: "kept" } });
      l.setMode(executionMode);
      const t = task("T1", { plan: "PLAN-MARK", collaboration: { reviewer: { ...peerA, agentId: "rv" }, delegate: { kind: "agent", instanceId: "local", agentId: "dl" } },
        review: { verdict: "pass", reviewedHead: HEAD_A, reportArtifactId: "report-mark" },
        delivery: { orderId: "order-mark", summary: "SUMMARY-MARK", artifactIds: ["artifact-mark"] } });
      writeExecutionProjection(l.db, view(10, { tasks: [t] }), ref);
      const extra = JSON.parse(l.rows("SELECT extra FROM tasks WHERE id='T1'")[0]!.extra as string);
      expect(extra).toEqual({ sharedFeatureId: "F", reviewer: "rv@peer-a-name", homeNote: "kept", centerTask: centerTaskFields(t as never), delegate: "dl" });
      expect(extra.centerTask).toMatchObject({ plan: "PLAN-MARK", review: { reportArtifactId: "report-mark" },
        delivery: { orderId: "order-mark", summary: "SUMMARY-MARK", artifactIds: ["artifact-mark"] } });
      const event = JSON.parse(l.rows("SELECT data FROM events WHERE actor = ? ORDER BY seq DESC LIMIT 1", PROJECTION_ACTOR)[0]!.data as string);
      expect(event.task).toEqual(centerTaskFields(t as never));

      // The center clears the reviewer and the delivery: center-owned keys follow, home keys stay.
      const t2 = task("T1", { rev: 2, updatedAt: 2000 });
      writeExecutionProjection(l.db, view(11, { tasks: [t2] }), ref);
      expect(JSON.parse(l.rows("SELECT extra FROM tasks WHERE id='T1'")[0]!.extra as string))
        .toEqual({ sharedFeatureId: "F", homeNote: "kept", centerTask: centerTaskFields(t2 as never) });
    } finally { l.close(); }
  });

  test("workflow-absence: a card that leaves the view loses its workflow and drops out of paceCards", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      writeExecutionProjection(l.db, view(10, { tasks: [task("T1")], workflows: [workflow("T1")], intents: [intent("p1", "T1")] }), ref);
      expect(paceCards(l.db, { p: {} }, "auto").map(c => c.taskId)).toEqual(["T1"]);
      expect(writeExecutionProjection(l.db, view(11, { tasks: [] }), ref).kind).toBe("written");
      expect(l.rows("SELECT taskId FROM task_workflows")).toEqual([]);
      expect(paceCards(l.db, { p: {} }, "auto")).toEqual([]);
      expect(l.rows("SELECT id, status FROM scheduler_intents")).toEqual([{ id: "p1", status: "pending" }]); // intents are never deleted
    } finally { l.close(); }
  });

  test("peer-identity: remote executors keep agent@peer / fp/agent coordinates; an unmapped instance is refused with zero writes", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      writeExecutionProjection(l.db, view(10, { tasks: [task("T1", { executor: peerA, executorInstanceId: "peer-a" })], steps: [step("T1", { executor: peerA })] }), ref);
      expect(l.rows("SELECT agent, assigneeKind, assignee FROM tasks WHERE id='T1'")).toEqual([{ agent: null, assigneeKind: "peer_agent", assignee: "fp-a/worker" }]);
      const s = l.rows("SELECT * FROM task_steps WHERE taskId='T1'")[0] as TaskStep;
      expect([s.executor, s.executorKind, stepPeer(s)]).toEqual(["worker@peer-a-name", "peer", "peer-a-name"]);
      expect(activeOf(s)).toEqual({ peer: "peer-a-name", agent: null });

      const before = tables(l);
      const stranger = { kind: "peer_agent", instanceId: "peer-z", agentId: "worker" };
      for (const [v, r] of [[view(11, { tasks: [task("T1")], steps: [step("T1", { executor: stranger })] }), ref],
        [view(11, { tasks: [task("T1")] }), { ...ref, identity: undefined }]] as const) {
        const error = caught(() => writeExecutionProjection(l.db, v, r));
        expect(error).toMatchObject({ code: "conflict" });
        expect((error as Error).message.startsWith("v2_unmapped:")).toBe(true);
        expect(tables(l)).toEqual(before);
      }
    } finally { l.close(); }
  });
});
