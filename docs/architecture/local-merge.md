# Local merge (ONB-1)

A repository with no GitHub PR flow (no `origin`, or one this machine never pushes to) can still run auto cards:
cards branch off the local `main`, the executor delivers a local commit, and the PM merges it into local `main`.
`localMerge` is the third merge path next to the PR merge driver and [merge handoff](./merge-handoff.md).

## Switch: `scheduler.json`

```json
{ "projects": { "dn": { "maxActiveWorkers": 2, "repoDir": "/abs/dn", "requiredChecks": ["cargo test --workspace"], "localMerge": true } } }
```

Parsing (`lib/scheduler-config.ts`) refuses — and so switches the whole config off — any of these together with `localMerge: true`:

- `mergeHandoff: true` (nobody here would merge);
- `deploy` (the deploy steps follow a PR merge);
- `remote` with any mode but `off`. `remote` absent means `off` for such a project: a peer cannot reach a branch that never leaves this machine.

`requiredChecks` keeps its shape (1..20 names, no comma) but means **commands** here: each one is split on whitespace
into argv (`checkArgv`) and never given to a shell, so no quoting, pipes or `&&`. Other projects still read it as GitHub check names.

Helpers: `prMergeOff(p)` = mergeHandoff or localMerge (no PR merges on this machine for the project), and
`localMergeOf(project)` = `{ repoDir, checks }` for a localMerge project, else null (an unreadable config reads as null).

## Executor side (node local1)

| Where | Local project | Every other project |
|---|---|---|
| `start_node` base (`lib/dag-tools-start.ts`) | `main`; `dag-tools-steps.ts` only fetches for an `origin/` base, so no fetch | `origin/main`, fetched first |
| Executor brief (`lib/dag-tools-prompt.ts`) | commit on the card branch, **no push, no PR**; deliver checks the local branch | unchanged byte for byte |
| `take_order` wire (`lib/order-take.ts`) | outputs / writeBack name the local branch, not origin | unchanged |
| MCP `deliver` (`lib/order-deliver.ts`) | head = `git rev-parse refs/heads/<branch>` in `repoDir`; no `ls-remote`, no `gh`, no `--pr`, `task.pr` untouched; a different head is `head_mismatch` | origin head + open PR |
| Work order acceptance (`lib/scheduler-work-order.ts`) | the project's own checks for author and reviewer | `bun run check` + PR CI |
| Review pack (`lib/review-pack.ts`) | `git diff main...HEAD` and the project's checks | `origin/main...HEAD` + `bun run check` |

The deliver-time out-of-scope file registration (`order-deliver-scope.ts`) reads the PR's diff; a local card has no PR,
so it records `deliver_scope_unavailable` (no `gh` is run) and the reviewer checks the diff against `fileGlobs` by hand.

## Merge side (node local2)

Not part of local1: the auto tick stops at `merge` without a merge intent and records `local_merge_ready`; the PM runs
`ledger local-merge <task> --head <sha>` (fast-forward or a clean merge commit, checks in a temporary worktree,
`git merge --ff-only` in the main directory, `merge → live`). Until local2 lands, a local card that reaches `merge` waits there.

Tests: `tests/scheduler-config-local-merge.test.ts`, `tests/dag-tools-local-merge.test.ts` (real git, no origin),
`tests/order-deliver-local-merge.test.ts` (real git + a fake `gh` on PATH that must never be called),
`tests/scheduler-work-order-local-merge.test.ts`, `tests/review-pack-local-merge.test.ts`.
