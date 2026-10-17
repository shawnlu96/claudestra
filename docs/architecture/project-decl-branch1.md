# Branch context for dispatch and lending (generality-BRANCH1)

Dispatch, lending, reborrowing, remote fixes and local author plans used to fill in
`main` downstream: the write order's PR base was a constant, reborrow checks
required `main`, and the local author started from `origin/main`. This card adds
one branch context that is resolved once and then only carried and re-checked.
Merge, handoff, CI queue/proof, UI freshness and verification facts are
generality-BRANCH2's; they consume the interface below and are not changed here.

## Context

`src/lib/project-branch.ts` defines `BranchContext` (version 1):

| field | meaning |
| --- | --- |
| `remote` | canonical `owner/repo` of origin |
| `defaultBranch` | origin/HEAD as fixed in local Git metadata (null when an explicit target made it unnecessary) |
| `targetBranch` | merge target = PR base |
| `workStartRef` / `workStartSha` | where the work starts; may differ from the target |
| `targetHead` | tracking head of the target at resolution |
| `source` | `declared`, `config`, `pr`, `remoteHead` or `legacy` |

A work start never stands in for the target. `parseBranchContext` is strict: a
malformed context on a card is a stop, never a partial context.

## Resolution

`resolveBranchContext` (pure) and `readBranchContext` (`project-branch-git.ts`,
local Git only, no fetch) apply, in order:

1. origin must have a recognizable identity (`REMOTE_UNKNOWN`) equal to the
   order repository and the declared remote (`REMOTE_MISMATCH`).
2. Explicit target: the PROJDECL1 declaration's `repository.targetBranch`, or for
   the Floka repository without a declaration, the configured value `main`.
   A declaration read at origin/HEAD that names another target is read again at
   that target's own head; both reads must name the same target and remote
   (`DECLARATION_INCONSISTENT`), and the declaration basis must still match at
   the target head (`BASIS_STALE`). A malformed declaration blocks fallback.
3. An existing PR base that differs from an explicit target is `PR_BASE_CONFLICT`.
4. Without an explicit target: the existing PR base, else origin/HEAD
   (`source: remoteHead`, i.e. inferred). Neither available is
   `REMOTE_HEAD_MISSING`; `main` is never guessed.
5. The start ref (default: the target) and the target must have direct tracking
   heads; their SHAs are fixed into the context.

`carryBranchContext(prev, next)` rejects any change of remote, target, start ref,
or an already fixed start SHA (`CONTEXT_CHANGED`). `legacyBranchContext` completes
an old order only when repository, order base and PR base name one target; a
non-main base needs the PR base as second witness. Anything else stops.

## Wiring in this card

`src/lib/project-branch-order.ts`:

- `writeBranchPlan` — used by `writeMaterials` for write orders. The context comes
  from the card (`task.extra.branchContext`), an optional
  `WriteProbe.branchContext` port, or the Floka legacy completion; a probe result
  must equal the carried context. Under on the order's base is the target and the
  start head is read from the start ref; a start head different from a fixed
  `workStartSha` is `BASIS_STALE`. The returned material carries `branchContext`.
- `fixOrderBase` / `fixWriteBase` — remote convergence fix orders
  (`fix-strategy-remote*.ts`) and fix materials keep the card's latest recorded
  order base (or the card context's target).
- `localAuthorStart` — `scheduler-local-author-plan.ts` starts at the carried
  start (SHA if fixed), never at the target.
- `carriedTarget` — reborrow checks (`lend-reborrow-source/-basis/-event/-apply.ts`)
  require the new order and PR base to equal the previous order's base. The
  provider side (`lend-reborrow-provider.ts`) requires old and new journal bases
  to be the same valid branch.

The dispatcher that fills `task.extra.branchContext` from `readBranchContext`,
and persisting the full context on the order row, are BRANCH2 / ledger work; the
order row already carries the target (`base`) and the start head (`head`).

## Recovery key

`projectBranchContext`, schema class, default `observe`.

- observe: every action is the legacy one (base `main`, start from the caller's
  `--base`); a differing or failing resolution is recorded once per card round
  as a recovery observation. Floka's main path records nothing.
- on: the context is propagated as above; any error stops for the PM.
- off: no new propagation; a card that already records a non-main target is
  refused rather than re-defaulted to `main`. Reborrow checks under observe/off
  still only accept `main`, so a recorded develop target fails closed.

Rollback: `ledger scheduler-recovery claude-orchestrator off --key projectBranchContext --reason ...`.
Before switching to on, the PM reviews the observations.

## Tests

- `tests/project-branch.test.ts`: Python/pytest + GitHub Actions (main) and
  Go/Makefile (develop, no `web/`) fixture repositories: declared, re-declared
  target, undeclared/inferred, PR base, missing origin/HEAD, stale basis, PR
  conflict, remote mismatch, missing start, malformed declaration, untrusted remote.
- `tests/lend-write-materials.test.ts`: develop target with a feature start
  through dispatch, fix offer, reborrow and local author under on; observe and
  off; Floka main path byte-identical in every mode.
