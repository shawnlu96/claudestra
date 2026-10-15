# Self-heal before manual (SELFHEAL1)

Before the scheduler hands a card back to PM for three recurring reasons, it first tries to fix the situation itself, once.
Switch: recovery key `selfHealBeforeManual` (`src/lib/recovery-keys.ts`). Rollback: `scheduler-recovery ... off --key selfHealBeforeManual`.

| Mode | Behaviour |
|------|-----------|
| off | every path below is byte-for-byte the old one |
| observe | the old escalation / notice still happens; a sample says what would have been done (「本会自救：…」) |
| on | the self-heal runs; every attempt leaves a sample (stage event text, `scheduler-recovery-observe` note or journal row) |

Manual cards never self-heal: the planner returns `wait manual` first, the auto tick only walks auto cards, and a card PM switches
to manual mid-heal stops on its next pass.

## 1. No P1 in fix → re-review (`src/lib/scheduler-fix-selfheal.ts`)

`fixPackage` (`scheduler-plan.ts`) used to escalate `fix_report` when the fix stage had no complete previous report, or no P1 left
after convergence. Both now pass through `fixSelfHeal`. Under `on`, when every check holds, the planner emits one `stage` intent
fix→review; the stage event's text says `无 P1 自动回审`, the head and the report it relied on.

Checks (any failing = the old `fix_report`):

- workflow `auto`; card in `fix` with a full head;
- the card's head equals the head of the latest review verdict, and that verdict (if it is this round's) carries no P1;
- no delivery since the card entered fix; the round and spec revision are the ones it entered fix with;
- this head was never self-healed before (a fix→review stage event naming it) — one re-review per head, the second time escalates.

The move goes through `applySchedulerStage` (`ENGINE_MOVES` gained `fix>review`, used by this plan only; the apply re-plans and
must get the same intent, and no other planner path sets `targetStage: "review"`). `nextTaskState` adds a round as for any entry
into review, so the next pass dispatches a fresh review of the same head through the ordinary `reviewDispatch`; the previous round's
report is never reused as this round's verdict. The planner stays pure: the "already healed" fact is read from snapshot events,
the switch from the recovery policy (as `nearMarker` does).

## 2. Review head not fetched → retry later (`src/lib/scheduler-head-refetch*.ts`)

- `fetchHeadVia` is the one bounded fetch (`boundedGit` timeout, no prompt), shared by `prepareReviewHead` (lend cards) and
  `peerPrHeadMissing`, which now fetches `refs/pull/<n>/head` once before declaring the head missing (`pinReview` hands it `env.net`).
- Still missing: the auto tick (`scheduler-auto-tick.ts`, reviewer creation and review pin) has already cancelled the intent; under
  `on` it records an attempt note (`scheduler-recovery-observe`, key card + head + attempt) and the card waits instead of escalating.
  `headRefetchHold` (asked via `peerPrHold` before planning) holds a review-stage card 1, 2, 4, 8 … minutes after its latest miss,
  at most 30. Six hours after the head's first miss the old escalation goes out, saying so. State is only ledger notes: a restart
  keeps the rhythm, a new head starts afresh. Other refusals (dirty checkout, wrong head …) escalate as before.

## 3. Lend notices once per card + head (`src/lib/lend-notice.ts`)

Start / delivered / stopped notices to the lending owner are additionally keyed peer + repo + card + head + kind in the lend
journal's `lend_meta` (durable), written only after a notice was delivered. Under `on` a re-lend of the same card at the same head
does not notify again (the order still records the notice as told); a new head notifies as usual. `observe` notifies and logs the
skip it would make. peer-pr-notice's `pushDedupKey` is untouched.

## Not here

Peer PR maxRounds arbitration (spec item 3) was split out to its own card: `peer-pr-observe.ts` still falls back at maxRounds.
