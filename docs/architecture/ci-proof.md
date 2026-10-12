# CI coverage proof

Card merge-arch-CIPROOF1. Today every merge gate reads `requiredChecks` by name and bucket only (`scheduler-merge-driver.ts` `green()`, the train's `ciVerdict`). A green check with the right name passes the gate even when it ran on the wrong repo, tree, base, workflow version, toolchain, artifact or attempt. The CI coverage proof checks what the run actually tested against the merge subject. It is a pure model: nothing calls it yet, and it changes no existing train, serial, manual or PM path.

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
2. **Run.** It must be the same repo, the approved workflow path and version, the expected checkout commit, the latest attempt, and `completed`.
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

`ciCoverageGateMode(raw)` reads the key: a missing key, or any value other than off / observe / on, reads observe. The `ciCoverageGate` key in `recovery-policy.ts` was left out of this card's file scope and is added when the gate is wired in.

## Rollout (PM)

After wiring, run observe for at least 24 h. It should produce both rejections and acceptances. Check each sample against the real GitHub run. With zero samples, do not switch to on. Never edit `requiredChecks` to get around missing evidence.
