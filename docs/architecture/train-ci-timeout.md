# Merge train CI timeout recovery

The `trainCiTimeout` recovery key (dispatch-recovery-TRAINHANG1) decides what the merge train does when a car's CI is still pending past the car timeout (`TRAIN_CI_TIMEOUT_MS`, 60 min). The code is in `src/lib/train-ci-timeout.ts` (engine hooks + policy port) and `src/lib/train-ci-timeout-diag.ts` (diagnosis). The tests are `tests/train-ci-timeout.test.ts` and `tests/train-ci-timeout-diag.test.ts`.

## Modes (recovery-policy.json, default observe)

| mode | car past the timeout | train exit | deadline (6 h) |
|------|----------------------|------------|----------------|
| off | `voidTrain("车厢 X CI 超时")`, the same text, state and skip as before this key existed | unchanged | void, as before |
| observe | the same void, plus one deduped ledger note (`recovery-observe-v2`, actionKey `train-timeout:<train>:<car>`) | unchanged | void, as before |
| on | cancel → confirm → diagnose → `failCar` (the red-car path) | cancel what still runs on the train's branches | `giveUp("列车超过总时限，未定位")` |

The mode is read on every tick, and an unreadable policy file means off. If the train itself is not on (`mergeTrain` in scheduler.json), or the gh adapter lacks the Actions methods, the timeout key also acts as off. In that case, closing a train adds no cancel and no record.

## on: one car

