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
| `start_node` base (`lib/dag-tools-start.ts`; the bridge tool and the scheduler's own autostart, `scheduler-autostart-deps.ts`, both inject `localMerge`) | `main`; `dag-tools-steps.ts` only fetches for an `origin/` base, so no fetch | `origin/main`, fetched first |
| Rebuilding a missing author (`scheduler-local-author-plan.ts` / `scheduler-local-author.ts`) | base `main` (or the card's head), local brief, no `fetch origin` | `origin/main`, fetched first |
| Executor brief (`lib/dag-tools-prompt.ts`) | commit on the card branch, **no push, no PR**; deliver checks the local branch; checks are the project's own, a failing one goes into the evidence (no CI wait). The machine-wide `ledger/prompts/exec-template.md` is written for the PR flow and is **not** used | unchanged byte for byte |
| `take_order` wire (`lib/order-take.ts`) | outputs / writeBack name the local branch; acceptance starts with the project's checks | unchanged |
| `take_review` wire (`lib/review-order.ts`) | acceptance starts with the project's checks (then the spec lines, cut to the wire's item cap) | unchanged |
| Standard answers (`lib/order-standard-answers.ts`, on every order) | "no PR CI, the checks are: …" instead of "PR head CI" / "the merge gate checks CI"; an out-of-scope red check is listed with how to reproduce it, not a run link | unchanged |
| MCP `deliver` (`lib/order-deliver.ts`) | head = `git rev-parse refs/heads/<branch>` in `repoDir`; no `ls-remote`, no `gh`, no `--pr`, `task.pr` untouched; a different head is `head_mismatch` | origin head + open PR |
| Work order acceptance (`lib/scheduler-work-order.ts`) | the project's own checks for author and reviewer | `bun run check` + PR CI |
| Review pack (`lib/review-pack.ts`) | `git diff main...HEAD` and the project's checks | `origin/main...HEAD` + `bun run check` |

The deliver-time out-of-scope file registration (`order-deliver-scope.ts`) reads the PR's diff; a local card has no PR,
so it records `deliver_scope_unavailable` (no `gh` is run) and the reviewer checks the diff against `fileGlobs` by hand.

Not adapted (fail safe, back to PM): the author *rebuild* after a lost session (AREB1, `scheduler-author-rebuild*.ts`) reads the
PR head from `origin/<branch>`, and the PM resume grant (`scheduler-autostart-deps.ts` `remoteHead`) reads `ls-remote origin`; on a
local project both fail their read and hand the card to PM manually instead of acting.

## Merge side (node local2)

| When | Where | What |
|---|---|---|
| Planner says "merge" | `scheduler-auto-tick.ts` → `lib/local-merge-tick.ts` | no merge intent, no merge slot, no `gh`; `ledger scheduler-local-merge-ready <task> --head` writes one `scheduler` event `op: "local_merge_ready"` (dedup = this entry into `merge` + head); PM is told once. A card already marked ready reads the ledger only (no CLI call per pass); a restart does not tell PM again |
| A merge intent left from before the switch | auto tick | not driven: the card goes to PM (`scheduler-fallback-manual`) |
| PM runs `ledger local-merge <task> --head <sha>` | `manager/ledger-local-merge-cmds.ts` → `lib/local-merge-run.ts` | running it is the PM's confirmation; steps below |

`local-merge` (`runLocalMerge`), in this order — any refusal before step 6 leaves main, the card and the ledger as they were:

1. A `local_merge` record for this card and head already exists → return it (`duplicate: true`).
2. Ledger gate (`localMergeGate`, `lib/local-merge.ts`): caller is the project's PM (not the dispatcher) / master / owner; card in `merge`; `--head` = ledger head
   = the head this round's review passed (an auto card: the merge proof `mergeReviewProof`, cross-family; a manual card: its round's review, no P0/P1);
   UI screenshots accepted; queue not frozen. The project must be `localMerge` with an absolute `repoDir`.
3. Project lock: `<git common dir>/claudestra-local-merge.lock` (`lib/file-lock.ts`, no wait) — a second run meanwhile is `busy`.
4. The main directory must be on `main` with a clean `git status --porcelain` (untracked files count). Then the commit that will land:
   head already on main → only the record is written (`backfill`, no checks); main an ancestor of head → fast-forward (`ff`);
   otherwise `git merge-tree --write-tree main head` clean → `git commit-tree` with parents (main, head) (`merge`); a conflict refuses.
5. A temporary worktree (`git worktree add --detach`) at that commit; each `requiredChecks` entry runs there as argv (`checkArgv`), `CHECK_TIMEOUT_MS`
   (30 min) each, stopping at the first failure. The worktree is always removed. A failed / timed-out check refuses.
6. main unchanged and the directory still clean, the ledger gate again, then `git merge --ff-only <commit>` in the main directory.
7. One transaction (`recordLocalMerge`): a `decision` event `op: "local_merge"` (`head`, `mergeSha`, `base` = main before, `mode`, `checks`
   [{check, code, timedOut, ms}], `reviewSeq`), `merge → live` (stage event with `head`, `mergeSha`, `localMergeSeq`), the card's file locks released.

If step 7 fails after step 6, the head is on main: rerunning the command backfills the record. After live, the PM runs `ledger verify`.

The PR paths a localMerge project never reaches (`prMergeOff`, same places as a handoff project): merge driver (`mergeTick`), merge train and slot
reclaim (`scheduler-pass.ts`), main CI gate (`mainCiPass`), merge pipe (`mergePipeStep`), CI queue full (`ciQueueFullStep`), the manual merge queue's
owner / candidate observation and claim (`manual-merge-queue-pass.ts`). `manual-merge-request` is refused with a pointer to `local-merge`
(`requestRefusal`, reason `localWhy`); the unified queue view shows such cards excluded with code `local_merge`.

Tests: `tests/scheduler-config-local-merge.test.ts`, `tests/dag-tools-local-merge.test.ts` (real git, no origin),
`tests/order-deliver-local-merge.test.ts` (real git + a fake `gh` on PATH that must never be called),
`tests/scheduler-work-order-local-merge.test.ts`, `tests/review-pack-local-merge.test.ts`; merge side: `tests/local-merge-run.test.ts`
(real git), `tests/local-merge-tick.test.ts` (auto tick, CLI identities, manual-merge-request), `tests/local-merge-pass.test.ts` (the real
`schedulerPass`, zero GitHub reads).
