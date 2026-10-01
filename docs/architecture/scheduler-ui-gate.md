# UI card screenshot gate

A `ui` template card cannot merge until someone has looked at its before / after screenshots (`extra.screenshots` ≥ 2 image
paths, `extra.screenshotsDigest` = their sha256). Who looks depends on the card.

| Card | Who accepts | How |
|------|-------------|-----|
| default | the card's PM | `ledger ui-approve <task> --head <sha> --digest <digest> [--text]` / `ledger ui-reject <task> --text <意见>` |
| `ownerVisual` (global palette, theme tokens, redesign) | the owner | the scheduler's screenshot ask (`scheduler_ui_screenshot`), answered with the authenticated owner mark |

Code: `src/lib/scheduler-ui-gate.ts` (projection, planner step, merge-write check, PM notice), `src/lib/ledger-ui-approve.ts`
(writes), `src/lib/ledger-ui-approve-verdict.ts` (PM's verdict read back + the fix order it makes), `src/manager/ledger-ui-cmds.ts` (CLI). Tests: `tests/scheduler-ui-pm-gate.test.ts`, `tests/scheduler-ui-owner-visual.test.ts`.

## Flow after a passing review

1. Default card: the planner emits an `ask` intent carrying `pmNotice`; the service sends PM the image paths, the digest and both
   commands (`notifyPm`), then settles the intent `done`; both receipts carry `；digest=<digest>`. A failed send leaves it pending
   for the next pass; a notice left `submitted` (sent, done write lost) is settled on the next pass without a second send. The
   card waits on `pm_screenshot` only while the done notice matches the card's head and digest: new screenshots after the same
   pass get a new notice. No owner ask is opened.
2. `ui-approve` → the planner moves review → merge. `ui-reject` → review → fix; the fix order's single P1 finding is PM's text,
   both in the planner's full-text order and in the order `take_order` returns (`order-take.ts` → `uiRejectFixFor`).
3. `ownerVisual` card: unchanged owner path — the ask is opened, `owner_screenshot` waits, an expired ask goes to PM, a guest or
   unauthenticated answer escalates `ui_unverified`. PM's `ui-approve` is refused and any PM approval event is ignored.

## Binding and who may write

- A PM verdict is a `decision` event `{op: ui_approved | ui_rejected, head, specRev, round, screenshotsDigest, note?}`. It counts
  only while all four equal the card's current values; a new head, round, spec revision or screenshot set needs a new verdict.
- Writers: a manager other than the team dispatcher (`actorMayConfigure`). The gate re-checks the event's actor on read, so an
  event that got past the CLI by another path still does not count.
- The merge write (`requireReviewedMerge` → `uiMergeRefusal`) re-reads the ledger inside its transaction: an owner-answered
  scheduler ask bound to the card, or — only when the card is not `ownerVisual` — a bound PM approval.

## ownerVisual

- Lives only in `extra.ownerVisual`. Set by the spec head line `owner 看截图：是` (autostart claim `--owner-visual`), by a
  manager's `task-new` / `task-set --extra`, or by `ledger ui-owner-visual <task> on|off` (which writes the same field).
- Read from the task writes that name the key (`ownerVisualOf`): an extra rewritten for other fields without `ownerVisual`
  leaves it unchanged, so turning it off takes `ownerVisual: false` or `ui-owner-visual off`. Writes by the scheduler identity
  or a manager decide; anyone else's can only turn it on, never off.

## Compatibility

An owner screenshot ask opened before PM acceptance existed still releases the card when the owner approves it, on any UI card.
Nothing is migrated.
