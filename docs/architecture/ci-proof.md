# CI coverage proof

Card merge-arch-CIPROOF1. Today every merge gate reads `requiredChecks` by name and bucket only (`scheduler-merge-driver.ts` `green()`, the train's `ciVerdict`). A green check with the right name passes the gate even when it ran on the wrong repo, tree, base, workflow version, toolchain, artifact or attempt. The CI coverage proof checks what the run actually tested against the merge subject. The model itself is pure; since merge-arch-GATE1 four scheduler entries ask it through one gate (see *Wiring* below), under the recovery key `ciCoverageGate` (default observe: nothing an existing train, serial, manual or PM path does is changed).

Code: `src/lib/ci-proof-manifest.ts` (manifest parse and digest) and `src/lib/ci-proof.ts` (verification and gate). Tests: `tests/ci-proof.test.ts`.

## Manifest

A trusted CI run writes one JSON manifest as an artifact. It binds:

| field | meaning |
|-------|---------|
| `version` | manifest format, currently 1 |
| `repo`, `head`, `base` | the PR (or train) subject |
| `checkout.sha`, `checkout.tree` | the commit and tree the jobs checked out (a PR's merge ref, or a train's combined commit) |
| `workflow.path`, `workflow.sha` | the workflow file and its version |
| `policyVersion` | merge policy version |
| `toolchain.bun`, `toolchain.lockfileDigest` | toolchain and lockfile |
| `tests.universeDigest`, `tests.selectedDigest`, `tests.count` | digest of all tests, digest of the tests run |
| `scope` | `related` or `full` |
| `checks` | required check names the run covered |
| `train` (optional) | `members` (PR + head, in boarding order), `combinedTree`, `baseline` |

The parse is strict. A missing field, a wrong type, an unknown version or scope, or any key the parser does not know rejects the whole manifest. An unknown field therefore never produces a full proof. The digest is `sha256:` of the key-sorted JSON, so key order does not matter.

## Verification (`verifyCiProof`)

The caller supplies the expected subject (`CiProofExpect`) from its own facts (ledger, PR snapshot, scheduler config), never from the run. The evidence (`CiRunEvidence`) is one run as read back. Verification rejects, with a reason for each problem:

1. **Source.** Only `origin: "actions-api"` (workflow run → attempt → jobs → artifact read from the Actions API) counts. An author-written JSON or a check run that only carries a name is never proof.
2. **Run.** It must be the same repo, the approved workflow path and version, the latest attempt, and `completed`, and its API `head_sha` must equal the triggering head: `runHead` when the caller sets it (e.g. a train run on the combined commit), otherwise `head`. For `pull_request` the API reports the PR head while jobs check out the merge ref, so the run head is never compared with the checkout; step 3 and the manifest prove the checkout.
3. **Jobs.** Each required check has a job in this attempt, and every job of this attempt — each same-name matrix entry and each extra test shard, not only the first match per required name — really checked out the expected SHA and tree. A checkout that was not read counts as a mismatch.
4. **Artifact.** It must come from this run and attempt, its digest must equal its content's digest, and the content must be a valid manifest.
5. **Binding.** Every manifest field above must equal the expected subject. Repo slugs and hex SHAs / digests compare case-insensitively; `workflow.path`, `policyVersion` and `toolchain.bun` compare exactly (Git paths are case-sensitive, versions are opaque). A train subject must match the manifest's members and heads in order, its combined tree (also equal to `checkout.tree`) and its baseline. A train manifest is rejected for a single-PR merge. This only checks the fields: what a train carries over between runs is unchanged.

A bound `related` proof is `ok`, but `mergeAuthorized` is always false. A `full` proof authorises a merge only when, in addition, the selected tests equal the universe, every required check is in `checks`, every job of the attempt concluded `success` (skipped, cancelled, neutral or unknown all reject) and the run concluded `success`.

## Gate (`judgeCiCoverage`)

There is one pure entry point for the planner, inspect, mergeCandidates and the deploy tick. Each path passes its own verdict as `prior`, and the gate only ever narrows it:

| `ciCoverageGate` | result |
|------------------|--------|
| off | `prior`, proof not read |
| observe (default) | `prior`, plus the reasons it would deny |
| on | `prior` and a full proof that authorises the merge; a missing or mismatched proof denies |

`ciCoverageGateMode(raw)` reads the key: a missing key, or any value other than off / observe / on, reads observe. The key is `ciCoverageGate` in `recovery-policy.ts` (`ledger scheduler-recovery`).

## Wiring (merge-arch-GATE1)

Code: `src/lib/scheduler-ci-proof-gate.ts` (the shared decision and the four entries) and `src/lib/scheduler-ci-proof-port.ts` (the read-only GitHub port). Tests: `tests/scheduler-ci-proof-gate.test.ts`, `tests/scheduler-ci-proof-flow.test.ts`. `scheduler-pass.ts` opens the gate once per pass (`openCiProofGate`) with the pass's guarded command; a pass whose merge external is injected (a test world) opens none, since the gh-backed port would read another GitHub.

**Subject.** The proof is asked for the exact integration content, not the PR head. For a PR, the commit the run checked out must be a merge whose parents are [the main it would merge onto, the reviewed head]; a main that moved since the run therefore voids the proof. For a deploy it is the main commit that would be deployed, proven by its own push run. A push manifest's base is the push event's `before` (`scripts/ci-proof-artifact.ts` `proofRun`); when one push brings several commits that is not the tip's first parent, and no API reads it back, so the gate takes the manifest's own base for a main subject and lists it as attested. What the push run tested stays bound independently: the checkout must be the pushed commit itself with the tree the Git API reads back.

**Serial / manual PRs and the SELECT1 re-check.** A PR whose own `pull_request` run is related-only is proven by its SELECT1 full re-check: a `workflow_dispatch` run triggered on main. The gate computes the same binding SELECT1 dispatched (PR, head, main, GitHub's test merge commit and its tree; `fullRequestId`), finds the run of main whose title names that id, and verifies it with two different heads: the run's head is main (`runHead`, which must be the main the PR merges onto), the tested content is the test merge of [main, PR head] (`head`, `checkout`). A moved main or head is another binding, so the old run is never found. On the CI side `scripts/ci-proof-artifact.ts` writes a full manifest for such a run only when the request id is the digest of its inputs and the proof job checked out exactly `inputs.merge` with `inputs.tree`; any other run whose checkout is not `GITHUB_SHA` is refused as before, and push / pull_request / train runs are written unchanged.

**Train members.** The proof is the green car's own PR run. Its checkout must be a merge of [B, car head] where B is the train's fixed base, or that base advanced only by merges of members this train cleared (the walk `mainOnlyMembers` does). The manifest's base is compared with B, never with the pulls API's current base, which moves on as members merge. Whether main is still acceptable right before each merge stays the train's own `recheckCleared`.

| entry | where | what it does |
|-------|-------|--------------|
| planner | `scheduler-plan.ts` merge step | admit stage: planning a merge intent never needs a proof |
| mergeCandidates | `scheduler-merge-train-tick.ts` | admit stage: boarding a train never needs a proof (the combined proof is asked when a cleared member merges, through the train hook `ciProofTrain`) |
| merge driver | `scheduler-merge-external.ts` `withCiProofGate` | after the path's own full re-check (`fullRecheck`) lets a run go on, a missing proof answers "wait"; the merge call reads the proof again in full right before sending (main, the run's latest attempt, its artifact, the reuse revocations): the pass's earlier answer is never reused, and a proof that is gone by then sends nothing (`合并未发出：缺 full 证明`). Ordinary, serial, manual-queue and PM-repair runs all use this external |
| deploy tick | `scheduler-deploy-tick.ts` `ciProofDeploy` | no deploy is claimed or submitted without the proof of the main tip, and under on the job deploys exactly that commit |

**Modes.** off reads nothing. observe (the default) changes no external action and writes one ledger note per distinct "on would wait for the full proof" (`recovery_observe`, mechanism `ciCoverageGate`, through the pass manager's `ledger scheduler-recovery-observe`); an unreadable GitHub is one such note too. on only waits: the merge run stays in its phase (no fix, no freeze, no slot taken). Two cases end a wait instead: main moving between the proof and the merge call refuses that merge unsent (as the serial full re-check does), and a deploy whose main run finished without a proof, or did not deliver one within 45 minutes, is settled as "not deployed automatically, PM deploys" so the merge slot is not held forever and a main-CI repair can still merge. A merge never needs main's own proof.

**Deploy target.** Under on the tick writes the proven main commit into the job's `request.json` as `deploySha`. After its fetch the job checks that this commit is on origin/main, contains the merge and is not behind the tree, then fast-forwards to it instead of to origin/main; a main that moved on after the proof is not deployed. If a check fails the job refuses this deploy without touching the tree (never moved back) and is not retried; the journal records the failure for PM. A claim found by a later pass (after a restart) is proven again before it is submitted: it waits as claimed while the proof may still arrive and ends unsubmitted when it will not. Under off and observe no `deploySha` is written and the request and steps are exactly the old ones; observe adds one note, "on would pin the deploy to X", when the tip is proven.

**Port.** Every read asks GitHub again for the run (a re-run adds an attempt under the same run id), its artifact list (an archive expires or is deleted) and the reuse receipts with the revocation list. Only immutable content is kept in memory: a commit, a file at a commit, the jobs of one finished attempt, an artifact's bytes (still checked against the listed digest on every read). GET only: `gh api` on a fixed set of path shapes, artifact archives fetched from api.github.com with the gh credential (the signed redirect without it) and checked against the digest GitHub registered. The Actions API exposes no per-job checkout, so every job of an attempt is given the run-wide commit that attempt's proof report recorded, accepted only when the Git API reads it back as this run's subject. `tests.universeDigest` has no independent source on the scheduler side and is taken from the manifest (the report output says so); the lockfile digest and the Bun version are read from the tested commit.

**Known gaps (before switching to on).** A re-check run dispatched before this card's workflow script is on main carries no manifest, so its PR waits until a new binding is dispatched. A host running git / gh by hand is outside the scheduler, so this is a gate on its own actions, not a security boundary. `scripts/pm-merge-preflight.ts` prints the same evidence and gaps for a manual merge and blocks nothing.

## Rollout (PM)

After wiring, run observe for at least 24 h. It should produce both rejections and acceptances. Check each sample against the real GitHub run. With zero samples, do not switch to on. Never edit `requiredChecks` to get around missing evidence.
