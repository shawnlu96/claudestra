# Manual merge queue (dispatch-recovery-MQ1)

Workflow-`manual` cards (PM took them over: RD1 / SBH2 / CFG / PR624) can have a real cross-family human review but no engine
review dispatch or ack, so the auto path refuses them (`merge_review_unproven`) — correctly. Before MQ1 they also never got a
legal window to merge: trains formed back to back, and a hand merge while a train tests voids it. MQ1 gives them an explicit,
audited queue that hands the project merge slot over between trains, without touching the auto gate.

## Facts (ledger only, no schema change)

| fact | where | written by |
|------|-------|-----------|
| request | `decision` event, `data.op = manual_merge_request`; binds head / specRev / round / `review.{seq, actor, reviewer, sessionId, family, reportPath, verdict}` (copied from the review event, never typed) / `uiDigest` | `ledger manual-merge-request` — project PM other than the dispatcher, master, owner |
| revoke | `decision`, `op = manual_merge_revoke`, `request = <seq>` | `ledger manual-merge-revoke`, same roles |
| claim | `scheduler_intents` row `mmq:<request seq>` (node `manual_merge`, action `merge`), the `merge:<project>` resource, `scheduler` event `op = manual_merge_claim`, a `scheduler_merges` run begun in the same transaction | `ledger manual-merge-claim`, scheduler identity only |

Queue order = request event seq (persistent, restart-safe). Request state is derived every time (`requestStatus`): queued,
waiting (frozen queue, explicit hold, safety hold, paused feature, open ask, unsettled intent, deps), void (head / spec / round /
review / UI digest / mode / stage moved, or the review fails: same family, P0/P1, the requester or the author as reviewer,
or recorded by anyone other than the reviewer itself, the scheduler (pool) or — the official manual path, `ledger review
<task> --reviewer … --session … --family … --findings … --path …`, which on a manual card only PM / master / owner may run —
a project PM other than the dispatcher / master / owner), revoked, running, merged, ended, unknown. One open request per card; the same
binding again answers the existing one.

Owner decisions on the card (asks of kind authorize / owner_action, the scheduler's screenshot ask excepted — the UI gate judges that
one) are grouped into decisions — an authorize by its asker + ask key (the bound action when none) + binding hash (`bindHash`:
action, version, asker, complete params — what `checkAsk` compares), an owner_action by asker + ask key / title — and the latest
version of each must stand: an authorize answered with an approve button and still inside its window (`checkAsk`'s rule: the window
runs from the ask, an answer does not extend it), an owner_action answered by the owner. Anything else closed — expired, cancelled,
answered "no", approved but past the window — is a **wait**, however old the ask and whenever PM queued: the request keeps its place,
nothing merges (a claimed run ends cancelled with its slot freed), and the only lift is the owner approving / answering that same
decision re-asked. An approval of another decision (another key, other params, another asker) lifts nothing. A version the ledger
superseded (same asker + key re-asked while still open) was never decided: its recorded replacement is judged instead. A new request
with the same binding is the same request (duplicate), so neither its time nor its reason lifts anything.

## The one decision: `manualTurn` (lib/manual-merge-queue.ts)

`active` (a claimed run is pending / submitted) → `owed` (the last manual run just ended and an auto candidate has had no
merge intent since: auto goes first, at most `OWED_LIMIT_MS`; "auto candidate" is every card the auto tick may legally merge —
`mergeCandidates` with ui cards whose screenshot acceptance holds, minus cards already merged at their head — not only the
train's non-ui candidates) → `due` with a wait reason (train holds, train file unreadable,
slot held, a run that lent its slot to the last train still to take it back) or claimable. Read by:

1. `trainProjects` at the top of the pass (on only): no new train forms while the head is `due` or `active`. A live train is
   still stepped, never frozen, re-based or interrupted. That pre-read is not the decision: the train tick saves a newly formed
   train only through `formFence` (manual-merge-queue-pass.ts), which re-runs `manualTurn` in one ledger read transaction and
   saves synchronously right after it. Requests are written under BEGIN IMMEDIATE, so the ledger's commit order decides: a
   request in that snapshot stops the formation (nothing external was done for the train yet), one committed after it queues
   behind a train that already exists — at most that one train. (The pass's connection is query_only, so it cannot take the
   write lock itself; the snapshot is the serialization point.)
2. The claim step, after `reclaimLentSlots` and before the auto tick: the CLI child decides again under BEGIN IMMEDIATE and
   writes intent + slot + run in one transaction (`beginMergeRun` re-checks everything). A racing auto plan or a second claimer
   loses on the slot's primary key / the transaction order. A train in `cleanup` may be reserved against, but the manual run
   sends nothing until that train is `done` (`mergeSlotTurn`).

## Execution and settlement (existing paths)

The claimed run is an ordinary merge journal row driven by `mergeTick` / `driveMerge` under the pass's maintenance lease:
inspect, freshness / update-branch, CI, final re-check, one head-pinned merge, `merged` or `unknown` (queue frozen, never
re-sent; `scheduler-merge-resolve` is the only exit). `mergeRunDrift` / `beginMergeRun` take the manual branch for node
`manual_merge`: workflow must be `manual` and the request still valid (a head moved by this run's own carried update-branch
counts as bound). A request that stops holding before any merge was sent ends the run cancelled with the slot freed
(`manualCancel`); nothing is faked as done. While nothing irreversible is out the manual drift also re-reads the policy: in ready /
updating / await_ci (which includes the `merging` claim's own transaction), and once more on the driver's last recheck before the
merge call — the driver marks that run `beforeSend`, the one read that still knows the committed `merging` claim went nowhere — so off,
observe or unreadable ends the run cancelled with the slot freed, nothing sent (the driver's `MERGE_NOT_SENT` receipt lets
`advanceMergeRun` end a manual `merging` row cancelled instead of freezing the queue); the claim child re-reads it too. A `merging` row
seen anywhere else (after a restart, on a receipt) may have sent: it is only verified, never re-sent, unknown stays unknown, and the
policy is not asked. A manual merge is not auto-deployed (`deployDrift` wants auto): the intent settles "待 PM 部署".

## Policy

CFG's `RecoveryPolicyPort`, key `manualMergeQueue` (`ledger scheduler-recovery <project> on|observe|off --key manualMergeQueue`):
default observe, unreadable file off. observe writes one deduped `recovery_observe` note per request (`claim:<seq>`) and holds
nothing back; off leaves the old path; on acts. No scheduler.json key, capacity, grant or provider rule changes.

## View

`ledger merge-queue` adds the manual requests: state / phase, turn position, requester, short head, review seq / reviewer /
family, and the wait or invalid reason from the same `manualTurn`. Reviewer session ids are not printed.

Tests: `tests/manual-merge-queue*.test.ts` (real pass on the MTR1 fake-GitHub world: off/observe wait past several trains,
on merges between trains, two requests alternate with autos, races across connections and processes, drift / revoke /
lease loss / send-then-timeout / frozen / deploy in flight).
