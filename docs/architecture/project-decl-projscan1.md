# Project declaration scan (generality-PROJSCAN1)

`manager project-decl-scan <project> [repoDir] [targetBranch] [--without-ai] [--rescan]`
produces a draft `.floka/project.json` (PROJDECL1 version 1, see
`project-declaration.md`) for any target repository and, when allowed, opens a
confirmation PR. The draft takes effect only after a PM or owner reviews and
merges that PR; the tool has no merge operation. Output is JSON without local
paths, argv details of failures, stderr or environment values. Exit 0 means
`observed`, `created` or `existing`; every refusal or failure exits 2 with a
`reasonCode` and, where relevant, a `manualEntry`.

Code: `src/lib/project-decl-discovery.ts`, `project-decl-scan-ai.ts`,
`project-decl-scan-run.ts`, `project-decl-scan-classify.ts`, `project-decl-gh.ts`,
`project-decl-scan.ts`; command `src/manager/project-decl-scan.ts` (one dispatch
import in `src/manager.ts`).

## Flow

1. **Repository.** The same trust boundary as PROJDECL1
   (`resolveDeclRepository`): the registered repository's common directory, an
   `origin` tracking ref fixed once, Git objects only.
2. **Discovery (deterministic, read-only).** From the fixed commit's tree:
   `package.json` scripts, `Makefile` targets, `pyproject.toml`, `go.mod`,
   `Cargo.toml` up to two directories deep (dependency/build/hidden directories
   skipped), plus direct `.github/workflows/*.yml|yaml`. 256 KiB and 32 sources
   at most. Symlinks and submodules are reported as `LINK_REJECTED`, never
   followed; worktree edits are never read. Candidates come from fixed
   generators and only for the task names test, lint, typecheck, check, build and
   vet. Deploy / release / publish are never candidates, and a definition that
   mentions an outbound action is marked `OUTBOUND_SUSPECT` and never runs.
3. **Model summary (optional).** Through `codex.ts` with a new thread (no named
   or resumed session), explicit cwd inside the isolation area, `read-only`, and
   `isolateMcp`. The model receives redacted material (expressions, assignments,
   URL credentials, home paths and token-like strings masked) and can only
   regroup or skip known candidate ids; unknown ids are ignored, invalid groups
   fail the summary and the deterministic grouping stays in force.
   Codex `read-only` removes write access but does not confine reads. With no
   attested read confinement (`CODEX_READ_ISOLATION.confined` is false today) the
   AI scan is **refused** with `READ_ISOLATION_UNAVAILABLE` and the manual entry.
   The operator can choose `--without-ai`: the same pipeline with no model at all.
   Prompt wording is not treated as isolation.
4. **One run per candidate.** In `<git common dir>/floka-scan/<run>` (inside the
   target repository, created without links): a detached worktree of the target
   head, `timeoutSec` (default 600) with process-group kill (`run-bounded.ts`), a
   minimal environment (PATH plus home, temp and every cache redirected into the
   area; no inherited token or key), and an execution boundary. On macOS the
   boundary is `sandbox-exec`: writes only inside the area, network denied.
   Without a boundary (other platforms) nothing runs and every item stays
   `inferred` with `EXEC_BOUNDARY_UNAVAILABLE`. A cwd that resolves outside the
   worktree is `CWD_ESCAPE`. Exit 0 within the timeout is the only path to
   `verified` (with `verifiedHead` = target head and `verifiedAt`); otherwise the
   item stays `inferred` and the reason (`COMMAND_FAILED`, `TIMEOUT`,
   `COMMAND_MISSING`, `SCRIPT_MISSING`, …) is listed in the result and PR body.
   stderr is classified in memory and discarded. Deploy is always
   `{adapter: "none", provenance: inferred}`; `requiredChecks` stays empty
   rather than guessed. The area is removed afterwards.
