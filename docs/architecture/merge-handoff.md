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
failure, a path the scheduler cannot name, a list that may be truncated, an open intent) keeps the locks whole. A failed read or a busy ledger is tried again on
later polls; a reason no retry changes is recorded once (`skipped`) and the PR's files are no longer read for that handoff. A carry leaves them as
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

## The owner's review pushes (RRL-1)

The owner's scheduler reviews a handed-over PR too and pushes the result to our PM as a plain message (`renderReviewPush`,
or its redelivery). With `"handoffPeer": "<peers.json name>"` on the project, those pushes are booked by the scheduler
instead of starting a PM turn:

| Step | Where | What |
|---|---|---|
| Intake | `bridge/remote-review-intake.ts` (hook in `api-routes.ts` messages route) | Taken only if the peer token's peer is `handoffPeer`, the text parses strictly and the read-only ledger has exactly one card with that PR number whose PM is the addressee. Raw text → `ledger/remote-review-inbox/`, one mirror line, 202. The same report id + head already booked or still waiting → 202 `duplicate: true`, nothing stashed. An `ambiguous` (old-format redelivered) P1 is never taken: every copy is delivered to PM as before (a retry after a failed delivery too); the first is also stashed for the record. Anything else (or any error) → delivered to PM as before. |
| Parse | `lib/remote-review-parse.ts` | Round trip: parsed fields are rendered again with the same render code and must equal the text byte for byte; ≤ 64 KiB. The reply-to line is never read; the report is kept whole as data. A redelivery (`renderRedeliveryPush`) replaces the next step with 现状; a P1 keeps a cap line (`CAP_MARK`) so it reads as the original. The old format without it still parses; a P1 in it is `ambiguous`. |
| Book | `remote-review-tick.ts` → `ledger scheduler-remote-review <card> --inbox <file>` | Re-reads and re-checks everything, then in one transaction: report copy `ledger/reviews/<card>-remote-PR<n>-r<r>.md` (sanitised, every line quoted), one `remote_review` event (parsed fields only; dedup = report id + head12, so a resend is a duplicate). |
| Head | `remoteHeadMatch` | Counts only as a prefix of the card's head (in merge also of the head the handoff follows); otherwise `matched: false`, no effect yet. When the card later reaches that head the tick applies it once (`--apply`, a `remote_review_applied` event, same actions); Only the current word on a head acts (`remoteCurrentAt`: highest round, later on a tie); an outranked booking — at intake or before a late apply, rechecked inside the write — is marked `supersededBy` and never runs its action. P1 consumers use `remoteP1At` (the current word when it is a P1 to fix). A stale review never applies. |
| Act | `recordRemoteReview` / `applyLateRemote` | P0 / P1 with the owner's rounds used up → an auto card goes manual + one PM notice (report path); P1 on a non-auto card → one short notice; an `ambiguous` P1 (`capUnknown`) → booked only (PM already has it), the card is not touched and `remoteP1At` leaves it out; P1 on an auto card → left to the bounce step; pass → event only. Notices are sent by the tick and marked (`--notified`). |

A refused inbox file moves to `remote-review-inbox/failed/` and PM is told where it is. Tests: `tests/remote-review-intake-*.test.ts`.

Known limits of the booking: an old-format redelivered P1 (no cap mark) cannot tell whether the owner's rounds are used up, so it
always goes to PM through the normal delivery, is only booked and never changes the card; when the sender retries a failed delivery,
PM may see the same raw text a few times (it is never booked twice, never moves the card, never raises an owner card). Once both
sides run the cap-marked format, old-format pushes no longer occur.

## The owner's P1 sends the card back to fix (RRL-2)

| Card | What happens |
|---|---|
| auto, in `merge` (before or after the handoff) | `driveHandoff` first asks `pendingRemoteBounce` (`lib/remote-review-bounce.ts`): the current owner word, when it is a P1 (`remoteP1At`) not bounced yet, on the head the handoff follows once handed over (after a carry the card's own head is an old PR head: a late review of it never acts), or on the card's head before. Then `ledger scheduler-merge-handoff <task> --head --pr --remote-bounce <seq>` moves merge → fix in one transaction: a stage event whose `mergeBounce` is `{cause: "remote_review", prHead, remote: {seq, reportId, reportPath, p1}}` and one `remote_bounce` event (dedup per booking, so a replay is a duplicate). PM gets one info-level line. |
| — the head was written by a lender, or this would be the owner's 4th bounce | no bounce: the card goes manual (`scheduler-fallback-manual`) with one PM notice naming the report path. Owner bounces are counted on their own (stage events), apart from the merge queue's `merge_conflict` count. |
| in `fix` after such a bounce | the planner's bounce package carries it, so the dispatch and `take_order` name the report and P1 count; acceptance: fix each P1 in the report, push to this PR branch, deliver the new head. Not a review P1: no findingIds, so it never counts toward P1 streaks or fix_swap. |
| in `review` after that fix | the review order gets one line: targeted re-review of whether the owner's report's P1 are fixed. Passing goes to `merge` and hands over again (a new `merge_handoff` record for the new stay). |
| in `build` / `fix` otherwise (incl. a local review P1, a manual card PM moved to fix, or a fix already in a conflict / CI / older remote bounce) | the order carries the current owner report on the card's head (`remoteFixWork`, `lib/remote-review-current.ts`) after whatever it already has; the report a remote bounce already names is not repeated. Local review P1 + owner P1 = both reports. |
| in `review` with a local pass | nothing until `merge`, where the row above bounces it before any handoff. |
| manual | the booking's one short PM notice (card + report path, no report text); once PM moves it to fix, `take_order` carries the report. |

P0 and a P1 at the owner's cap are handled at booking (above). A pass changes nothing: the handoff waits for the owner as before, and a
ui card still needs PM's screenshot approval at handoff (`uiMergeRefusal`). Known limit: a report booked for the same head while the
card is already in fix only shows up in the next `take_order`; a lent fix order names the local report path only, so a lender
gets no report text (left to a later card). Tests: `tests/remote-review-bounce.test.ts`.

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
