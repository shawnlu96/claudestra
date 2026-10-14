# CI selected gate (责任选集放行)

Card merge-arch-CISEL1 (CI side). Before this card every green verdict before a merge meant "the whole run succeeded". A test this PR neither changed nor was selected for (a load timeout, a flake another card left behind) turned the card red and sent it back to fix for nothing. This card freezes what the PR is answerable for and lets a red shard end green, with a receipt, when every failure in it is outside that set and outside the PR's changes. The ledger side (scheduler observation, recovery key `ciSelectedGate`, registering the flake for repair, telling PM) is CISEL2.

Code: `src/lib/ci-selected-verdict.ts` (pure verdict, receipt and proof section), `scripts/ci-selected-verdict.ts` (shard and gate wiring), `scripts/ci-related-plan.ts` (responsibility), `scripts/ci-proof-artifact.ts` / `src/lib/ci-proof.ts` (proof). Tests: `tests/ci-related-plan-responsibility.test.ts`, `tests/ci-selected-verdict.test.ts`, `tests/ci-selected-verdict-gate.test.ts`, `tests/ci-proof-selected.test.ts`.

## Responsibility vs. execution

`plan.json` gains `responsibility: { tests: string[] | "all", digest, fallbackReasons }`. It is computed beside the execution plan and never changes it: `scope`, `tests`, `shards` and every other field are byte-identical to what main built for the same input (pinned by hashes in the responsibility test).

| run | responsibility |
|-----|----------------|
| ordinary PR (any `CI_RELATED_CHECKS`, light, whole re-run, `ci-full` label) | the selector under on on the same checkout; the read map's selection when `CI_IO_MAP=on` |
| `workflow_dispatch` full re-check that belongs to a PR | the same, on the request's merge commit (base + head), once the PR's metadata (`gh api repos/<repo>/pulls/<pr>`, `pull-requests: read`) shows it open, from this repo, with `head.sha` at the request's head and a non-`train/` `head.ref` (another branch on the same commit proves nothing about the source); otherwise `"all"` (a dispatch has no `GITHUB_HEAD_REF`) |
| any full fallback of the selector (global input, graph failure, bad diff line) | `"all"` with the reasons |
| push (main), train PR, other events, a dispatch with no PR | `"all"` |

`digest` is `sha256:` of the sorted list (or `"all"`); a reader that recomputes a different digest reads no responsibility.

## Verdict (`judgeSelected`)

Input: the responsibility, the shard's failures (`parseFailedLog` of `scheduler-merge-ci-rerun-log.ts`, run over the shard's own log after mapping `::group::` / `::error` workflow commands to the runner's `##[…]` form), the PR's changed files, whether the shard ran to the end, and the non-test steps. Output `{ allow, reason, outOfScope[] }`. Not released when any of these holds:

- the responsibility is missing, does not match its digest, or is `"all"`;
- any of typecheck, guard, entry build, web build is red (in the shard, guard and build run after the test step and are `pending`: red there still fails the shard on its own; web build keeps its own check);
- the shard did not run to the end: bun did not exit 1, never printed its `Ran N tests across M files.` line, or ran other files than it was assigned (a cancelled or timed-out shard never reaches the verdict at all);
- the failures did not parse completely (unknown error, totals that do not add up, a failure outside a file group), there are none, or one is not a test file;
- the PR's changes cannot be read, or touch the verdict's own inputs (`scripts/ci-selected-verdict.ts`, `src/lib/ci-selected-verdict*.ts`, `scheduler-merge-ci-rerun-log.ts`, `scripts/ci-related-plan.ts`, `canonical-json.ts`; a PR runs its own copy, so this only guards against a mistaken edit, review is the real gate);
- any failing file is in the responsibility or in the changes.

## Wiring (`CI_SELECTED_GATE`)

The mode is the trusted repository variable `CI_SELECTED_GATE`, normalised in the workflow to one of three literals before any script sees it: a PR cannot carry a value of its own.