5. **Draft.** PROJDECL1 shape, validated with `parseProjectDeclaration`.
   `basis` lists only files that produced a candidate or workflow: relative path
   and content SHA-256.
6. **PR (mode `on`).** Commit built with plumbing on a private index on top of
   the target head, changing exactly `.floka/project.json` (hooks disabled).
   Branch `floka/project-decl-scan/<head12>-<hash10>`; the hash excludes
   `verifiedAt`, so retries map to the same branch. Any PR for that branch, in
   any state, is returned as `existing`, so no duplicate is opened and a closed
   one is not reopened. A rescan uses `floka/project-decl-rescan/…`, always a
   separate PR. `gh` / `git` use structured argv with bounded time and the
   existing identity; failures report class and exit code only.

## Runtime failure classification

`classifyDeclFailure` proposes a rescan only on explicit evidence: spawn
`ENOENT`, exit 127, or missing script / target / subcommand output. Test and
assertion failures, timeouts, network and dependency failures (for example a
missing Python module) never change configuration. `degradeForRescan` marks the
affected capabilities unavailable with `RESCAN_PENDING` until the rescan PR is
merged; the declaration is not rewritten. Later callers wire these interfaces.

## Recovery

Key `projectDeclScan`, permission class, default `observe`:

- `observe`: discovery, isolated runs and the draft are returned; one sample
  (`ObservedAction`, reason counts and the would-be branch, no argv or
  environment) goes to the injected port. No commit, branch, push or PR.
- `on`: additionally commits, pushes the scan branch and opens or finds the PR.
- `off`: refuses with `RECOVERY_OFF` before reading anything.

Rollback:

```
ledger scheduler-recovery claude-orchestrator off \
  --key projectDeclScan --reason "stop declaration scans"
```

Off stops only this mechanism. It never turns a missing declaration, inferred
item or manual state into a pass, and existing gates are unchanged. The PM
verifies the observation period (24 hours) before switching to `on`.

## Acceptance evidence

Tests (`tests/project-decl-scan*.test.ts`) use temporary repositories, a local
git and stubbed `gh`, remote git and Codex; nothing fetches or pushes.

- Python/pytest + GitHub Actions (`main`) and Go/Makefile (`develop`, no `web/`)
  each cover: normal (verified draft, PR commit differs only in the declaration,
  the merged result loads `valid`), undeclared (observe leaves refs, status and
  worktrees untouched, loader still `UNDECLARED`), inferred (failing commands
  stay inferred, loader `INFERRED_CAPABILITY`), stale basis (`BASIS_CHANGED`
  after editing a referenced file) and error paths (timeout, missing command, PR
  failure without stderr leakage).
- Behaviour: six source kinds, depth and size limits, link rejection, Git
  objects only, redaction, the classification table, `degradeForRescan`,
  minimal environment, missing boundary, cwd escape, idempotent retry (closed PR
  not reopened), separate rescan PR, exact `gh pr create` argv, no argv
  containing `merge`, Codex stub parameters (new thread, read-only, isolateMcp,
  isolated cwd, redacted prompt, no added commands), refusal without read
  confinement, recovery default observe, off.
- Executor isolation evidence (darwin, real processes, no stubs): a Makefile
  target writing outside the area and one connecting to a local listener both
  fail; the file never appears and the listener sees no connection. Real
  `go test/vet/build` and `make test/build` run as `verified` inside the
  boundary; Python without pytest stays `inferred` and is not a rescan case.
- Floka regression: a draft of the Floka fixture keeps the built-in's root
  commands (`bun run check`, `bun run test`, `bun run typecheck` among the
  built-in review commands); the built-in still loads unchanged. Before/after:
  `project-decl self show|validate`, bare `project-decl` and `project-list` give
  identical stdout, stderr and exit codes at the base head `2ba1f8b8ec75` and
  this branch. Only the new `project-decl-scan` command is asserted separately.

This is fixture and behaviour evidence only. It does not claim FULLGATE
deployment state or measured Claude capability.
