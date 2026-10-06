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
| PR `MERGED` at the handed head | `… --merged <merge commit>` | `merge → live` (stage event carries `head`, `mergeSha`, `handoffSeq`); PM is told to `ledger verify` once production follows main |

Every other outcome gives the card to PM through `scheduler-fallback-manual` (workflow → manual, one notice):

- at handoff: PR not open, or PR head ≠ ledger head (nothing is recorded);
- after handoff: PR `CLOSED` unmerged; PR head moved (open or merged at another head — the evidence covers only the handed head);
- a merge intent left over from before the switch (it is never driven: see below);
- no PR / head on the card.

A PR that cannot be read holds the card for the pass and is read again next pass; nothing is written.

## The local merge paths a handoff project never reaches

- **Merge intent**: the auto tick never plans one (`driveHandoff` replaces it); an open one is escalated, not queued.
- **Merge driver** (`mergeTick` in `scheduler-service.ts`: begin / update-branch / CI rerun / merge): skips the project.
- **Merge train** and **slot reclaim** (`scheduler-pass.ts`): only get the local-merge projects.
- **Deploy**: refused in config together with `mergeHandoff`.

Tests pin each of these and the unchanged local path side by side: `tests/scheduler-merge-handoff.test.ts` (auto tick,
ledger command, config) and `tests/scheduler-merge-handoff-pass.test.ts` (the real `schedulerPass` with fake GitHub).

## Evidence (`data.evidence`, `HandoffEvidence` in `lib/scheduler-merge-handoff.ts`)

| Field | Meaning |
|---|---|
| `v` | schema version, `1`. A changed meaning bumps it; new kinds of proof are new keys, never a reused name |
| `pr` | full GitHub PR URL |
| `head` | the pinned head: at handoff the PR head, the card's head and the reviewed head are this commit |
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
