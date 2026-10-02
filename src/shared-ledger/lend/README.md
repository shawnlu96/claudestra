# Central lend domain

`createLendDomain(ports)` implements the frozen `V2DomainModule` contract. Register
`lendStatements` and `lendSchema` with `createTransactionOwner`, install the schema
inside the caller's schema transaction, and dispatch `lend.*` commands through
`applyInTransaction`. The module never opens a database or commits a transaction.

Orders, claims, leases and results use central `v2_lend_*` tables. An order id is
unique across scopes; one live order per scoped task includes unknown and expired
claimed orders. Claim accepts only pooled orders and the next `leaseGen`;
a second claim is refused. Renewals retain the generation and use the central
clock. Cancellation is explicit, never triggered by lease expiry.

Results check the order, generation, worker, round, spec revision and original
head. A review must also report that exact head; write/fix may report a new output
head. Results update only the bound step and order, with central events/receipts
in the same transaction. They do not change the task head, stage, home, owner
approvals or independent verification. Failed/unknown results never mark a step
successful. Exact result retries return stored data; a changed body is rejected.

## Composition-root requirements

Only add a one-line hookup, performed by X12 (只加一行接入，由 X12 执行):

- `migrations.ts`: register the schema map and call `domain.installSchema`.
- `commands.ts` / V2 wiring: register the statement map and call
  `domain.applyInTransaction(context, command)` in the existing command transaction.
- `reads.ts`: use scoped `readLendRow` for order/claim/lease/result reads.
- Migration composition: call `domain.importInTransaction(context, manifest)` in
  the transaction importing the rest of the approved feature and batch receipt.

The required `LendPorts` are synchronous adapters to other central domains:

- `loadExecution`: read task/workflow/feature DTOs from this transaction.
- `authorize`: verify current membership/service action, registered home and live
  scheduler fence/lease, machine-owner grant id/digest/scope/expiry, and approved
  artifact/result references. The home proxy must authenticate the external
  claimant/result worker before constructing the central command. Body identities
  alone confer no authority. A scoped worker service must retain `actor.orderId`.
- `readStep` / `writeStep`: read the exact task/step/round and CAS only that step.
  A null previous value requires insert-only semantics. These adapters must never
  call a whole-task deliver/review/stage helper.
- `appendEvent`: append the central event and return its server sequence. X12 owns
  request-id deduplication and immutable receipts. On any domain/event/receipt
  failure, propagate the exception and roll back the entire caller transaction.
- `authorizeImport`: verify owner approval, source write gate and reconciled
  snapshot/leases. X13 imports the complete manifest before enabling execution.

Import preserves original order ids, lease generations, deadlines and settled
states; it does not claim, renew, dispatch, or allocate execution events. Claimed
orders require matching claim/lease/step records and a live deadline. The frozen
manifest parser validates references/digest; this domain additionally rejects
order-id remapping and inconsistent bundle contents. Identical imports are
idempotent; replacement of any existing row is forbidden.

`lendOffer` and `lendLeaseState` project central records into existing wire shapes.
Hello/beat continue using `lend-wire-v2.ts`; claim/result continue using
`lend-wire.ts`. X9's authenticated proxy performs command translation, and X12
owns the real HTTP/CLI hookup. No peer-facing protocol or V1 service is changed.
Execution remains disabled until the complete V2 integration is accepted.
