# Card retirement (scheduler)

Once a card is finished, the scheduler service collects what it created for it — the per-card sessions and worktrees — so PM
no longer kills agents and removes worktrees by hand. Code: `src/lib/scheduler-retire.ts` (steps),
`beginRetire` in `src/lib/scheduler-sessions.ts` (the intent), `src/lib/scheduler-retire-deps.ts` (production wiring); tests in
`tests/scheduler-retire.test.ts`.

## When

Every service pass with `autoDispatch: true`, right after the auto tick (`scheduler-pass.ts`), as a phase of its own
(`pace.phase()`: a slow auto tick or autostart cannot spend its share of the budget), for cards of the projects
`scheduler.json` lists, **whatever their workflow mode** — most finished cards were switched to manual on the way, and their
scheduler-bound sessions still need collecting. A card is picked when:

- its stage is `verified`, `done` or `cancelled` (`RETIRE_STAGES`); spec / restate / build / review / fix / merge / live /
  blocked cards are never touched, and the ledger refuses a retire intent for them;
- it still has a `scheduler_sessions` row that is not `retired`, or a claimed (`submitted`) retire intent to finish;
- it has no other open intent (a stuck review / merge intent waits for PM first) — except on a **cancelled** card, whose
  pending / submitted dispatch / review / ask intents nothing drives any more: the tick settles them `cancelled` first.
  Merge-queue intents (`merge`, `verify`) and any `unknown` intent still make it wait.

At most 5 cards per pass (`RETIRE_CARDS_PER_PASS`), taken in rotation after the card the last pass stopped at
(`pace.cursor.retire`), so cards held every pass (a busy kill) never keep the rest from their turn.

## What

One `retire` intent per card (`retire:<task>`, opened already claimed by `ledger scheduler-retire <task>`), then:

1. **Sessions** (author, then reviewer). Each effect's receipt is on the ledger before the next runs
   (`ledger scheduler-session-retire`): `active → retiring` (archive) `→ retired` (kill).
   - tmux / acp: `manager archive <agent>`, then `manager kill <agent>`. A failed archive is recorded and kill still runs —
     kill never deletes the session jsonl — and PM is told. Before kill the registry is read: an agent already gone or
     `stopped` is not killed again (that is how a kill whose receipt never reached the ledger looks next pass), and a name
     now running a different session than the bound one is left alone and handed to PM.
   - peer: the worker is on the lender's machine — no command is sent, both receipts just say so.
   - an agent still named / bound on an unfinished card is not killed (receipt says which card).
2. **Worktrees**: `<worktreeRoot>/<task lowercased>` (the executor's, from dag-tools-start) and `<worktreeRoot>/rv-<task>`
   (the reviewer's). Not there → skipped. A live (not `stopped`) agent whose registry cwd is inside it → kept. Must be a linked
   worktree (git-dir ≠ common-dir). `git status --porcelain` empty →
   `git worktree remove <path>` — never `--force`, never `rm`, and git itself refuses a dirty tree.
3. The intent settles `done` with a summary receipt.

## When PM is told

- **A worktree stays** (uncommitted or untracked files, a live agent works in it, unreadable, not a linked worktree, or
  `worktree remove` failed), **an archive failed**, or **a kill was skipped for a changed session**: the intent settles `done`,
  its receipt (an event on the card) says what was left, and PM gets one notice. Nothing is deleted; PM decides.
- **A kill fails** for any reason other than "already gone" or "busy" (`正在 …`, retried next pass): the intent settles
  `unknown` and PM gets one notice. The card is not retried until PM reconciles the intent.

Each card gets one settle event either way. A pass sends the notices as **one combined message per project**, never one per
card, and a card owing PM a notice settles only **after** its project's notice went out. A notice that fails leaves the intent
`submitted`; the next pass rebuilds it from durable state (session receipts, the worktrees on disk) and resends it. After a
settle the card is never picked again, so PM hears once — twice only if the notice went out and the settle write then failed.

## Not done here

Remote branches are not deleted (owner's call). PM's own scratch review folders (`rv-*/.review-tmp` outside the worktree root)
are not touched. Cards without scheduler session rows (never bound by the auto flow) are not picked up.
