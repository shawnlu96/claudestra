# Merge handoff (MHO1)

For a repository this machine does not own (claudestra's `shawnlu96/claudestra`: we open PRs, the owner merges), an auto
card must stop at the merge and leave it to the repository owner. `mergeHandoff` makes the scheduler do exactly that: hand
the PR over with this machine's review evidence, follow the PR, and move the card on from what GitHub says. Nothing on this
machine merges, updates a branch, forms a merge train or takes the merge slot for such a project.

## Switch: `scheduler.json`

```json
{ "projects": { "claudestra": { "...": "...", "mergeHandoff": true } } }
```

Absent or `false` = the project merges locally exactly as before. `true` together with `deploy` is refused (whole config
off), since nothing would merge here to deploy. Parsing: `lib/scheduler-config.ts`.

## Flow

| When | Where | What |
|---|---|---|
| Card reaches `merge` | planner (unchanged) | the same gate as a local merge: this round's cross-family review, dispatch proof, P0/P1 = 0, UI approval, queue not frozen, no blocker |
| Planner says "merge" | `scheduler-auto-tick.ts` → `scheduler-merge-handoff-tick.ts` | no merge intent is planned; the PR is read (`gh pr view <url> --json state,headRefOid,mergeCommit`) |
| PR open at the card's head | `ledger scheduler-merge-handoff <task> --head --pr` | one `scheduler` event `op: "merge_handoff"` with `data.evidence` (below), rechecked in its transaction; PM is told once |
| Waiting | auto tick | the PR is read at most once per `HANDOFF_POLL_MS` (60 s) |
| PR head moved by merging main in | `… --carry <new> --from <followed> --main-parent --main-head --diff-hash` | one `scheduler` event `op: "merge_handoff_carry"`; the handoff now follows the new head (below) |
| PR `MERGED` at the followed head | `… --merged <merge commit>` | `merge → live` (stage event carries `head` = the merged PR head, `mergeSha`, `handoffSeq`, and after a carry `handedHead` + `carrySeq`); PM is told to `ledger verify` once production follows main |

Every other outcome gives the card to PM through `scheduler-fallback-manual` (workflow → manual, one notice):

- at handoff: PR not open, or PR head ≠ ledger head (nothing is recorded);
- after handoff: PR `CLOSED` unmerged; PR head moved by anything but a pure "merge main in" (open or merged at that head);
- a merge intent left over from before the switch (it is never driven: see below);
- no PR / head on the card.

A PR that cannot be read, a carry check whose git step fails, or a PR reported merged without its merge commit holds the card for
the pass and is read again next pass; nothing is written.

**File locks** (LCK-1). Right after the handoff record the card's file locks shrink to the PR's changed files (`git diff --name-only
--no-renames origin/main...<head>` in the project's clone, same origin check as a carry) that its `fileGlobs` cover — one
`merge_handoff_narrow` event per handoff (`narrowHandoffLocks` in `lib/scheduler-merge-handoff.ts`). Anything uncertain (no repoDir, foreign origin, git
failure, a path the scheduler cannot name, a list that may be truncated, an open intent) keeps the locks whole. A carry leaves them as
they are; back in `fix`, the fix dispatch takes the full `fileGlobs` again. Landing on `live` releases them in the same transaction, and
each tick sweeps any finished card still holding card locks with no open intent.

## Following the owner's update-branch (HOF1)

The owner merges main into nearly every PR right before merging it, so the head almost always moves after the handoff. The PR
read (`ghPrState`, `lib/scheduler-merge-handoff-tick.ts`) is told which head the handoff follows; when GitHub shows another one,
it checks in the project's `repoDir` (scheduler.json) whether the move only merged main in (`lib/scheduler-main-merge-carry.ts`,
the handoff's own check; see the end of this list for why it is not the local driver's):

- the new head has exactly two parents: the followed head and a commit already on main — while the PR is open, `origin/main`;
  once merged, main as it was before that merge (`<merge commit>^1`), since the main that now holds the PR would vouch for any
  commit the PR brought in;
- only main came in, proved one of two ways (`basis`):
  - `auto-merge` — the new head's tree is exactly git's own clean merge of the followed head and the main parent
    (`git merge-tree --write-tree`): nothing was added in the merge commit, even when main and the PR changed the same file;
  - `net-diff` — otherwise (a conflict, or this git cannot merge-tree), the net diffs `git diff <main parent>...<followed head>`
    and `git diff <main parent>...<new head>` (every knob pinned; `--ignore-submodules=none --no-relative` so neither a
    `.gitmodules` `ignore` nor `diff.relative` can leave a path out, `--submodule=short` and the `--raw --no-abbrev` records
    ahead of the patch so `diff.submodule=log` cannot print two gitlinks alike) must be byte-identical. Each starts at its own merge base,
    so this only holds when main did not touch what the PR changed; a resolved conflict therefore goes to PM;
- `repoDir`'s configured origin (`remote.origin.url` as written) is the PR repository on `github.com` itself — scp form,
  `https://` or `ssh://`, exact host, no port; anything else is refused before the fetch.

The local merge driver and review keep their own gate, `lib/review-main-carry-proof.ts` (net diff against the current main),
untouched by this. The handoff cannot use it: after the owner's merge, current main already holds the PR, and it has no
auto-merge test for main touching a file the PR changed.

Pass → `merge_handoff_carry` (`from`, `to`, `mainParent`, `mainHead`, `diffHash` = sha256 of the new head's net diff, `basis`,
`handoffSeq`), written by the scheduler only and checked in its transaction to start at the head followed now; the card stays
in `merge`, keeps its reviewed `headSHA` (the review proof binds to it) and is not reviewed again here. Each hop is judged from the head followed so far, so several update-
branches chain on the ledger; two hops between reads, a merge that brought in more than main, a parent off main, a diff too
large to compare or a project without `repoDir` go to PM as before.

The owner's own approval of the new head is not read: merging is that approval, and GitHub reviews / checks would not say
whether this machine's review still covers the PR — the merge check does.

## The local merge paths a handoff project never reaches

- **Merge intent**: the auto tick never plans one (`driveHandoff` replaces it); an open one is escalated, not queued.
- **Merge driver** (`mergeTick` in `scheduler-service.ts`: begin / update-branch / CI rerun / merge): skips the project.
- **Merge train** and **slot reclaim** (`scheduler-pass.ts`): only get the local-merge projects.
- **Deploy**: refused in config together with `mergeHandoff`.

Tests pin each of these and the unchanged local path side by side: `tests/scheduler-merge-handoff.test.ts` (auto tick,
ledger command, config), `tests/scheduler-merge-handoff-pass.test.ts` (the real `schedulerPass` with fake GitHub) and
`tests/scheduler-merge-handoff-carry.test.ts` (following update-branch; the carry check on real git, before and after the merge).

## Evidence (`data.evidence`, `HandoffEvidence` in `lib/scheduler-merge-handoff.ts`)

| Field | Meaning |
|---|---|
| `v` | schema version, `1`. A changed meaning bumps it; new kinds of proof are new keys, never a reused name |
| `pr` | full GitHub PR URL |
| `head` | the pinned head: at handoff the PR head, the card's head and the reviewed head are this commit (later PR heads: `merge_handoff_carry`) |
| `specRev` | spec version the review was done against |
| `template` | workflow template (`code` / `ui` / `security`) |
| `authorFamily` | model family that wrote the head (`claude` / `codex`; a peer's delivery counts as its family) |
| `review.round` | the card's adversarial review round that passed |
| `review.verdict` | `pass` or `changes` (changes with P2 only) |
| `review.reviewerFamily` | the reviewer session's family — always the other one |
| `review.reportPath` | the review report as recorded on the ledger (a local path) |
| `review.p2` | P2 findings left open (P0 / P1 are 0 by the gate) |
| `review.reviewSeq` | ledger event number of that verdict |

Room left for the cross-instance agreement (互认): proof from other sources goes next to `review` (`ci`, `uiApproval`,
`peerAck` …). How the evidence reaches the owner's side is not part of this card: today it lives in this ledger and the PM
notice; the peer PR intake protocol (`peer-pr-auto.md`) is untouched.