1. **Claim.** The car's runs are listed by its own `train/<car>` branch only, so an author PR or main is never touched. Each run's unfinished jobs are snapshotted. The claim (`car.timeout`: runs, jobs, the checks still `pending`, kept as GitHub reported them) is saved before any cancel goes out.
2. **Cancel.** A cancel is sent per run. GitHub answers 409 for a run that already completed, and that counts as done (idempotent).
3. **Confirm.** Each later tick reads every claimed run by its id (`runStatus`, checked against the car's branch) until each one reports `completed`, re-sending the cancel to the rest. A run missing from a branch listing, or one whose status cannot be read, counts as still running: only a `completed` status confirms a cancel. The car's halves are not drafted before this point, so a hung CI never piles up runners. After `CANCEL_RECHECKS` ticks, or when a cancel fails or the runs cannot be listed, the train goes to `giveUp`. Members go serial and PM gets an alarm (judge), and the train never claims the runner is free.
4. **Diagnose.** For each job that was `in_progress`, the diagnosis records the shard number (from `test shard <n> of 4`), the last `::group::<test file>` in its job log (Actions shows it as `##[group]`), and the run link. Anything it cannot read says `未取到（<why>）`: log 404, log cut at the 1 MiB output cap, no test group in the log, a job that is not a shard, or a job still queued. A failed read never blocks the bounce. Shard artifacts (`test-shard-N`) are not read: they are zip files, and the gh argv adapter has no temp-file path. The job log of a cancelled job carries the same group lines.
5. **Fail.** The car goes through the engine's `failCar`, the same function a red car uses. A single card's check link is `<run> 列车 <train> 超时诊断：<diagnosis>`, fitted under the 600-character receipt (`fitTimeoutLink`): the run is given once, later job parts are dropped first with a count (`另 N 项诊断放不下`), and the first part is cut only as a last resort. The diagnosis itself reads every job still running at the timeout (none is skipped by position) and gives each run's link once, so four running shards all fit. bounceReceipt would otherwise blank a link that does not fit. A car with several members splits (at most `TRAIN_MAX_DEPTH` levels, and the split stops at a card whose halves both pass). A single card whose timed-out checks include a required one bounces with the existing `ci_fail` receipt, `超时诊断：分片号…；最后在跑的测试文件…；run…`. A single card that timed out only on non-required checks goes serial. The last test file is evidence, not attribution: only the bisect pins a card, and a single card's receipt carries only that car's own diagnosis.
6. **Queue starvation.** A car whose jobs only queued (none started) is cancelled and then judged (`giveUp`), never bisected onto a card.

State survives a restart. With a pending claim, the next tick rechecks the same runs. If the claim was confirmed but the car is still in `ci` (a crash before `failCar`'s save), the next tick fails it exactly once.

## on: train exit

Every exit (merged / void / serial) cancels the runs still `queued` / `in_progress` on the train's own branches before cleanup closes the PRs (`state.ciExit`). It confirms the same way: claim, cancel, recheck by id, at most `CANCEL_RECHECKS` ticks. Each run is cancelled on its own, so one refused cancel never keeps another runner busy. A branch whose runs cannot be listed stays in `unlisted` and is listed again on the next tick. Whatever is still running or unlisted after the last recheck goes into one PM alarm, naming the runs, the branches and the last error, and cleanup goes on. No new train forms until cleanup is done.

A void for main moving, a member head drifting or the train being closed never bounces anyone. A bounce is skipped only at its card + head, so a new head may ride again. What a void hands on depends on the mode (see 「a void keeps its verdicts」 below).

## CI job limits

`.github/workflows/ci.yml` sets `timeout-minutes` on every job. tests 35, check 10, web 15 and desktop 30, all under the 60 min car timeout. The values come from the last 15 successful CI runs: the longest shard took 22.5 min, and web / desktop took about 1 min with caches; desktop keeps headroom for a cold Rust build. These limits are static CI configuration and the recovery modes do not affect them, so turning trainCiTimeout off does not remove them. A hung test in the serial path therefore fails its own CI and bounces through the ordinary ci_fail. The change is recorded in `scripts/guard/baseline.json` `raised[]` (`guard:.github/workflows/ci.yml`, 0 → 0).

## on: a void during a timeout bisect

The train's right of way (`HOLD_LIMIT_MS` in `scheduler-merge-train-hold.ts`) ends 60 min after the train starts, so a timeout bisect always runs past it, and any outsider card that reaches the merge driver gate voids the train (`releaseOutsider`). main moving or a member head drifting voids it the same way. Such a void is handled like the early void of PM 补定 2. At cleanup (`voidUnlocated` in `scheduler-merge-train.ts`, which has the policy port and the PM notice that the merge driver's void lacks), the members of every timed-out car that are neither cleared by a green half nor pinned go serial. Their `taskId:head` keys join the state's `skip`, which a void still hands on, so they do not board the next train at these heads, and PM gets a judge alarm saying 「未定位」. A cleared half regroups as before. The hold limit itself is unchanged.

A void with no timed-out car, and every void under off / observe (the mode is read again at cleanup), keeps the old regroup with nothing serial and no alarm. `tests/train-ci-timeout.test.ts` 「[验收线 6]」 covers this.

## A void keeps its verdicts (dispatch-recovery-TRAINHANG2)

Before this, `nextSkip` handed nothing of a void train's own to the next train: everything regrouped. But a member sent serial before the void (a merge conflict, a lone red on a non-required check) or bounced by the bisect was a verdict about that card, not about the train, and the void does not undo it. Trains 130 and 131 were both voided by the hold limit after such verdicts, and train 132 regrouped the same three cards, replaying the same failure. The code is `src/lib/scheduler-merge-train-skip.ts` (`nextSkip`, `voidHeldKeys`, `voidSkipMode`) plus `stampVoidSkip` in `scheduler-merge-train.ts`. The tests are `tests/scheduler-merge-train-skip.test.ts`. It uses the same key, trainCiTimeout, and adds no key of its own, so it takes effect when trainCiTimeout is switched on.

| mode | what a void hands to the next train |
|------|-------------------------------------|
| off | its inherited `skip` only (plus what voidUnlocated added), exactly as before; nothing new is written |
| observe | the same as off, plus one train `observe` event (`data.mechanism = "trainCiTimeout"`, `data.skip` = the keys on would also skip). Nothing is written when on would add nothing |
| on | also every `taskId:head` in its `serial` and `bounced` |

The mode is read once at the void's cleanup, after `voidUnlocated`, through the same policy port, and saved as `state.voidSkip` (on, or observe once its event is recorded). A rerun of the cleanup sees the saved value, so it never records the observe event twice. `nextSkip(prev, mode = prev.voidSkip ?? "off")` only reads that value (or the mode a caller passes), so it stays pure and the tick's call is unchanged. A policy file that cannot be read, a mode that is not one of on / observe / off, a gh adapter without the Actions methods, or a train that is not on all mean off. A train that ended merged or serial hands on exactly what it did before, in every mode.

Division of labour with voidUnlocated: voidUnlocated owns the members that were still unlocated when the train was voided (timed-out cars, neither cleared nor pinned). It sends them serial, adds them to `skip` and raises the PM alarm. TRAINHANG2 owns the verdicts already written before the void (`serial`, `bounced`) and only decides whether the next train skips them. A member in both is simply skipped once. A card skipped this way boards again as soon as its head changes. The hold limit (`HOLD_LIMIT_MS`) is not touched.
