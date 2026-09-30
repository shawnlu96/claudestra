# Orchestration team

**English** · [简体中文](./orchestration-team.md)

With many agents on one project, a single PM catching every message by hand will drop things. The orchestration team hands "who picks up next" to the ledger. Executors only deliver. The bridge sees the delivery in the ledger and notifies whoever should pick it up. Every step is written back to the ledger, so you can always see who is holding a task right now.

## Roles

| Role | Does | Does not |
|---|---|---|
| **PM** | Writes spec cards, dispatches work, approves restatements, runs the serial merge / deploy queue, asks the owner for decisions | Write large features; confirm on the owner's behalf |
| **Dispatcher** (optional) | Catches deliveries: dispatches reviewers, files verdicts, records them in the ledger, decides when to escalate | Merge, deploy, talk to the owner directly, create executors |
| **Reviewer** / **Adversarial reviewer** | Read-only review of one worktree; verdict as P0 / P1 / P2 | Change code, touch production |
| **Executor** | Implements, tests and delivers the spec card in its own worktree | Merge, deploy, touch files outside the spec's scope |

The role texts live in [`roles/`](../../roles). At launch, an agent's `role` field in the registry decides what gets injected:

- **Dispatcher**: `--agents` plus `--agent claudestra-dispatcher`, so the main thread *is* the role. Both reviewer types are defined alongside it, so it can dispatch them directly.
- **PM**: its role text is appended with `--append-system-prompt-file`, and `--agents` carries both reviewer types so the PM can dispatch reviews itself when there is no dispatcher.
- **Executor**: its role text is appended with `--append-system-prompt-file`.
- Verified live: with `--agent` as the main thread, Claude Code's default tools, the project's CLAUDE.md and Claudestra's channel tools are all still available.
- Nothing is installed into `~/.claude/agents`. Your global directory is left alone, there is nothing to install on a new machine or project, and a repo update takes effect on the next launch.
- Role injection only applies to the Claude Code runtime. For Codex or Pi executors, the PM states the rules in the first dispatch message.

## Setting it up

```bash
# Run inside the PM's own session (or pass --pm <agent> from a terminal)
bun src/manager.ts team up --project <id>                  # PM + audit only
bun src/manager.ts team up --project <id> --dispatcher     # also create a dispatcher <id>-dispatch
bun src/manager.ts team up --project <id> --dispatcher-agent <existing agent>   # use an existing agent as dispatcher
```

Only the project's PMs (not the dispatcher), the master and the owner may propose `team up` / `team down`; executors and the dispatcher may not. `team up --no-dispatcher` drops the current dispatcher; without any dispatcher flag the current one is kept. `team up` **changes nothing by itself**. It creates a proposal, and the bridge renders a card from that proposal with Confirm / Reject buttons in the proposer's channel (the control channel when proposed from a terminal). Changing the PM list requires the owner, so the owner has to click Confirm themselves:

- **Discord**: the click only counts if the user is in `ALLOWED_USER_IDS`.
- **Web**: the click only counts from the owner's own device credential. Bearer tokens from `token-add`, guest devices and peers are all refused.
- The button id carries a check code computed with a key that exists only in the bridge's memory, bound to the proposal content and the channel it was posted in. Agents cannot compute it, and they cannot post such buttons at all: every id the bridge handles itself (team confirmations, admin panels, permission prompts and so on) is on a reserved list (`src/lib/reserved-buttons.ts`), and a message from an agent, a local script or a peer that carries a reserved id is refused as a whole. On Discord the click must also land on the message the bridge posted. After a bridge restart old cards are void; propose again.
- The buttons expire after 30 minutes and can only take effect once. A proposal edited after it was posted is void.
- The CLI has no "confirm" subcommand.

When the owner clicks Confirm, the bridge first marks the proposal as confirmed, then runs these steps in order. It stops at the first failure and `team status` shows where it stopped:

