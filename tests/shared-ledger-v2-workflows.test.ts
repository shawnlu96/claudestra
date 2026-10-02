import { expect, test } from "bun:test";
import { parseStep, parseWorkflow } from "../src/lib/shared-ledger-contract-v2";
import { readTask } from "../src/shared-ledger/exec-tasks";
import { createWorkflow, readSteps, readWorkflow, recordStepOutcome } from "../src/shared-ledger/exec-workflows";
import { stepColumns, workflowColumns } from "../src/shared-ledger/exec-workflows/schema";
import { command, harness, unchanged } from "./shared-ledger-v2-workflows-harness.test";

const h40 = "b".repeat(40), c40 = "c".repeat(40);
const wf = (payload: Record<string, unknown> = {}, requestId?: string) => command("workflow.set", payload, requestId);
const assign = (payload: Record<string, unknown> = {}, requestId?: string) => command("step.assign", payload, requestId);

test("task_steps / task_workflows schema follows the X0 DTO fields and workflowRev starts at 1", () => {
  const h = harness();
  const cols = (table: string) => (h.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
  expect(cols("task_workflows")).toEqual(Object.keys(workflowColumns));
  expect(cols("task_steps")).toEqual(Object.keys(stepColumns));
  const w = h.tx(ctx => readWorkflow(ctx, "task"));
  expect(parseWorkflow(w)).toEqual(w);
  expect(w).toMatchObject({ taskId: "task", mode: "manual", rev: 1, specRev: 1, fallback: ["claude"] });
  // Creation is a single manual row; it cannot be used to mint a second workflow or start in auto.
  expect(() => h.tx(ctx => createWorkflow(ctx, readTask(ctx, "task"),
    { template: "code", templateVersion: 1, authorFamily: "codex", fallback: [] }))).toThrow("conflict");
});

test("schema triggers enforce rev+1 updates and forbid deletes even outside the domain", () => {
  const h = harness();
  expect(() => h.db.run("UPDATE task_workflows SET mode='auto' WHERE taskId='task'")).toThrow("revision");
  expect(() => h.db.run("UPDATE task_workflows SET mode='auto', rev=5 WHERE taskId='task'")).toThrow("revision");
  expect(() => h.db.run("UPDATE task_workflows SET taskId='other', rev=2 WHERE taskId='task'")).toThrow("revision");
  expect(() => h.db.run("DELETE FROM task_workflows")).toThrow("immutable");
  expect(h.row("task_workflows", "taskId='task'")[0]).toMatchObject({ mode: "manual", rev: 1 });
});

test("workflow.set is the mode path and requires workflowRev CAS", () => {
  const h = harness();
  unchanged(h, () => h.run(wf({ mode: "observe", expectedWorkflowRev: 2 })), "conflict");
  unchanged(h, () => h.run(wf({ mode: "observe", expectedRev: 2 })), "conflict");
  unchanged(h, () => h.run(wf({ mode: "observe", expectedSpecRev: 2 })), "conflict");
  const receipt = h.run(wf({ mode: "observe" }));
  expect(receipt.result).toMatchObject({ entityId: "task", rev: 2, specRev: 1 });
  expect(h.tx(ctx => readWorkflow(ctx, "task"))).toMatchObject({ mode: "observe", rev: 2, updatedAt: 2000 });
  // A replay of the old revision cannot win; a retry of the same request returns the stored receipt.
  unchanged(h, () => h.run(wf({ mode: "manual" }, "request-replay")), "conflict");
  h.calls.length = 0;
  expect(h.run(wf({ mode: "observe" }))).toEqual(receipt);
  expect(h.calls).toEqual(["workflow.set", "wf:workflow.set"]);
  expect(h.row("exec_events").length).toBe(1);
});

test("auto mode needs an authorization ask and the per-action check; failures write nothing", () => {
  const h = harness();
  expect(() => wf({ mode: "auto" })).toThrow("invalid_field");
  h.denied.add("wf:workflow.set");
  unchanged(h, () => h.run(wf({ mode: "auto", authorizationAskId: "ask" })), "forbidden");
  h.denied.clear();
  h.run(wf({ mode: "auto", authorizationAskId: "ask" }));
  expect(h.tx(ctx => readWorkflow(ctx, "task")).mode).toBe("auto");
  unchanged(h, () => h.run(wf({ mode: "manual", authorFamily: "codex", fallback: ["codex"], expectedWorkflowRev: 2 }, "r2")), "invalid_field");
});

test("generic task.set and execution commands cannot change the workflow mode", () => {
  const h = harness();
  expect(() => command("task.set", { patch: { mode: "auto" } })).toThrow("invalid_field");
  expect(() => command("step.assign", { mode: "auto" })).toThrow("invalid_field");
  h.runTask(command("task.set", { patch: { title: "新标题" } }));
  expect(h.tx(ctx => readWorkflow(ctx, "task"))).toMatchObject({ mode: "manual", rev: 1 });
});

test("a new specRev makes the workflow stale until workflow.set re-binds it", () => {
  const h = harness();
  h.runTask(command("task.spec"));
  unchanged(h, () => h.run(assign({ expectedRev: 2, expectedSpecRev: 2 })), "conflict");
  // X1 reads this domain's workflow and refuses execution against a stale workflow specRev.
  expect(() => h.runTask(command("task.stage", { expectedRev: 2, expectedSpecRev: 2 }))).toThrow("conflict");
  h.run(wf({ expectedRev: 2, expectedSpecRev: 2 }));
  expect(h.tx(ctx => readWorkflow(ctx, "task"))).toMatchObject({ specRev: 2, rev: 2 });
  h.run(assign({ expectedRev: 2, expectedSpecRev: 2, expectedWorkflowRev: 2 }));
  expect(h.tx(ctx => readSteps(ctx, "task"))[0]).toMatchObject({ step: "write", state: "assigned", rev: 1 });
});

test("step.assign creates and reassigns only open steps of the current round from home", () => {
  const h = harness();
  unchanged(h, () => h.run(assign({ round: 1 })), "conflict");
  unchanged(h, () => h.run(assign(), { ...h.scope, actor: { ...h.scope.actor, instanceId: "peer-a" } }), "wrong_home");
  unchanged(h, () => h.run(assign(), { ...h.scope, actor: { ...h.scope.actor, kind: "service", serviceId: "service",
    representedPersonId: "person", orderId: "order" } }), "forbidden");
  unchanged(h, () => h.run(assign(), { ...h.scope, epoch: 2 }), "stale_epoch");
  const first = h.run(assign());
  expect(first.result).toMatchObject({ entityId: "task", rev: 1 });
  const step = h.tx(ctx => readSteps(ctx, "task"))[0];
  expect(parseStep(step)).toEqual(step);
  expect(step).toMatchObject({ state: "assigned", headFrom: h40, executor: { instanceId: "local" } });
  h.run(assign({ executor: { kind: "peer_agent", instanceId: "peer-a", agentId: "worker" } }, "reassign"));
  expect(h.tx(ctx => readSteps(ctx, "task"))[0]).toMatchObject({ rev: 2, executor: { instanceId: "peer-a" } });
});

test("step outcomes move forward only and keep source claims apart from central evidence", () => {
  const h = harness();
  h.run(assign());
  const verified = { author: { kind: "agent", instanceId: "local", agentId: "worker" } as const, independentReviewer: false,
    verifiedHead: c40, evidenceArtifactIds: ["artifact"] };
  const claims = { family: "codex", model: "m", summary: "源端自述" } as const;
  const outcome = { taskId: "task", step: "write", round: 0, expectedRev: 1, headTo: c40, verdict: null, verified, claims } as const;
  expect(() => h.tx(ctx => recordStepOutcome(ctx, { ...outcome, state: "done", verified: { ...verified, verifiedHead: h40 } })))
    .toThrow("conflict");
  expect(() => h.tx(ctx => recordStepOutcome(ctx, { ...outcome, expectedRev: 5, state: "delivered" }))).toThrow("conflict");
  h.tx(ctx => recordStepOutcome(ctx, { ...outcome, state: "delivered" }));
  h.tx(ctx => recordStepOutcome(ctx, { ...outcome, expectedRev: 2, state: "done", verdict: "pass" }));
  expect(h.tx(ctx => readSteps(ctx, "task"))[0]).toMatchObject({ state: "done", rev: 3, verdict: "pass", headTo: c40, claims });
  expect(() => h.tx(ctx => recordStepOutcome(ctx, { ...outcome, expectedRev: 3, state: "delivered" }))).toThrow("conflict");
  // A finished step is history: reassigning the same round would overwrite its evidence.
  unchanged(h, () => h.run(assign({}, "again")), "conflict");
});

test("unsupported commands, foreign scope and denied roles are rejected before any write", () => {
  const h = harness();
  unchanged(h, () => h.run(command("task.set" as never)), "invalid_field");
  unchanged(h, () => h.run({ ...assign(), projectId: "other" }), "forbidden");
  unchanged(h, () => h.run(assign(), { ...h.scope, actor: { ...h.scope.actor, actions: ["workflow.set"] } }), "forbidden");
  h.denied.add("step.assign");
  unchanged(h, () => h.run(assign()), "forbidden");
  h.denied.clear();
  h.putFeature({ authorityMode: "planning" });
  unchanged(h, () => h.run(assign()), "execution_not_shared");
});
