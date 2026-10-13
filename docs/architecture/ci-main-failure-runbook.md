# Main full CI failure: PM response and ordinary rollback

`ciMainFailureResponse` defaults to `observe`. It does not automate git writes,
service restarts or deployment recovery. The existing `mainCiPause` switch and
MAINCIW pause/repair gate remain the authority; there is no second hold table.

## Evidence and responsibility

The reader pins the current main SHA, reads the associated merged PR, the latest
Actions runs and attempts, their jobs, and each run's archived `ci-related-plan`.
The commit API must bind the plan's checkout to the candidate head, first-parent
base and exact integration tree. Related success followed by full failure on a
different tree or base is not an exact correlation. Missing/expired artifacts,
read errors, partial API pages, attempts in progress and an unknown SHA never
count as green and never identify a culprit. Lists larger than 100 remain
unclassified; MAINCIW still protects the main branch. Only `ci.yml` runs qualify.

A main push failure can correlate with a related PR run whose tested merge tree
matches main's tree (including squash merges). The pure recognizer also accepts
an accurately bound integration full run. The production adapter currently
reads main-push failures; pre-merge full failures remain the existing SELECT1
full-recheck driver's PM responsibility, without a second main incident.

The record contains head/base/tree, checkout SHA, run IDs/attempts, failed checks
and first-discovery time. Its wording is **correlation, not causation**. The PM is
the incident responder, not a presumed author of the defect. A receipt names the
active project PM (or a configured PM other than the dispatcher), a deadline
(initially discovery + 30 minutes), pending/repair/revert choice, and the fixed
resume condition `current-main-full-green`. No configured PM is reported as
missing rather than inventing an owner.

`observe` records a proposed pause/notice and proposed responsibility receipt.
It sends no additional message and changes no admission decision. When
`mainCiPause=off`, response observe preserves that no-read path. Existing
MAINCIW notices in its own observe/on mode still use their original rules.
`off` leaves the existing MAINCIW path intact. `on` promotes MAINCIW's own gate
and adds the positive `ci scope full` requirement. It reuses the same durable
main-red notification claim, so the train, serial and manual paths do not create
another notification or freeze. The incident receipt is unique per failed SHA
and mode, including across scheduler restarts.

## PM acknowledgement

1. Read `ledger main-ci status --project <project>`. Its `response` field contains
   the correlation evidence, initial receipt and latest acknowledgement. Check
   the exact failed SHA, CI run logs, subsequent main commits and deployment
   history before choosing a remedy. Compare head/base/tree; do not infer cause
   just because a change landed immediately before a red run.
2. For repair, create a normal reviewed repair card, then use MAINCIW's existing
   `ledger main-ci-repair <card> --head <head> --main <failed-sha> --reason <why>`.
   The binding still needs the exact current head/main/fault and ordinary review,
   UI, CI and authorization gates. Record the acknowledgement:

   ```sh
   ledger main-ci ack --project <project> --key <incident-key> \
     --deadline <future-unix-ms> --choice repair \
     --task <card> --head <head> --reason <why>
   ```

3. For ordinary revert, first inspect `git show <failed-sha>` and
   `git log <failed-sha>..origin/main`. Verify which commit actually needs
   reverting. Record `--choice revert --head <failed-sha>` with a future deadline
   and reason via the same acknowledgement command. This is an audit choice,
   not approval for an agent to execute git. The PM follows the existing human
   authorization/review process, prepares an ordinary `git revert` commit on a
   branch, and resolves conflicts while retaining later unrelated commits.
   For a merge commit, explicitly review the selected mainline parent before
   using `git revert -m 1`. Never reset or force-push main.
4. If faulty code was deployed, keep the last known usable deployment and use
   the established controlled recovery procedure and deployment lock. Verify
   the previous deployment's identity and health; follow existing owner
   escalation rules when recovery needs credentials or infrastructure changes.
   This feature introduces no restart, deployment or rollback shortcut.
5. Reverting is not itself a green CI result. The repaired/reverted **current
   main** must pass all configured checks and `ci scope full`. The next MAINCIW
   read releases the existing pause. A repair binding alone never authorizes
   deployment, a train, or another card. Stale reads and unreadable state pause
   admission; existing submitted merge/deploy effects are only read back and
   finished through their existing journals.

The planner snapshot, inspect view, train candidates and deploy tick all
recompute `planMainCi` from the same durable MAINCIW health observation and PM
bindings. These records are evidence, not another freeze state. New merges and
new/claimed-but-unsent deployments stop under on; a running deployment or sent
merge still gets its read-back. Inspect preserves the PR's own checks and exposes
`mainCiResponsePause`. Manual operator actions must consult the same status;
there is deliberately no shell interception or automatic cancellation of CI.

## Activation and isolated drill

Keep observe for at least 24 hours **and** inspect a nonzero number of real
proposed incidents before switching on with the existing recovery-policy CLI.
Synthetic incidents do not satisfy the production observation requirement. If
no exact correlation sample occurs, keep observe; MAINCIW's protection continues.
The PM tracks every failure to closure through existing escalation rules.

`tests/ci-main-failure-response.test.ts` rejects mismatched identities and
chronology; `tests/ci-main-failure-drill.test.ts` drives the real scheduler,
planner/inspect/candidate/deploy entries against disposable ledger/GitHub ports.
It also rehearses human ordinary revert in a temporary repository: the later
commit stays in history and its content survives. Production adapter commands
are read-only GitHub queries/artifact downloads; no production git write runs.