1. `ledger team-apply <proposal id> --check`: checks without writing, so a stale proposal stops before anything is created.
2. Create the dispatcher, if a new one was requested, with role `dispatcher`.
3. Run `ledger team-apply <proposal id>` to write the ledger. The command checks: the bridge marked the proposal confirmed, the content hash still matches, the confirmation came before expiry (and no more than 10 minutes ago), and **the PM list and team config are still what they were when the proposal was made** (if another proposal took effect first or the team was taken down, the old proposal is void instead of overwriting the list with stale data). Only then does it write the PM list and the team config (`meta.team`; event routing starts from this point) and record an owner decision, all in one transaction. The bridge itself stays read-only on the ledger.
4. Set or clear registry roles as listed on the card: the dispatcher gets dispatcher, everyone else on the list gets pm, and anyone removed from the list (or everyone, when the team is taken down) loses the role. Roles take effect on the next restart; nothing restarts automatically.

**Changing the PM list works the same way**: `ledger meta --pms a,b` writes nothing directly. It creates a proposal and posts the buttons (a PM, the master or the owner may propose; executors and the dispatcher may not). The active dispatcher cannot be dropped from the list this way; use `team up` to replace it or `team down` to end the team. The same applies when the owner runs it from a terminal: click Confirm once in the UI. There is no CLI switch for the team config; use `team up` / `team down`.

To take the team down: `team down --project <id>`, also confirmed by the owner. Routing stops, and the dispatcher leaves the PM list and loses its role. The agent itself is not deleted; `kill` it yourself if you want it gone.

**On "agents cannot impersonate the owner"**: this is a product constraint, not a security boundary. Every agent runs as your user with permission checks bypassed by default, so a determined agent could edit the state files or the ledger database directly, or pair a device for itself (the loopback `/api/v1/devices/local` now needs `BRIDGE_CONTROL_TOKEN` or approval from a paired device in the web app before it signs full access, but an agent can read `.env` or run `claudestra pair` and redeem the code itself, so this only stops a casual curl). The "confirmed" mark lives in the proposal file in the state directory, so a process running as the same user can forge it too. What the cards and buttons guarantee **holds only at the tool level**: for an agent that only uses the tools Claudestra gives it (reply, send_to_agent, edit_message, buttons, ledger commands), executors and the dispatcher cannot propose a team change; bridge admin button ids (team confirm, permission prompts, auto-allow, model switch and so on, see `src/lib/reserved-buttons.ts`) cannot be sent at all; edit_message only edits the caller's own reply messages, and nobody can edit a message that carries admin buttons. So at the tool level, what the owner clicks is the card the bridge rendered from the proposal, unchanged since.

This is not an absolute guarantee. An agent is a shell running as your user: it can read the repo's `.env`, and its session environment already carries `DISCORD_BOT_TOKEN`. With the bot token it can bypass the bridge and call Discord directly, posting messages with any button id as the bot or editing existing ones. Like editing the state files or pairing a device above, that is the "determined agent" case and outside what this protects (same stance as the Security posture in CLAUDE.md: a guard rail, not a security boundary). Apart from `ledger import` (the owner's one-time migration, which only writes an empty list), every PM-list change in the ledger traces back to the proposal the owner clicked.

## How a task flows

```
executor: ledger deliver ─▶ bridge notifies the dispatcher (or the PM if there is none)
                             │  ledger dispatch <T>: check head, record the dispatch, print the reviewer prompt
                             ▼
                          reviewer (read-only) ─▶ dispatcher files reviews/<T>-r<N>.md, then runs ledger review
                             │
     ┌───────────────────────┼─────────────────────────────┐
 moved to fix → executor      moved to merge → PM "ready to merge"      P0, or round ≥ 3 still failing → auto-escalated to PM
```

