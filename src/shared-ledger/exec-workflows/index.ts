import {
  parseCommand, assertTransactionContext, fail,
  type V2DomainModule, type V2Receipt, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { findReceipt, recordCommit } from "../exec-tasks/journal.js";
import { installWorkflowSchema } from "./schema.js";
import { applyDag } from "./dag.js";
import { applyStepAssign, applyWorkflowSet } from "./workflows.js";
import {
  authorizeWorkflow, commandGate, loadTask, WORKFLOW_COMMANDS,
  type WorkflowsCommand, type WorkflowsDependencies,
} from "./policy.js";

export { execWorkflowsSchema, execWorkflowsStatements } from "./schema.js";
export { readWorkflow, readSteps } from "./storage.js";
export { createWorkflow, recordStepOutcome } from "./workflows.js";
export { applyDagVersion, readDag } from "./dag.js";
export { attachSourceObservations, readSourceObservations } from "./events.js";
export type { WorkflowsCommand, WorkflowsDependencies } from "./policy.js";

function apply(ctx: V2TransactionContext, command: WorkflowsCommand, deps: WorkflowsDependencies): V2Receipt {
  const epoch = ctx.scope.epoch;
  if (command.type === "workflow.set") {
    const row = applyWorkflowSet(ctx, deps, command);
    return recordCommit(ctx, command, { entityId: row.taskId, rev: row.rev, specRev: row.specRev, version: null, epoch, operationId: null }, "workflow");
  }
  if (command.type === "step.assign") {
    const row = applyStepAssign(ctx, deps, command);
    return recordCommit(ctx, command, { entityId: row.taskId, rev: row.rev, specRev: null, version: null, epoch, operationId: null }, "step");
  }
  const { feature, version } = applyDag(ctx, deps, command);
  return recordCommit(ctx, command, { entityId: feature.id, rev: feature.rev, specRev: null, version, epoch, operationId: null }, "dag");
}
/** X12 installs/grants the named statements, owns the outer transaction and composes with X1 (shared journal). */
export function createWorkflowsDomain(deps: WorkflowsDependencies): V2DomainModule<WorkflowsCommand, V2Receipt> {
  return {
    installSchema(ctx) { installWorkflowSchema(ctx); },
    applyInTransaction(ctx, input) {
      assertTransactionContext(ctx);
      // Strict X0 parsing: no serverSeq, source seq, actor or role can ride along in the body.
      const command = parseCommand(input);
      if (!(WORKFLOW_COMMANDS as readonly string[]).includes(command.type)) fail();
      const typed = command as WorkflowsCommand;
      commandGate(ctx, typed, deps);
      const old = findReceipt(ctx, typed);
      if (old) {
        const task = "taskId" in typed.payload ? loadTask(ctx, deps, typed.payload.taskId) : null;
        authorizeWorkflow(ctx, deps, typed, task);
        return old;
      }
      return apply(ctx, typed, deps);
    },
  };
}
