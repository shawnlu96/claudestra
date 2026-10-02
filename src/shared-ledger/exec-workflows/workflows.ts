import {
  fail, parseExecutor, parseStep, parseWorkflow,
  type V2Step, type V2Task, type V2Workflow, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { authorizeWorkflow, featureGate, loadTask, type WorkflowCommand, type WorkflowsDependencies } from "./policy.js";
import { checkScope, findStep, readWorkflow, saveRow } from "./storage.js";

type SetCommand = Extract<WorkflowCommand, { type: "workflow.set" }>;
type AssignCommand = Extract<WorkflowCommand, { type: "step.assign" }>;

/** Shared execution CAS: task rev/specRev, workflowRev and feature execution/epoch, all read in this transaction. */
function executionGate(ctx: V2TransactionContext, deps: WorkflowsDependencies, command: WorkflowCommand): { task: V2Task; workflow: V2Workflow } {
  const p = command.payload, task = loadTask(ctx, deps, p.taskId);
  const feature = featureGate(ctx, deps, task.featureId);
  if (task.homeInstanceId !== feature.homeInstanceId) fail("wrong_home");
  if (task.rev !== p.expectedRev || task.specRev !== p.expectedSpecRev) fail("conflict");
  const workflow = readWorkflow(ctx, task.id);
  checkScope(ctx, workflow);
  if (workflow.rev !== p.expectedWorkflowRev) fail("conflict");
  authorizeWorkflow(ctx, deps, command, task);
  return { task, workflow };
}
/** The only path that changes template/mode/families. It re-binds the workflow to the task's current specRev. */
export function applyWorkflowSet(ctx: V2TransactionContext, deps: WorkflowsDependencies, command: SetCommand): V2Workflow {
  const { task, workflow } = executionGate(ctx, deps, command);
  const { template, templateVersion, mode, authorFamily, fallback } = command.payload;
  if (fallback.includes(authorFamily)) fail();
  const next = parseWorkflow({ ...workflow, template, templateVersion, mode, authorFamily, fallback,
    specRev: task.specRev, rev: workflow.rev + 1, updatedAt: ctx.scope.now });
  return saveRow(ctx, "task_workflows", next, workflow.rev);
}
export function applyStepAssign(ctx: V2TransactionContext, deps: WorkflowsDependencies, command: AssignCommand): V2Step {
  const { task, workflow } = executionGate(ctx, deps, command);
  const p = command.payload;
  if (workflow.specRev !== task.specRev) fail("conflict");
  if (ctx.scope.actor.instanceId !== task.homeInstanceId) fail("wrong_home");
  if (p.round !== task.round || task.stage === "done" || task.stage === "cancelled") fail("conflict");
  const executor = parseExecutor(p.executor), current = findStep(ctx, task.id, p.step, p.round), now = ctx.scope.now;
  if (!current) {
    return saveRow(ctx, "task_steps", parseStep({ teamId: ctx.scope.teamId, projectId: ctx.scope.projectId, taskId: task.id,
      step: p.step, round: p.round, executor, state: "assigned", headFrom: task.head, headTo: null, verdict: null,
      verified: { author: null, independentReviewer: false, verifiedHead: null, evidenceArtifactIds: [] },
      claims: { family: null, model: null, summary: "" }, rev: 1, createdAt: now, updatedAt: now }));
  }
  // Delivered/done steps are history: reassigning would overwrite evidence, so a new round is required.
  if (current.state !== "assigned") fail("conflict");
  return saveRow(ctx, "task_steps", { ...current, executor, headFrom: task.head, rev: current.rev + 1, updatedAt: now }, current.rev);
}
/** X12 calls this inside task.new: every central task gets a manual workflow at rev 1; auto needs workflow.set. */
export function createWorkflow(ctx: V2TransactionContext, task: V2Task, settings: Pick<V2Workflow, "template" | "templateVersion"
  | "authorFamily" | "fallback">): V2Workflow {
  checkScope(ctx, task);
  if (ctx.all("xw.task_workflows.get", { taskId: task.id }).length) fail("conflict");
  const { teamId, projectId, now } = ctx.scope;
  return saveRow(ctx, "task_workflows", parseWorkflow({ teamId, projectId, taskId: task.id, ...settings, mode: "manual",
    specRev: task.specRev, rev: 1, createdAt: now, updatedAt: now }));
}
/** Central evidence for one step, supplied by X12 from an accepted task.deliver/review or lend.result in this transaction.
 * `verified` comes from central rows only; `claims` is the source's self-report and never drives state.
 */
interface StepOutcome {
  taskId: string; step: V2Step["step"]; round: number; expectedRev: number;
  state: "delivered" | "done"; headTo: string | null; verdict: V2Step["verdict"];
  verified: V2Step["verified"]; claims: V2Step["claims"];
}
const forward: Record<V2Step["state"], readonly V2Step["state"][]> = { assigned: ["delivered", "done"], delivered: ["done"], done: [] };
export function recordStepOutcome(ctx: V2TransactionContext, outcome: StepOutcome): V2Step {
  const current = findStep(ctx, outcome.taskId, outcome.step, outcome.round) ?? fail("not_found");
  if (current.rev !== outcome.expectedRev || !forward[current.state].includes(outcome.state)) fail("conflict");
  if (outcome.verified.verifiedHead !== null && outcome.verified.verifiedHead !== outcome.headTo) fail("conflict");
  return saveRow(ctx, "task_steps", { ...current, state: outcome.state, headTo: outcome.headTo, verdict: outcome.verdict,
    verified: outcome.verified, claims: outcome.claims, rev: current.rev + 1, updatedAt: ctx.scope.now }, current.rev);
}
