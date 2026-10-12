# Offline CI attempt/job/step baseline

`bun scripts/ci-run-metrics.ts` is an offline, read-only collector. It imports no
scheduler, merge driver, production ledger, recovery policy or known-flaky list
writer. The injected `MetricsReadPort` exposes JSON GET and failed-log reads only.
Neither `on` nor a candidate classification authorizes a CI rerun.

## Collect and replay

Supply a repository and a **new**, explicit output directory:

```sh
bun scripts/ci-run-metrics.ts --repo OWNER/REPO \
  --since 2026-10-01 --until 2026-10-02 --out ./metrics-day
```

The CLI defaults to `--mode observe`. `off`, `observe` and `on` all collect and
report the same measurements. Each report includes all three comparison rows,
with zero GitHub/ledger writes and `rerunAuthorized: false`.

- `--runs PATH`: JSON array, REST `{workflow_runs: [...]}`, `gh run list` JSON
  (camelCase fields) or JSONL run rows to
  seed enrichment, preserving an existing baseline's exact run selection.
- `--input PATH`: replay an offline snapshot, or report run-only JSON/JSONL without
  contacting GitHub. Cannot combine with `--runs`, `--since` or `--until`.
- `--identities PATH`: optional JSON array of
  `{repo, runId, head, train, verified}`. Only one matching repo/run/head entry is
  accepted; duplicates and stale heads do not verify identity. `verified` records
  the supplied evidence's assertion, not an independent verification by this CLI.
- `--known-flaky PATH`: optional JSON array of repo-relative test files, copied
  from an independently reviewed list. No production database is opened. This
  supplies classification candidates, never policy eligibility or permission.

Date bounds apply to GitHub's run `created` filter, inclusive calendar dates.
GitHub caps filtered run searches at 1,000 results; split large historical windows
into smaller dates and check `runsComplete` before interpreting a baseline.

## Output and grain

- `metrics.jsonl`: one normalized row per run, attempt, job or step; keys are
  `(repo, runId, attempt, jobId, stepNumber)` with lower-grain keys absent.
- `report.json`: rows, successful-duration percentiles, separate cancelled,
  skipped, incomplete and unknown counts, classification counts, completeness
  and the three mode comparisons.
- `report.md`: inspectable grouped duration summary.
- `snapshot.json`: normalized API fields for duration replay. Failed logs are
  removed to avoid retaining secrets. Replayed failure classification is unknown
  without logs; the original `metrics.jsonl`/`report.json` retain classification.

Attempts 1 through the run's observed `run_attempt` are fetched individually.
Jobs are paginated through the attempt-specific endpoint; jobs must match run,
head and attempt. Repeated job IDs within an attempt are deduplicated. Step
numbers deduplicate within a job. The same job ID in different attempts remains
separate. Incomplete pagination and read failures carry fixed error codes, never
raw credential-bearing subprocess errors. A later rerun is outside that snapshot;
collect again to observe it. Collection is not an atomic GitHub snapshot.

Group by train before event. A `train/<id>` branch creates an **unverified** train
candidate. A head-bound identity map can supply a train for any event/branch.
Otherwise group by `event:<event>`. Verified/unverified samples stay separate.
Job groups retain shard names, and step groups retain step names, so install,
tests, typecheck, guard and build durations can be compared directly.

## Time and classification definitions

Exact duration is `completed_at - started_at` (attempt/run may use
`run_started_at` as start). Missing/invalid time or negative intervals are unknown.
No job or step duration is inferred by splitting a run's total. Cancelled, skipped
and unfinished subjects have unknown duration and their own counts. Successful
percentiles use only completed-success subjects with valid exact timestamps.
Children are measured on their own status: a completed-success job in a cancelled
attempt is still an executed successful job, while the attempt stays cancelled.
Percentiles use the nearest-rank method; runner times are not added to estimate
parallel wall-clock time.

GitHub REST run/attempt objects normally omit `completed_at`. Their exact duration
therefore remains unknown. For compatibility with run-only historical summaries,
`legacyRunEstimate` separately uses `run_started_at → updated_at`, only for
completed, non-cancelled/non-skipped runs. `baseline.duration` summarizes successful
run estimates; `baseline.conclusions` counts every run's latest conclusion once.
`baseline.dailyJst` groups by created time in UTC+09:00; missing dates are unknown.
`baseline.rerunRuns` counts runs with attempt >1 (not extra attempts).
`baseline.historical` reproduces the original PR/train/main table with separate
created→updated and started→updated estimates for **all completed runs including
cancellations**. This compatibility table is explicitly a historical update proxy;
it is separate from success-only exact durations and is never runner time.
`updated_at` is an update timestamp, **not evidence of completion**. This estimate
never fills attempt, job or step duration.

Attempt/run failure classification reuses `parseFailedLog`:

- `timeout`: explicit `timed_out` conclusion, or every parsed failed test timed out.
- `known-flaky-candidate`: every parsed failure belongs to the supplied file list.
- `code`: parsed failures outside that list, or recognized TypeScript/guard errors.
- `environment-candidate`: recognized runner/download/network/disk error signature
  in an otherwise unaccounted log. This is a heuristic requiring manual inspection.
- `unknown`: missing, expired, unrecognized or unaccounted logs.

Jobs and steps with a failure conclusion and no scoped log are `unknown`; an
attempt's classification is never blindly copied into each failed child.
A success, cancellation or unfinished subject has no failure classification.
Mixed/unaccounted logs cannot be excused as known-flaky by partial test matches.

## Verification and ongoing baseline

`tests/ci-run-metrics.test.ts` covers multi-attempt pagination/deduplication,
run-only replay, missing/cancelled/incomplete time, identity precedence, failure
parser reuse and all-mode zero-write fake GitHub runs. The CLI can run against
fake read ports without credentials or production state.

The historical 2,374-run draft was replayed from its original `gh run list`
snapshot. The nearest-rank created→updated estimates match the draft:

| Category | Runs / terminal | p50 / p90 minutes | Failure | Cancelled | Rerun runs |
| --- | ---: | ---: | ---: | ---: | ---: |
| PR | 1712 / 1709 | 12.53 / 20.98 | 218 | 208 | 23 |
| train | 170 / 169 | 17.08 / 23.15 | 72 | 2 | 0 |
| main | 492 / 491 | 12.18 / 24.57 | 25 | 66 | 6 |

Its run-only snapshot has no job/step or head evidence: all child coverage stays
unknown and branch-derived train identity stays unverified. Started→updated
p50/p90 also match: PR 12.43/20.43, train 17.08/23.15, main 12.17/23.72 minutes.
After review, collect at least 24 hours and manually check nonzero success/failure
samples against the original job/step timestamps and logs. Zero failure samples
cannot validate classification. This collector never changes merge switches.

API definitions: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)
and [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs).
