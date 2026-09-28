# Ledger audit (T29)

A deterministic, LLM-free check that runs over the built-in ledger every 15 minutes and tells the PM only about things that look dropped. Nothing is fixed automatically; each finding carries one suggested action.

## Pieces

| Piece | File | Role |
|---|---|---|
| Rules | `src/lib/ledger-audit.ts` | `auditLedger(snapshot, now)` — pure; thresholds in `AUDIT_THRESHOLDS` |
| Snapshot | `src/lib/ledger-audit-snapshot.ts`, `ledger-audit-reviewers.ts` | Reads ledger, registry, tmux, session files, subagents, held queue, `ledger.json` |
| Store | `src/lib/ledger-audit-store.ts` | `audit_findings` table (`SCHEMA_AUDIT` migration): open / still open / resolved / reopened, `notifiedAt` dedup |
| CLI | `src/manager/ledger-audit-cmd.ts` | `ledger audit [--project <id>] [--dry-run] [--json]`, `ledger audit --ack <key,key> [--queued <messageId>]` |
| Timer | `src/bridge/ledger-audit-service.ts` | Every 15 min (first run 90 s after start): run the CLI, push pending findings, ack |
| Read side | `src/lib/ledger-read.ts` | `GET /api/v1/ledger/:project` returns `audit` (unresolved findings); SSE `ledger` fires when a finding opens or closes |

The bridge stays a read-only ledger client: the timer calls `ledger audit --json` through `runManager`, and the CLI does all writes. Everything is read from files and tmux, not from bridge memory, so a manual CLI run and the timer see the same thing, and a bridge restart changes nothing.

## Rules and thresholds

| Rule | Fires when | Suggestion | Pushed to |
|---|---|---|---|
| `review_no_reviewer` | Task in `review` for > 20 min (since entering, or the last `note` / `review` event), no reviewer subagent running for it | Dispatch a reviewer | dispatcher, else PM |
| `executor_idle` | Task in `build` / `fix`, executor's main turn not busy, its session file unwritten for > 15 min (and ≥ 15 min in the stage), no `deliver` since entering | Ask the executor | dispatcher, else PM |
| `deliver_not_in_review` | Task in `build` / `fix`, a `deliver` recorded **after** entering that stage > 30 min ago, no `review` event after it (a skipped review `review→merge`, a send-back to `fix`, `blocked` never fire) | Check the stage | dispatcher, else PM |
| `pm_held` | A message to someone on the PM list has been held > 10 min **while that agent is idle**, or was claimed by `check_inbox` > 10 min ago without an ack | `check_inbox` | PM |
| `ship_stalled` | Task in `merge` / `live` > 30 min with no `deploy` / `verify` event since; `merge` is exempt while `meta.queueFrozen` | Deploy / verify, then move the stage | PM |
| `reclaim_executor` | An `agent-task-*` whose tasks are all `done` / `cancelled` for > 30 min still has a tmux window | Kill it | PM |
| `task_agent_missing` | A task in `restate` / `build` / `review` / `fix` names an agent that is not in the registry | Reassign | PM |
| `orphan_executor` | An `agent-task-*` in this project's registry, created > 15 min ago (session-file birth time), has no task in the ledger | Create the task or reclaim | PM |
| `owner_inbox_stale` | An `ownerInbox` entry in the `ledger.json` next to `meta.docsDir` is `doing` / `in_progress` > 30 min after the owner said it | Check progress | PM |

Boundaries are strict: exactly at the threshold does not fire.

- **Stage entry time** comes from the task's stage events. Imported tasks with approximate times (`approxTime`) are never judged on them.
- **Reviewers** are found in the `subagents/` of every agent in the project plus the PM list. A description counts when it reads like a review (`Review`, `Adversarial review`, `Recheck`, `审查`, `复验`, `复核`); every task-like token in it (`T8h+T11a` → two) is compared case-insensitively with ledger ids, and `r<N>` / `round N` / `第 N 轮` give the round. A reviewer counts as running until it answers, is stopped, or writes nothing for 30 min (same rules as the bg-activity cards). Only a missing `subagents/` dir means "none dispatched"; a PM without `cwd` / `sessionId`, an unreadable dir or a recent subagent whose `.meta.json` is missing or broken makes rules 1 and 3 skip for that run.
- **Busy** means the tmux pane shows a main turn or compaction (`lib/turn-state.ts`). For `pm_held`, an `unknown` pane counts as busy when the session file was written in the last 3 min; while the PM is busy an already-open `pm_held` finding is kept open (`keep`), so busy/idle flips don't reopen and re-push it.
- **PM / dispatcher** both come from `meta.pms`. A name containing `dispatch` is the dispatcher, and the first other name is the PM. A single name receives everything.

Only projects with a PM list are audited, unless `--project` names one. Writing results needs owner / master, or the project's PM with `--project`; `--dry-run` is open to anyone and uses a read-only connection, so it never creates or migrates the database.

## Dedup and lifecycle

A finding's key is `project|rule|object|state fingerprint` (e.g. task + round + stage-entry time for `review_no_reviewer`, message id for `pm_held`). The same key on later runs refreshes `lastSeen` only.

- **Pushed once:** a finding is pushed while it is open with `notifiedAt` empty. The timer acks after a direct delivery. When the notice went into the held queue it acks with `--queued <messageId>`: the finding is no longer pending, and the next run sets `notifiedAt` once that message has left the queue (if the queue file can't be read it counts as still queued). A missing recipient or a failed delivery leaves it for the next run.
- **Resolved:** a finding that no longer appears gets `resolvedAt`. Nothing is pushed for that.
- **Reopened:** if the same key appears again it is reopened (`firstSeen` reset, `notifiedAt` cleared) and pushed again. A new state, such as a new review round or a new idle spell, is a new key.
- **Source failures don't resolve anything:** if a source could not be read (registry, held-queue file, tmux window list, `ledger.json`), the rules that depend on it are left out of `evaluated`, and their open findings stay open. The CLI output lists them under `skipped` with the reason (e.g. `owner_inbox_stale` for a project without `docsDir`) — never silently.

Findings live in their own table, not as ledger events. `events` is append-only, and audit events would crowd `lastEvent` / `projectEvents` (the T11a P1-5 problem).

## Delivery

One notification per recipient per run, from `bridge:ledger-audit`, intent `notification`, `triggerKind: bridge_synth`. It never preempts:

- If the recipient's main turn is running or compacting, the message goes into the held queue and arrives with the other queued messages when the turn ends. `lastMessageSource` is left alone: that turn is probably handling an owner message, and the owner must still get the completion @.
- Otherwise it is delivered directly, and the recipient's `lastMessageSource` is set to `agent` so the Stop after handling it does not @ the owner.

If the dispatcher can't be reached for 2 runs in a row, rules 1–3 go to the PM (`fallback` in the CLI output) until it is back online; the switch is logged once. Changes in `skipped` are logged once per change, so a source that stays unreadable is visible in the bridge log without repeating every run. After T11a merges, the busy check + hold should be replaced by its `meta.waitForIdle`.
