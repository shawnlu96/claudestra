# Scheduler lease domain

This module implements the frozen V2 lease commands and generation DTO. It does
not open a database, run a timer, commit a transaction, or enable execution.

## X12 integration

只加一行接入，由 X12 执行：在 migrations 安装 `installLeaseSchema`；在 commands
的调用者事务内分派 `createLeaseDomain(deps).applyInTransaction`；所有需要调度租约的
写入口先调 `assertWritable`。真实入口、事件与幂等回执仍由 X12 同事务组合。

- Register `leaseSchema` and `leaseStatements` with `createTransactionOwner`.
  Ordinary command contexts need lease statements and generation **read** only.
  Grant `leases.generation.put` and `leases.revokeAll` only to recovery contexts.
- Build `LeaseDependencies` from X1/X2/X5/X6 adapters, reading current scoped
  task/feature/workflow, owner approval and worker/lend/unknown rows in the same
  transaction. `advanceFeature` must CAS the supplied feature epoch/revision;
  a home change updates all its task homes and the feature revision atomically.
  Authorization checks include project owner, approval lifetime/current bind,
  confirmed old-home shutdown and registration of the next home. Command booleans
  alone never prove settlement; `settlement` reads authoritative current rows.
- Use the center's clock for `scope.now`; actor/actions come from authenticated
  identity and project policy. Never copy a body timestamp, actor or role there.
  X12 performs receipt deduplication before reapplying a command and records
  returned epochs in its immutable receipt. All domain errors must escape so
  the caller rolls back lease, feature, event and receipt writes together.
- X8 renews on `domain.policy.renewMs` (15 seconds by default). The server accepts
  valid early renewals and sets expiry from central `now + leaseMs` (60 seconds).
  Tests may inject shorter intervals; the frozen DTO caps lease duration at 60s.

## Fences

Each task has one lease row. Acquisition consumes a new epoch from the feature's
high-water mark; retries with the current boot and current live epoch return the
existing lease without extending it. A boot replacement retires the previous
task-holder boot, preventing it from stealing the lease back even with a freshly
observed epoch. Other task leases keep their individual fences, allowing parallel
work within the feature.

Expiry rejects renewals and writes, but preserves home and the epoch tombstone.
Reacquisition needs the current tombstone epoch and consumes a newer epoch.
`lease.release` is the explicit cancellation/revocation path and also advances
the tombstone. X12/X5 must compose cancellation with this path while the lease is
live; an expired lease already rejects writes. Home change consumes a newer
feature epoch and invalidates every lease in that feature. It never clears
unknown operations or resource claims.

## Recovery

`createGenerationDomain` is an internal recovery API, not an added wire command.
X12/X13 authorize the local recovery operator and provide a durable generation
high-water mark outside restored backups. `reserveGeneration` must perform a
durable compare-and-set against that mark before returning. Reservations survive
database rollback; skipped generation numbers are intentional.

`restore` validates the backup generation/sequence, reserves a strictly newer
generation, revokes leases across **all** projects and writes the frozen service
generation in the caller's transaction. The composition root supplies the current
service sequence in the persisted generation record when recording events and
snapshots. Every lease command and `assertWritable` rejects old generations and
frozen services. `activate` requires service-wide confirmed-receipt reconciliation;
it never revives old leases. A new lease must be acquired after activation.

The generation record, lease tables and retired boots belong in consistent
backups. The external generation high-water mark must not roll back with them.
No service restart, timeout or restore implicitly changes any feature's home.
