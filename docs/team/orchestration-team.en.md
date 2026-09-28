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

`team up` **changes nothing by itself**. It creates a proposal and posts Confirm / Reject buttons in the PM's channel. Changing the PM list requires the owner, so the owner has to click Confirm themselves:

- **Discord**: the click only counts if the user is in `ALLOWED_USER_IDS`.
- **Web**: the click only counts from the owner's own device credential. Bearer tokens from `token-add`, guest devices and peers are all refused.
- The buttons expire after 30 minutes and can only take effect once. They carry a hash of the proposal, so a proposal edited after it was posted is void.
- The CLI has no "confirm" subcommand.

After the owner confirms, the bridge runs these steps in order. It stops at the first failure and `team status` shows where it stopped:

1. Create the dispatcher, if a new one was requested, with role `dispatcher`.
2. Set the PM's role to `pm`. **This takes effect on the PM's next restart; the PM is never restarted automatically.**
3. Write the ledger's PM list and team config (`meta.team`). Event routing starts from this point.
4. Record an owner decision in the ledger.

To take the team down: `team down --project <id>`, also confirmed by the owner. Routing stops, and the dispatcher leaves the PM list and loses its role. The agent itself is not deleted; `kill` it yourself if you want it gone.

**On "agents cannot impersonate the owner"**: this is a product constraint, not a security boundary. Every agent runs as your user with permission checks bypassed by default, so a determined agent could edit the state files or the ledger database directly, or pair a device for itself. What the buttons do guarantee: an agent using the normal tools cannot make itself PM, and every PM-list change in the ledger traces back to the proposal the owner clicked.

## How a task flows

```
executor: ledger deliver ─▶ bridge notifies the dispatcher (or the PM if there is none)
                             │  ledger dispatch <T>: check head, record the dispatch, print the reviewer prompt
                             ▼
                          reviewer (read-only) ─▶ dispatcher files reviews/<T>-r<N>.md, then runs ledger review
                             │
     ┌───────────────────────┼─────────────────────────────┐
 moved to fix → executor      moved to merge → PM "ready to merge"      P0, or round ≥ 3 still failing → extra [escalation] to PM
```

- Executors only run `ledger deliver`. `routed: true` in its output means the bridge will notify whoever picks it up next; the executor sends no message.
- `ledger dispatch <T>` first checks that the executor's worktree HEAD is the head recorded at delivery, and only then dispatches. If the spec card's review line says "adversarial final round", it switches to the adversarial reviewer once the previous round had no P0 / P1.
- `ledger review-pack <T>` is the read-only version: it prints the prompt and records nothing.
- `ledger escalate <T> --reason …` escalates to the PM. Add `--to owner` when the owner has to decide; the PM still does the asking.

**Notify once**: the bridge saves how far it has processed (the ledger event seq) in `team-router.json` under the state directory, and it saves that *before* sending. So a bridge restart never re-sends. A crash between the two steps can drop at most one notice, and the audit catches that. If the recipient is busy or offline, the notice waits in the held queue until its turn ends; it never interrupts. Events from before the team was set up are not replayed.

## Checking and taking over

```bash
bun src/manager.ts team status --project <id>
```

It lists the PM list, the dispatcher, and for each open task **who is holding it and since when**, plus pending or recently closed proposals. With more than 5 executors and no dispatcher, it also suggests turning one on.

"Who is holding it" is computed from the ledger (`currentHandler` in `src/lib/ledger-handler.ts`) rather than stored separately. The collaboration view and the audit both use it.

**Taking over**:

- **New PM**: `team up --pm <new PM>`. Once the owner confirms, the new PM gets the role on its next restart. Make sure the old PM has stopped first, so two PMs never write the ledger at once. The old PM stays on the PM list; to remove it, the owner edits the list from a terminal with `ledger meta --pms`.
- **Dispatcher died**: `manager restart <dispatcher>`. The role comes back from the registry, and deliveries that arrived in the meantime are waiting in the held queue.
- **No dispatcher any more**: `team down`, or run `team up` again without `--dispatcher`. Deliveries then go to the PM.

## Related

- Code: `roles/`, `src/lib/team-*.ts`, `src/lib/ledger-handler.ts`, `src/lib/review-pack.ts`, `src/bridge/team-router.ts`, `src/bridge/team-confirm.ts`, `src/manager/team-up.ts`, `src/manager/ledger-dispatch-cmds.ts`
