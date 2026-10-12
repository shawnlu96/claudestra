# Deployment reconciliation

`deployReconcileTick` runs immediately after the normal deployment tick in
`schedulerPass`, under the same singleton and maintenance leases. It closes a
card whose merge has already shipped but whose ledger still says `merge`.
It does not launch a deployment or change merge queues, intents, or workflows.

## Deployment evidence

The source is the project's latest `kind=deploy` event, ordered by ledger
sequence, whose data has no `reconciledBy` field. Its `data.version` is the
version the PM recorded with `ledger deploy`, or the version recorded by a
successful scheduler deployment. Both paths already write this structured
event; `scheduler_deploys` alone omits manual deployments. Checkout `HEAD`,
`origin/main`, endpoint version responses, receipts, and free text are never
deployment evidence. The automatic deployment event may name only the merged
commit even when the job pulled newer main commits: this is a conservative
proof of inclusion, and reconciliation does not infer the newer version.

A source is usable for **24 hours**, inclusive of the boundary. Future timestamps,
imported/approximate records, missing or invalid versions, a subsequent rollback,
an in-flight deployment, or a subsequent unresolved failed/unknown deployment
hold reconciliation. A hexadecimal version of 7–40 characters must resolve
unambiguously to an existing commit in the project's configured repository.
The full merge SHA must pass `git merge-base --is-ancestor <merge> <version>`.
No fetch occurs. An unreadable latest source never falls back to an older one.
Reconciled deployment events cannot become a source or refresh its timestamp.

## Cards and writes

For each project in enabled scheduler configuration, the latest merge journal
attempt (ordered by its intent's event sequence) must be `merged`, with a full
merge SHA and a matching scheduler `merge_phase` event. The card must still be
in `merge` at the reviewed head and must not have re-entered `merge` since that
event. The production source must follow the merge event. Any later deployment
event for this card prevents another reconciliation. Shared-ledger skip cards
are gated before git, ledger writes, and notifications; central cards are held
as unmapped by the pass manager rather than written locally.

The new `ledger scheduler-deploy-reconcile` command accepts only the existing
scheduler service identity with valid leases. An ordinary agent, PM, or owner
cannot use this service-only entry. Repository and switch come from existing
scheduler and recovery policy, not from a caller-supplied proof. The writer
checks git itself and rechecks the source sequence, card revision, merge
identity/revision, current evidence, switch, repository, leases, and freshness
before committing. `appendEvent` and `applyMove` are the same write functions
used by normal ledger event/stage operations. The transaction writes one deploy
event with `version`, `rollbackPoint: null`, and `reconciledBy: "deployReconcile"`,
then the ordinary `merge → live` stage event. A stage refusal rolls both back.
The original actor remains `scheduler`; no credential or ordinary agent
permission changes. Existing stage bookkeeping releases the card's leases.

Reconciliation stops at **live**, with **zero verify events**. The original
workflow/PM performs `ledger verify <card>` using its existing completion
checklist. There is no fabricated scheduler deployment journal or bypass of UI
acceptance, observation periods, or post-verification PM work. Manual cards
remain manual. Code dependencies satisfied at live can now proceed.

## Switch and reporting

The existing `recovery-policy.json` key `deployReconcile` follows the ordinary
key override → project mode → default `observe` precedence. No additional
configuration file is introduced. Corrupt policy fails closed to off.

```sh
bun src/manager.ts ledger scheduler-recovery <project> observe \
  --key deployReconcile --reason '核首批补记样本'
bun src/manager.ts ledger scheduler-recovery <project> on \
  --key deployReconcile --reason '首批来源与祖先关系已核对'
bun src/manager.ts ledger scheduler-recovery <project> off \
  --key deployReconcile --reason '停止补记'
```

- **off**: no ledger reads/writes, git, diagnostics, or PM notification.
- **observe**: no deploy/stage writes; one ordinary structured recovery
  observation per card (`mechanism=deployReconcile`, `actionKey=reconcile`) with
  source event sequence, merge SHA, intent, and deployed version. Only the call
  that first records it sends one PM summary. Ledger dedup survives restarts;
  notification failure is logged and not retried every tick.
- **on**: atomically append deploy and advance to live. Subsequent ticks do
  nothing to the card. Existing observations do not prevent activation.

Skipped evidence logs one diagnostic per card and reason for the ledger reader's
lifetime, with no ledger write or PM message. Repeated ticks, including a reason
that disappears and recurs, do not repeat that line. A service restart creates a
new reader and may log the reason again. PM notifications are deduplicated in
the ledger across service restarts.

The PM checks the first observe batch against its source events and git ancestry
and may then set `on`; no 24-hour observation requirement is imposed.

## Verification

`tests/scheduler-deploy-reconcile.test.ts` uses a temporary git repository and
synthetic ledger to cover successful reconciliation, observation and repeated
ticks, unsafe/missing/stale evidence, off, short versions, writer races,
transaction rollback, lease loss, skip routing, and service-only permissions.
The original deploy/merge/post-verify expectations remain unchanged.
