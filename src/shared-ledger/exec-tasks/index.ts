import {
  parseCommand, assertTransactionContext, v2ObjectDigest, fail,
  type V2DomainModule, type V2Receipt, type V2TransactionContext,
} from "../../lib/shared-ledger-contract-v2.js";
import { taskSchema, taskStatements, installTaskSchema } from "./schema.js";
import { journalSchema, journalStatements, installJournal, findReceipt, recordCommit } from "./journal.js";
import { authorizeTask, commandGate, type TaskCommand, type TasksCommand, type TasksDependencies } from "./policy.js";
import { applyTask } from "./tasks.js";
import { applyItem, applyDependency } from "./planning.js";
import { dependencyId, readTask } from "./storage.js";

export const execTasksSchema = { ...taskSchema, ...journalSchema };
export const execTasksStatements = { ...taskStatements, ...journalStatements };
export type { TasksDependencies, TasksCommand } from "./policy.js";
export { readTask } from "./storage.js";
export { readEvents } from "./journal.js";

function apply(ctx: V2TransactionContext, command: TasksCommand, deps: TasksDependencies): V2Receipt {
  // IDs bind actor+scope+request, not local short IDs; migration is the only source-ID registration path.
  const id = v2ObjectDigest({ teamId: ctx.scope.teamId, projectId: ctx.scope.projectId, actor: ctx.scope.actor, requestId: command.requestId });
  let result: V2Receipt["result"];
  let kind: "task" | "item" | "dependency";
  let head: string | null = null;
  if (command.type === "item.new" || command.type === "item.set") {
    const row = applyItem(ctx, deps, command, id); kind = "item";
    result = { entityId: row.id, rev: row.rev, specRev: null, version: null, epoch: ctx.scope.epoch, operationId: null };
  } else if (command.type === "dep.set" || command.type === "dep.remove") {
    const row = applyDependency(ctx, deps, command); kind = "dependency";
    result = { entityId: dependencyId(row.fromTask, row.toTask), rev: row.rev, specRev: null, version: null, epoch: ctx.scope.epoch, operationId: null };
  } else {
    const row = applyTask(ctx, deps, command, id); kind = "task"; head = row.head;
    result = { entityId: row.id, rev: row.rev, specRev: row.specRev, version: null, epoch: ctx.scope.epoch, operationId: null };
  }
  return recordCommit(ctx, command, result, kind, head);
}
/** X12 installs/grants these named statements and owns the outer transaction and live gates. */
export function createTasksDomain(deps: TasksDependencies): V2DomainModule<TasksCommand, V2Receipt> {
  return {
    installSchema(ctx) { installTaskSchema(ctx); installJournal(ctx); },
    applyInTransaction(ctx, input) {
      assertTransactionContext(ctx);
      const command = parseCommand(input);
      if (!["item.new", "item.set", "task.new", "task.set", "task.spec", "task.assign", "task.stage", "task.deliver",
        "task.review", "dep.set", "dep.remove"].includes(command.type)) fail();
      commandGate(ctx, command, deps);
      const old = findReceipt(ctx, command);
      if (old && command.type.startsWith("task.")) authorizeTask(ctx, deps, command as TaskCommand, readTask(ctx, old.result.entityId));
      return old ?? apply(ctx, command as TasksCommand, deps);
    },
  };
}
