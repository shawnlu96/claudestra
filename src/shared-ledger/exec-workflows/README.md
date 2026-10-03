# Execution workflow / step / DAG-binding domain (X14)

`createWorkflowsDomain(dependencies)` implements the frozen `V2DomainModule` interface for
`workflow.set`, `step.assign`, `dag.init`, `dag.rewrite` and `dag.bind`. It never opens or
commits a transaction; every failure propagates so the caller rolls back all domains together.
Only execution-mode features are accepted; planning stays with the V1 service (no dual authority).

## Tables

- `task_workflows` (X0 `V2Workflow`, key taskId) and `task_steps` (X0 `V2Step`, key taskId/step/round).
  `rev` is the workflowRev / step rev. A schema trigger rejects any update that is not `rev = old + 1`
  on the same key, and deletes are refused.
- `exec_dag_versions`: immutable node set per feature version. `exec_dag_bindings`: server-owned
  binding rows, unique per node and per task.
- `exec_source_events`: immutable observation attachments keyed by `(sourceInstanceId, sourceSeq)`.
- Events and receipts reuse X1's `exec_events` / `exec_command_receipts` journal (`exec-tasks/journal.ts`),
  so X1 and X14 commands share one central serverSeq.

## Rules

- Workflow mode (manual / observe / auto) changes only through `workflow.set`, with task rev/specRev and
  `expectedWorkflowRev` CAS. Auto needs an authorization ask (X0 shape) and the `authorizeWorkflow` check.
  `workflow.set` re-binds the workflow to the task's current specRev; X1 and `step.assign` refuse a stale one.
- `createWorkflow` is the creation hook for `task.new`: always `manual`, rev 1.
- `step.assign` runs from the home instance for the current round only; delivered/done steps are history.
  `recordStepOutcome` moves a step forward with central `verified` evidence; `claims` are the source's self-report.
- `dag.bind` checks feature rev, current version, node and task (same project, feature and home) and
  `expectedTaskRev`, then writes feature rev+1, task rev+1 and the binding row in the caller's transaction.
- New DAG versions (`dag.init`, `dag.rewrite`, `applyDagVersion` for approved proposals) go through
  `parseDag` (acyclic, valid references). Every bound node is inherited unchanged; a completed node
  (task stage `done`) can never be changed, moved or cancelled, and its task row is not touched.
  Rewrites cannot add, move or drop bindings; only an approved proposal may cancel an open bound node.
- Command bodies are strict X0 shapes, so no serverSeq, source seq or nested command can ride along.
  `attachSourceObservations` stores source events against an already committed receipt's serverSeq;
  `claimedCommand` is opaque text and never dispatched.

## X12 integration (只加一行接入，由 X12 执行)

- Register `execWorkflowsStatements` / `execWorkflowsSchema` in `createTransactionOwner` alongside X1's,
  call `domain.installSchema(schemaContext)` in the migrations install, and dispatch the five commands
  through `domain.applyInTransaction(context, command)` in `commands.ts`.
- Wire X1's `workflow` dependency to `readWorkflow`, and call `createWorkflow` in the `task.new` transaction.
- Supply `feature` / `saveFeature` (central feature row CAS) and `task` / `saveTask` (X1 `readTask` /
  `saveRow("tasks", next, expectedRev)`), plus `authorize` and `authorizeWorkflow` (owner for workflow.set
  including the live auto-mode ask bind; executor eligibility for step.assign; planning rights for DAG commands).
- `dag.decide` approval calls `applyDagVersion(ctx, deps, feature, nodes, cancels)` and cancels the dropped cards
  in the same transaction. Accepted deliver/review/lend results call `recordStepOutcome`, and any source events
  arriving with them go through `attachSourceObservations` after the receipt is recorded.
