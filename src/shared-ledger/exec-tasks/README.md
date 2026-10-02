# Execution task domain integration

`createTasksDomain(dependencies)` implements the frozen `V2DomainModule` interface.
It supports item.new/set, task.new/set/spec/assign/stage/deliver/review and dep.set/remove.
All failures propagate to the caller's transaction. The domain has no database handle,
network calls, local execution fallback, or execution capability toggle.

X12 integration: **只加一行接入，由 X12 执行** at each existing dispatch/migration hook:
register `execTasksStatements` / `execTasksSchema` in `createTransactionOwner`,
call `domain.installSchema(schemaContext)` and dispatch with
`domain.applyInTransaction(context, command)` inside the single owner transaction.
The composition root grants only the named statements required by its domains.
`readTask` and `readEvents` are scoped read helpers for the X12 snapshot adapter.

Required dependency callbacks are synchronous trusted composition-root functions;
there is no permissive default. All readers must use the provided transaction context:

- `authorize`: current project membership, registered person/instance binding,
  command-specific role and service action scope, central active generation/bootId,
  execution capability/migration gates. It runs before receipt lookup, including retries.
- `authorizeTask`: independent role checks for each task action; executor/reviewer
  identity and independence; actual owner authorization for protected stage changes,
  assignment and in-flight specification edits; artifact references; applicable live
  lease/dependency gates. The frozen actor DTO has no role field, so role lookup stays
  with X12 identity. This callback also runs for task receipt retries without rerunning CAS.
- `feature` / `workflow`: X12 feature and X14 workflow readers. The domain checks their
  exact scope, identity, execution mode, home, epoch, workflow rev and specRev.
- `order`: X6's current order for this task/step, including completed orders. Do not look
  up only the orderId supplied by the command: null must not bypass an active order.
- `result`: X6's accepted result for that order. Deliver/review require a done order,
  matching leaseGen, fences, task/spec/round, input head, output head, worker, operation,
  result digest and evidence. Order-scoped worker identities cannot write task commands;
  the home service applies accepted results. Local delivery has no separate expectedHead
  field in X0: rev CAS protects the input row and payload.head is the new output head.

`task.deliver` and `task.review` record evidence only; stage advancement is a separate
CAS command. Stage rules reuse `canTransition` / `nextTaskState`, including round and
spec revision increments. Generic task.set remains limited to title and plan.
Dependencies use fromTask as prerequisite. Removed edges retain revision history,
so recreation uses the latest tombstone rev rather than expectedRev=0.

`exec_events` supplies one SQLite sequence and `exec_command_receipts` supplies immutable
receipts. X12 must reuse this journal (or adapt its centralized journal at integration),
not create independent domain sequences. `journal.ts` exposes `recordCommit` and
`findReceipt` for composition. No V1 tables or entrypoints are changed.

`importTaskRows(context, dependencies, migrationCommand, manifest)` is a subordinate
X13 migration hook: strict X0 manifest parsing, audited source-instance mappings,
row/version writes, no independent transaction or receipt. X12 must authorize the
complete manifest/bind, look up the migration receipt before calling any import hook,
compose all domains, then append ONE migration event/receipt in that same transaction.
Imported task/item IDs and both dependency endpoints must be new; conflicting mappings
are rejected in both directions. The registration audit uses the trusted caller's
person/instance and central time. Native central creations need no local-ID mapping.

Focused tests use `bun:sqlite` in-memory databases and frozen X0 fixtures. They inject
failures at version/event/receipt insertion and after the domain returns to prove that
all domain and caller writes roll back together. No production service is contacted.