- **off**: the `Unit tests` step exits with bun's own code exactly as before and never calls the verdict (pinned against main's step text in the gate test); the plan is not downloaded, no receipt is written. The check job's new step finds nothing released, prints nothing and exits 0.
- **unset / observe**: on a red shard the verdict runs, the receipt is uploaded as `ci-selected-shard-<k>`, and one line `ci-selected: shard=… mode=observe allow=… applied=0 responsibility=<digest> out_of_scope=N reason=…` is logged. The shard stays red with bun's exit code.
- **on**: when the verdict allows, the `Unit tests` step itself exits 0 (no step-level `continue-on-error`) and the receipt (`applied: true`) is uploaded without tolerance; a refusal keeps bun's exit code.

A receipt binds mode, shard, run id, attempt, checkout head, plan digest, responsibility digest, the shard log's digest, the exit code and the verdict.

### Gate

The check job (`typecheck + test + guard`) keeps its name, its first step `All shards succeeded` and that step's wording (`GATE` / `GATE_VERDICT` in `scheduler-merge-ci-rerun-log.ts`). After the existing checks, `Released shards carry receipts` treats as released every shard whose bun closing summary (the block right above the last `Ran N tests across M files.` line, not test output before it) shows fail or error above 0 (it ended green, so something released it) plus any shard a receipt of this attempt claims (`applied` not `false`, an unreadable one included). An applied receipt must carry a responsibility digest or it does not parse. Each must have a receipt of this run, attempt, checkout and log, applied under on, all from one responsibility; otherwise the gate is red, as it is for a release while the mode read here is not on (a switch mid-run). With a release it uploads `ci-selected-verdict` (mode, run / attempt, head, responsibility digest, every out-of-scope `{file, name}`, each receipt's digest) and logs `ci-selected: allow=1 out_of_scope=N`.

Trains and main pushes never benefit: their responsibility is always `"all"`.

## Proof

`scripts/ci-proof-artifact.ts shard-facts` adds the shard's receipt to its facts (`selected`, only when there is one; facts are otherwise unchanged). The producer finds released shards the same way as the gate; each needs its receipt bound to this run, attempt, checkout and log, or there is no proof. With releases it writes the section `selected.json` (`version: "ci-selected-1"`, run, attempt, head, responsibility digest, each receipt with its digest) into the `ci-proof` artifact and appends its digest to the manifest: `policyVersion = "ci-full-1+ci-selected-1:<sha256>"`. The covered-universe evidence (`tests.selectedDigest = tests.universeDigest`) is the same as before. `report.json` gains `selected: { version, digest }` only in that case.

`verifyCiProof` compares `policyVersion` exactly as before; only the suffixed form is read as a released proof, and then `CiRunEvidence.selected` must hash to the suffix, match the run, the attempt and the manifest's checkout, and each receipt must hash to its listed digest and be applied for that same run. A missing or mismatched section is an invalid proof. A proof with no release is unchanged. The port (`scheduler-ci-proof-port.ts`) does not read `selected.json` yet: until it does, a released proof never authorises a merge (CISEL2).

## Ledger side (CISEL2)

Code: `src/lib/ci-selected-receipt.ts` (the one read port), `src/lib/scheduler-ci-selected-gate.ts` (mode, decision, wiring, records). Tests: `tests/ci-selected-receipt.test.ts`, `tests/scheduler-ci-selected-gate.test.ts`, the CISEL2 block of `tests/pm-merge-preflight.test.ts`.