- Executors only run `ledger deliver`. `routed: true` in its output means the bridge will notify whoever picks it up next; the executor sends no message.
- `ledger dispatch <T>` first checks that the executor's worktree HEAD is the head recorded at delivery, and only then dispatches. If the spec card's review line says "adversarial final round", it switches to the adversarial reviewer once the previous round had no P0 / P1. The adversarial verdict goes to `reviews/<T>-r<N>-adv.md`, so it never overwrites the regular verdict of the same round. When the regular round passes, the bridge does not tell the PM "ready to merge"; it reminds the dispatcher to dispatch the adversarial round.
- Entering merge goes through a gate, whether by `review --to merge`, a manual PM `stage review → merge`, or unblocking back to merge. If the spec card asks for an adversarial round, the current round and the current head need an adversarial pass or a PM `--waive adversarial`. The policy is the stricter of the spec card and the policies recorded at dispatch, so loosening the card after a dispatch does not count. A card loosened before the first dispatch leaves nothing to compare against, and the gate follows the loosened card; that is why edits to the review line go through the PM. Once a task is in merge or later (including blocked entered from those stages), anyone who wants a different head must first have the PM move it back to review. Filling in the PR or branch, or writing the same head, still goes through. If a task blocked from merge is stopped by the gate on its way back, the PM can move it straight back to review, which works like merge → review (round + 1).
- Text written by the executor (delivery notes, escalation reasons) appears in notices and reviewer prompts only as a single-line quote marked with its author, and evidence and verdict files must be plain file paths (full-width punctuation, 【】「」, whitespace and invisible characters are refused on write) that are also shown inside a quote box. The party under review cannot use that text to instruct the reviewer or the PM.
- If a pass is recorded without `ledger dispatch` (say, the PM dispatched a reviewer with a hand-written prompt), the bridge reads the spec card's review line to decide whether an adversarial round is still due, the same source `review-pack` uses. If the spec card cannot be found either, the task goes to the dispatcher to check instead of being reported as finished.
- `ledger review-pack <T>` is the read-only version: it prints the prompt and records nothing.
- `ledger escalate <T> --reason …` escalates to the PM. Add `--to owner` when the owner has to decide; the PM still does the asking.
- Two hard rules are fixed in code: a review with a P0, or a task still failing at round 3. When the bridge sees such a verdict it records an escalation with `ledger escalate --auto` (under the actor `bridge-rule`, once per verdict), and the PM then gets an [escalation] notice. This automatic escalation is a copy to the PM; it does not change who is holding the task. Any other escalation is up to the dispatcher or the PM.

**Notify once**: the bridge saves how far it has processed (the ledger event seq) in `team-router.json` under the state directory, and it saves that *before* sending. So a bridge restart never re-sends. A crash between the two steps drops the notices of that batch not yet sent (they are never re-sent); a single failed delivery only affects that notice, which goes to the held queue. If something was lost, check `team status` and send a line by hand; to replay a range, stop the bridge, set the seq in `team-router.json` back, and start it again. If the recipient is busy or offline, the notice waits in the held queue until its turn ends; it never interrupts. Events from before the team was set up are not replayed.

## Moving over from the manual process

Once a project's team is on (`team up` confirmed by the owner), steps that used to be relayed by hand are done by the ledger and the bridge. Doing them by hand as well sends everything twice:

- **Executors** only run `ledger deliver` and no longer send the PM a delivery message (that is what `routed: true` in the output means).
- **The dispatcher** is done once `ledger review` is recorded; it no longer forwards the verdict to the executor or the PM.
- **Escalation**: a P0 and a task still failing at round 3 are escalated by the bridge automatically; otherwise use `ledger escalate` only when a person has to decide.
- Projects without a team work as before: after `deliver`, the executor still sends the PM a one-shot message.

## Checking and taking over

```bash
bun src/manager.ts team status --project <id>
```

It lists the PM list, the dispatcher, and for each open task **who is holding it and since when**, plus pending or recently closed proposals. With more than 5 executors and no dispatcher, it also suggests turning one on.

"Who is holding it" is computed from the ledger (`currentHandler` in `src/lib/ledger-handler.ts`) rather than stored separately. The collaboration view and the audit both use it.

**Taking over**:

- **New PM**: `team up --pm <new PM>` (the active dispatcher is kept by default). Once the owner confirms, the new PM gets the role on its next restart. Make sure the old PM has stopped first, so two PMs never write the ledger at once. The old PM stays on the PM list; to remove it, propose a new list with `ledger meta --pms` and have the owner confirm it in the UI.
- **Dispatcher died**: `manager restart <dispatcher>`. The role comes back from the registry, and deliveries that arrived in the meantime are waiting in the held queue.
- **No dispatcher any more**: `team down`, or `team up --no-dispatcher`. Deliveries then go to the PM.

## Related

- Handing a task to an agent on another Claudestra instance: [cross-instance delegation](./peer-delegation.md) (Chinese)
- Code: `src/manager/ledger-team-cmds.ts` (team-apply), `roles/`, `src/lib/team-*.ts`, `src/lib/ledger-handler.ts`, `src/lib/review-pack.ts`, `src/bridge/team-router.ts`, `src/bridge/team-confirm.ts`, `src/manager/team-up.ts`, `src/manager/ledger-dispatch-cmds.ts`
