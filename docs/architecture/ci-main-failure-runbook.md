# Main full CI failure: PM response and ordinary rollback

The response follows the existing `mainCiPause` switch, which defaults to
`observe`. It does not automate git writes,
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

Once recorded, a failed SHA reuses its immutable first-discovery receipt even
across restart; it does not re-query Actions or spawn a writer on every pass.
That historical evidence does not claim that a rerun is currently failing.
MAINCIW still reads fresh current-main health independently on every eligible
pass. Missing proof or read errors retry after one minute, then two, four,
eight and at most fifteen minutes, scoped to project/repository/main SHA;
the process-local budget retains at most 128 entries and stores no pause fact.
A changed SHA is eligible immediately. A healthy, unknown or off observation
adds no receipt; `on` after `observe` adds only the on-mode receipt once.

The record contains head/base/tree, checkout SHA, run IDs/attempts, failed checks
and first-discovery time. Its wording is **correlation, not causation**. The PM is
the incident responder, not a presumed author of the defect. A receipt names the
active project PM (or a configured PM other than the dispatcher), a deadline
(initially discovery + 30 minutes), pending/repair/revert choice, and the fixed
resume condition `current-main-full-green`. If no PM is configured, the record reports
that absence rather than inventing an owner.

`observe` records a proposed pause/notice and proposed responsibility receipt.
It sends no additional message and changes no admission decision.
`mainCiPause=off` preserves the original no-read path. Existing
MAINCIW notices in its own observe/on mode still use their original rules.
`off` leaves the existing MAINCIW path intact. `on` uses MAINCIW's existing gate
unchanged; this module does not add another admission check. It reuses the same
durable
main-red notification claim, so the train, serial and manual paths do not create
another notification or freeze. The incident dedup key binds the failed main SHA, first discovered full run
and attempt, and mode, including across scheduler restarts. The unchanged SHA
reuses that first receipt; it does not poll Actions to discover later attempts.

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
   main** must have a successful full run; the PM checks its scope and identity.
   Existing MAINCIW releases its existing pause when its fresh current-main
   health is green. Repair bindings apply only to that card's serial path;
   they never bypass its review or PR CI, nor allow it into a red-main train.
   Already-submitted effects retain their existing journals. The uncovered
   deployment path below is a gap for GATE1, not a guarantee added by this card.

## 四入口缺口与绕过路径 (coverage and gaps)

The real scheduler pass calls MAINCIW before the train and merge drivers
(`src/lib/scheduler-pass.ts:137`). Existing `mainCiHolds` at
`src/lib/scheduler-service.ts:72` leaves new merge intents pending; existing
`mainCiDrive` at `src/lib/scheduler-main-ci-wiring-driver.ts:26` gates update,
rerun and merge effects. Existing train formation respects the same pass gate.
The committed drill asserts those covered effects, PM repair admission and
recovery, while retaining the PR's own gates.

The following entries do not independently consume MAINCIW's pause. This card
reports them for PM/GATE1 and does not repair them or use a coverage gate:

- Planner · `src/lib/scheduler-plan.ts:403` · the snapshot has no MAINCIW
  health, so replay before a pending intent still plans `action=merge` under
  red main. The later scheduler merge gate holds that intent before effects.
- Inspect · `src/lib/scheduler-merge-external.ts:45` (return at line 73) · it
  returns the PR's own green checks/CLEAN state even while main is red.
  The production merge driver asks MAINCIW separately before sending effects;
  inspect by itself does not prove main admission.
- mergeCandidates · `src/lib/scheduler-merge-train-tick.ts:90` (append at line
  110) · candidate selection uses task/review/queue facts, not main CI, and
  still lists candidates. The subsequent train-formation fence is covered.
- Deployment tick · `src/lib/scheduler-deploy-tick.ts:211` →
  `src/lib/scheduler-deploy-tick.ts:63` · a previously merged card begins and
  submits a new deployment without consulting MAINCIW. An isolated fake-jobs
  probe confirmed one submit while the same ledger's MAINCIW fact was paused.
  **New deployment admission is not covered by this card.**

The source files for those entries remain identical to the starting
`origin/main`. The pure module, read-only runtime, response/ack writer and thin
MAINCIW calls add only correlation and responsibility records. No second
health-read state, `failureResponsePaused`, `mainCiResponsePause` field or new
recovery switch remains. PM incorporates these gaps into GATE1's follow-up.

## Activation and isolated drill

Keep observe for at least 24 hours **and** inspect a nonzero number of real
proposed incidents before changing the existing MAINCIW policy through its
established PM procedure.
Synthetic incidents do not satisfy the production observation requirement. If
no exact correlation sample occurs, keep observe; MAINCIW's protection continues.
The PM tracks every failure to closure through existing escalation rules.

`tests/ci-main-failure-response.test.ts` rejects mismatched identities and
chronology; `tests/ci-main-failure-drill.test.ts` drives the real scheduler,
covered MAINCIW serial/train paths against disposable ledger/GitHub ports.
It also rehearses human ordinary revert in a temporary repository: the later
commit stays in history and its content survives. Production adapter commands
are read-only GitHub queries/artifact downloads; no production git write runs.