**Read port.** `readCiSelectedReceipt(port, repo, head)` takes the CI workflow's newest `pull_request` run for the PR head and its latest attempt; `readCiSelectedRunReceipt(port, repo, runId, checkout)` reads a given run (the ci-full re-check). A run is *marked* when it lists a `ci-selected-verdict` artifact, expired or not (an expired one is marked with a null receipt: the release happened, the evidence is gone). When the run lists no such artifact and no unexpired `test-shard-<k>` log either (the batch the verdict is uploaded with, same 14-day retention, has expired or been deleted), the absence proves nothing: the port reads the `typecheck + test + guard` job's log of the latest attempt, and a `ci-selected: allow=1` line, or a log that is gone too (HTTP 404 / 410), marks the run with a null receipt; any other log read failure is a failed read (wait). With fresh shard logs and no verdict artifact the run is plain, read with the one listing as before. The verdict must parse strictly (exact keys, version 1, `sha256:` responsibility digest, at least one shard receipt digest), name this run id and its latest attempt, and its checkout must be the PR head or GitHub's test merge whose second parent is the head (ci-full: exactly the request's merge commit). Otherwise the receipt is null. The answer is `{ allowed, outOfScope[], runUrl, … }`; `allowed` = the CI released under `on` with at least one out-of-scope failure. The scheduler's merge paths and `scripts/pm-merge-preflight.ts` read only through it.

**Effective mode.** The stricter of the repository variable `CI_SELECTED_GATE` (unset / unknown = observe, unreadable = off) and the recovery key `ciSelectedGate` (absent = observe, unreadable policy = off); off is stricter than observe, observe than on.

**Decision** (only for a snapshot whose checks are all green; a red or pending snapshot is never read):

| marked | receipt | mode | result |
|---|---|---|---|
| no | – | any | unchanged (`plain`) |
| yes | null or not allowed | any | red |
| yes | allowed | on | accepted; repairs registered |
| yes | allowed | observe | red + one `ci_selected_gate_observe` observation |
| yes | allowed | off | red, nothing recorded |

*Red* in the merge driver: `driveMerge` wraps `inspect` (one line) so the run's required checks, and checks linking to that run, read `fail`; the existing ci_fail path then bounces (CIF1 / CIF2 / CICANCEL1 unchanged). A failed GitHub read marks them `pending` for that tick (no merge, no bounce). Every inspect goes through it, so serial merges, `mergeDirect` and the final pre-claim read all see the same answer. In the ci-full re-check (one line in `fullRecheck`) a red is the existing `run_failed` (unknown for PM). The PM preflight refuses with exit 2. Trains are untouched (their responsibility is `"all"`), and nothing here reads or clears the main CI pause (ROLLBACK1 / `mainCiPause`).

**Records** go through the merge tick's leased manager (`bindCiSelectedSink` in `scheduler-service.ts` mergeTick, like the other sinks); with no sink bound (tests, other processes) they are only logged, never thrown, and a failed write never changes the answer. Both are `recovery_observe` notes of mechanism `ciSelectedGate` on the card:

- observe: `data.kind = "ci_selected_gate_observe"`, action key `observe.<run>.<attempt>.<head12>` (one per run + attempt + head), with head, run / attempt, run URL, the out-of-scope `{file, name}` list and `wouldAllow: true`.
- on: one `data.kind = "ci_selected_repair"` fact per out-of-scope failure per release (`repair.<key>.<run>.<attempt>`, `key` = sha256 of file + test name). Then pending repairs go out: a fact of the last 24 hours is pending unless a `ci_selected_repair_notified` note of its key lies at or after 24 hours before it. Pending facts are merged per key into one `info`-level notice to the project PM with the cards and run link (routine: PM pulls it, it never wakes them); only after the notice is sent does one `ci_selected_repair_notified` note per fact (`notified.<key>.<run>.<attempt>`) record it. Nothing is added to the CIF8 known-flaky list and no fix node is opened; PM decides.

Dedup is confirmed only by success: the in-process "already done" mark for an observation or a release's facts is set after the write went through, so a transient ledger error is retried on the next inspect; a failed notice records nothing and stays pending, sent by the next release or by the merge tick's re-send (any inspect through the gated external with a sink bound, at most every 10 minutes per project, also right after a restart since it reads the ledger). A lost `notified` write re-sends at most once more (at least once, never silently dropped).
