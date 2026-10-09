import { describe, expect, test } from "bun:test";
import { createTask, setTask } from "../src/lib/ledger-write.js";
import { getTask, LedgerError } from "../src/lib/ledger-store.js";
import { paceCards } from "../src/lib/scheduler-yield.js";
import { PROJECTION_ACTOR } from "../src/lib/shared-ledger-v2-write-gate.js";
import { releaseProjectionGuard, syncExecutionProjection, writeExecutionProjection } from "../src/lib/shared-ledger-v2-projection.js";
import { center, dep, executionMode, HEAD_A, HEAD_B, intent, ledger, ref, step, tables, task, view, workflow, type Ledger } from "./shared-ledger-v2-stage2-projection-fixture.test.js";

function projectionEvents(l: Ledger) {
  return l.rows("SELECT actor, target, kind, data FROM events WHERE actor = ? ORDER BY seq", PROJECTION_ACTOR)
    .map(e => ({ target: e.target as string, kind: e.kind as string, data: JSON.parse(e.data as string) }));
}
function caught(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error("expected a refusal");
}

describe("S2P projection writer (real S2G gate, temp ledger)", () => {
  test("v1 creates a build / round 2 card with steps; v2 moves stage / head; every table re-upserts under tracking", async () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      const d = intent("d1", "T1"), v1 = view(10, { tasks: [task("T1"), task("T2", { stage: "spec", round: 0 })], deps: [dep("T1", "T2")],
        steps: [step("T1")], workflows: [workflow("T1", { mode: "manual" })], intents: [d] });
      expect(writeExecutionProjection(l.db, v1, ref)).toMatchObject({ kind: "written", centerSeq: 10, tasks: ["T1", "T2"] });
      expect(l.rows("SELECT id, project, title, kind, stage, stageBefore, round, agent, assigneeKind, assignee, pm, branch, pr, headSHA, spec, specRev, rev, extra FROM tasks WHERE id='T1'"))
        .toEqual([{ id: "T1", project: "p", title: "card T1", kind: "code", stage: "build", stageBefore: null, round: 2, agent: "worker",
          assigneeKind: "agent", assignee: "worker", pm: null, branch: "feat/example", pr: "https://github.com/team/repository/pull/7",
          headSHA: HEAD_A, spec: "规格仅在主场", specRev: 1, rev: 1, extra: JSON.stringify({ sharedFeatureId: "F" }) }]);
      expect(l.rows("SELECT taskId, step, round, executor, executorKind, state, verified, claims FROM task_steps")).toEqual([{ taskId: "T1", step: "write",
        round: 2, executor: "worker", executorKind: "agent", state: "assigned", verified: JSON.stringify(v1.steps[0].verified), claims: JSON.stringify(v1.steps[0].claims) }]);
      expect(l.rows("SELECT project, fromTask, toTask, kind, cond, state, createdBy FROM task_deps"))
        .toEqual([{ project: "p", fromTask: "T1", toTask: "T2", kind: "blocks", cond: "after", state: "waiting", createdBy: "person" }]);

      const v2 = view(12, { tasks: [task("T1", { stage: "review", head: HEAD_B, rev: 2, updatedAt: 2000 }), task("T2", { stage: "spec", round: 0 })],
        deps: [dep("T1", "T2", { state: "active", rev: 2 })], steps: [step("T1", { state: "delivered", headTo: HEAD_B, rev: 2 })],
        workflows: [workflow("T1", { mode: "manual", rev: 2 })], intents: [{ ...d, status: "submitted", attempts: 1, updatedAt: 1800 }] });
      expect(writeExecutionProjection(l.db, v2, ref).kind).toBe("written");
      expect(l.rows("SELECT stage, headSHA, round, rev, updatedAt FROM tasks WHERE id='T1'")).toEqual([{ stage: "review", headSHA: HEAD_B, round: 2, rev: 2, updatedAt: 2000 }]);
      expect(l.rows("SELECT state, rev FROM task_deps")).toEqual([{ state: "active", rev: 2 }]);
      expect(l.rows("SELECT state, headTo, rev FROM task_steps")).toEqual([{ state: "delivered", headTo: HEAD_B, rev: 2 }]);
      expect(l.rows("SELECT rev FROM task_workflows")).toEqual([{ rev: 2 }]);
      expect(l.rows("SELECT id, taskId, project, node, action, causalSeq, eventSeq, taskRev, specRev, head, templateVersion, status, attempts, reason FROM scheduler_intents"))
        .toEqual([{ id: "d1", taskId: "T1", project: "p", node: "write", action: "dispatch", causalSeq: 3, eventSeq: 5, taskRev: 1, specRev: 1,
          head: HEAD_A, templateVersion: 1, status: "submitted", attempts: 1, reason: "center d1" }]);
      expect(l.rows("SELECT project, resource, taskId, intentId, scope, acquiredAt FROM scheduler_resources")).toEqual([{ project: "p",
        resource: JSON.stringify(["team", "project", "team/repository", "file", "src/d1.ts"]), taskId: "T1", intentId: "d1", scope: "intent", acquiredAt: 1500 }]);

      const events = projectionEvents(l);
      expect(events.map(e => [e.target, e.kind, e.data.op, e.data.centerSeq, e.data.featureId])).toEqual([
        ["T1", "task", "center-projection", 10, "F"], ["T2", "task", "center-projection", 10, "F"],
        ["T1", "task", "center-projection", 12, "F"], ["T2", "task", "center-projection", 12, "F"]]);
      expect(events[2]!.data.intents).toEqual([{ id: "d1", centerId: "c-d1", action: "dispatch", status: "submitted", fence: { serviceGeneration: 1, epoch: 1, bootId: "boot-local" } }]);

      // Acceptance 3: owner's auto workflow + pending intent feed the real scheduler input; removal drops the card.
      const v3 = view(13, { tasks: [...v2.tasks, task("T3", { stage: "build" })], deps: v2.deps, steps: v2.steps,
        workflows: [...v2.workflows, workflow("T3")], intents: [...v2.intents, intent("p3", "T3")] });
      const sync = syncExecutionProjection(l.db, { snapshot: async (p, featureId) => (expect([p, featureId]).toEqual(["p", "F"]), v3) });
      expect((await sync("p", "F")).kind).toBe("written");
      expect(paceCards(l.db, { p: {} }, "auto").map(c => c.taskId)).toEqual(["T3"]);
      expect(l.rows("SELECT * FROM scheduler_intents WHERE id='p3'")).toEqual([{ id: "p3", taskId: "T3", project: "p", node: "write", action: "dispatch",
        recipient: null, causalSeq: 3, eventSeq: 5, taskRev: 1, specRev: 1, head: HEAD_A, templateVersion: 1, status: "pending", attempts: 0,
        receipt: null, reason: "center p3", createdAt: 1000, updatedAt: 1000 }]);
      expect(l.rows("SELECT taskId, project, template, templateVersion, mode, authorFamily, fallback, specRev, rev FROM task_workflows WHERE taskId='T3'"))
        .toEqual([{ taskId: "T3", project: "p", template: "code", templateVersion: 2, mode: "auto", authorFamily: "claude", fallback: "codex", specRev: 1, rev: 1 }]);
      const v4 = { ...v3, serverSeq: 14, workflows: v2.workflows };
      expect(writeExecutionProjection(l.db, v4, ref).kind).toBe("written");
      expect(paceCards(l.db, { p: {} }, "auto")).toEqual([]);
      expect(l.rows("SELECT taskId FROM task_workflows ORDER BY taskId")).toEqual([{ taskId: "T1" }]);
      const seqs = projectionEvents(l).map(e => e.data.centerSeq as number);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally { l.close(); }
  });

  test("old / equal serverSeq writes nothing; cross-feature / cross-project views are refused; owner writes stay gated", () => {
    const l = ledger();
    try {
      l.setMode(executionMode);
      writeExecutionProjection(l.db, view(10, { tasks: [task("T1")] }), ref);
      const before = tables(l);
      for (const seq of [10, 9]) expect(writeExecutionProjection(l.db, view(seq, { tasks: [task("T1", { stage: "review" })] }), ref)).toMatchObject({ kind: "stale", landed: 10 });
      const other = view(11, { tasks: [task("T1")] });
      const crossFeature = { ...other, feature: { ...other.feature, id: "feature-other" }, tasks: [task("T1", { featureId: "feature-other" })] };
      const scoped = (projectId: string) => ({ ...other, projectId, feature: { ...other.feature, projectId }, tasks: [task("T1", { projectId })] });
      for (const bad of [crossFeature, scoped("project-other")]) {
        const error = caught(() => writeExecutionProjection(l.db, bad, ref));
        expect(error).toBeInstanceOf(LedgerError);
        expect(error).toMatchObject({ code: "conflict" });
        expect((error as Error).message.startsWith("projection_scope:")).toBe(true);
      }
      expect(caught(() => writeExecutionProjection(l.db, other, { ...ref, project: "p-other" }))).toMatchObject({ code: "conflict" });
      expect(caught(() => writeExecutionProjection(l.db, { ...other, tasks: "x" }, ref))).toMatchObject({ code: "invalid" });
      expect(tables(l)).toEqual(before);
      const owner = caught(() => setTask(l.db, { actor: "owner", now: 6000 }, { id: "T1", rev: getTask(l.db, "T1")!.rev, patch: { title: "local" } }));
      expect(owner).toBeInstanceOf(LedgerError);
      // S2G's gate refuses with its existing LedgerError code (not a new one); the message prefix names the gate.
      expect(owner).toMatchObject({ code: "forbidden" });
      expect((owner as Error).message.startsWith("execution / migrating 卡禁止本机写入")).toBe(true);
      expect(tables(l)).toEqual(before);
    } finally { l.close(); }
  });

  test("migrating feature: batch B writes an existing stage-one card; another batch or none is refused", () => {
    const l = ledger();
    try {
      l.setMode({ authorityMode: "planning", sharedPlanning: false });
      createTask(l.db, { actor: "owner", now: 100 }, { project: "p", id: "T1", title: "stage one", kind: "code", agent: "worker", extra: { sharedFeatureId: "F" } });
      l.setMode({ authorityMode: "planning", sharedPlanning: false, migrating: { batchId: "B", kind: "execute" } });
      const v = view(20, { tasks: [task("T1", { stage: "review", head: HEAD_B })] }), before = tables(l);
      for (const batchId of ["B-other", undefined]) {
        expect(caught(() => writeExecutionProjection(l.db, v, { ...ref, center, ...(batchId ? { batchId } : {}) }))).toMatchObject({ code: "forbidden" });
        expect(tables(l)).toEqual(before);
      }
      expect(caught(() => writeExecutionProjection(l.db, v, { ...ref, batchId: "B" }))).toMatchObject({ code: "conflict" }); // no center binding
      expect(writeExecutionProjection(l.db, v, { ...ref, batchId: "B", center }).kind).toBe("written");
      expect(l.rows("SELECT stage, headSHA, extra FROM tasks WHERE id='T1'")).toEqual([{ stage: "review", headSHA: HEAD_B, extra: JSON.stringify({ sharedFeatureId: "F" }) }]);
      expect(projectionEvents(l).map(e => [e.target, e.data.centerSeq])).toEqual([["T1", 20]]);
      expect(l.rows("SELECT taskId FROM v2_projection_guard")).toEqual([{ taskId: "T1" }]);
      // X13B after clearing migrating: guards of a feature no longer execution / migrating are released.
      expect(caught(() => releaseProjectionGuard(l.db, ref))).toMatchObject({ code: "conflict" });
      l.setMode({ authorityMode: "planning", sharedPlanning: false });
      expect(releaseProjectionGuard(l.db, ref)).toEqual(["T1"]);
      expect(l.rows("SELECT taskId FROM v2_projection_guard")).toEqual([]);
    } finally { l.close(); }
  });
});
