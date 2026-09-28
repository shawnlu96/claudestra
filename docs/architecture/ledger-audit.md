# Ledger audit (T29)

A deterministic, LLM-free check that runs over the built-in ledger every 15 minutes and tells the PM only about things that look dropped. Nothing is fixed automatically; each finding carries one suggested action.

## Pieces

| Piece | File | Role |
|---|---|---|
| Rules | `src/lib/ledger-audit.ts` | `auditLedger(snapshot, now)` — pure; thresholds in `AUDIT_THRESHOLDS` |
| Snapshot | `src/lib/ledger-audit-snapshot.ts` | Reads ledger, registry, tmux, session files, subagents, held queue, `ledger.json` |
| Store | `src/lib/ledger-audit-store.ts` | `audit_findings` table (`SCHEMA_AUDIT` migration): open / still open / resolved / reopened, `notifiedAt` dedup |
| CLI | `src/manager/ledger-audit-cmd.ts` | `ledger audit [--project <id>] [--dry-run] [--json]`, `ledger audit --ack <key,key>` |
| Timer | `src/bridge/ledger-audit-service.ts` | Every 15 min (first run 90 s after start): run the CLI, push pending findings, ack |
| Read side | `src/lib/ledger-read.ts` | `GET /api/v1/ledger/:project` returns `audit` (unresolved findings); SSE `ledger` fires when a finding opens or closes |

The bridge stays a read-only ledger client: the timer calls `ledger audit --json` through `runManager`, and the CLI does all writes. Everything is read from files and tmux, not from bridge memory, so a manual CLI run and the timer see the same thing, and a bridge restart changes nothing.

## Rules and thresholds

| Rule | Fires when | Suggestion | Pushed to |
|---|---|---|---|
| `review_no_reviewer` | Task in `review` for > 20 min (since entering, or the last `note` / `review` event), no reviewer subagent running for it | Dispatch a reviewer | dispatcher, else PM |
| `executor_idle` | Task in `build` / `fix`, executor's main turn not busy, its session file unwritten for > 15 min (and ≥ 15 min in the stage), no `deliver` since entering | Ask the executor | dispatcher, else PM |
| `deliver_not_in_review` | Last `deliver` > 30 min ago, no `review` event after it, and the stage is neither `review` nor terminal | Check the stage | dispatcher, else PM |
| `pm_held` | A message to someone on the PM list has been held > 10 min **while that agent is idle or unreadable**, or was claimed by `check_inbox` > 10 min ago without an ack | `check_inbox` | PM |
| `ship_stalled` | Task in `merge` / `live` > 30 min with no `deploy` / `verify` event since | Deploy / verify, then move the stage | PM |
| `reclaim_executor` | An `agent-task-*` whose tasks are all `done` / `cancelled` for > 30 min still has a tmux window | Kill it | PM |
| `task_agent_missing` | A task past `spec` and not terminal names an agent that is not in the registry | Reassign | PM |
| `orphan_executor` | An `agent-task-*` in this project's registry has no task in the ledger | Create the task or reclaim | PM |
| `owner_inbox_stale` | An `ownerInbox` entry in the `ledger.json` next to `meta.docsDir` is `doing` / `in_progress` > 30 min after the owner said it | Check progress | PM |

Boundaries are strict: exactly at the threshold does not fire.

- **Stage entry time** comes from the task's stage events. Imported tasks with approximate times (`approxTime`) are never judged on them.
- **Reviewers** are recognised by the description convention in the dispatch playbook: `Review <T> r<N>` / `Adversarial review <T> r<N>`, found in the `subagents/` of everyone on the PM list. A reviewer counts as running until it answers, is stopped, or writes nothing for 30 min (same rules as the bg-activity cards).
- **Busy** means the tmux pane shows a main turn or compaction (`lib/turn-state.ts`). `unknown` counts as not busy.
- **PM / dispatcher** both come from `meta.pms`. A name containing `dispatch` is the dispatcher, and the first other name is the PM. A single name receives everything.

Only projects with a PM list are audited, unless `--project` names one.

## Dedup and lifecycle

A finding's key is `project|rule|object|state fingerprint` (e.g. task + round + stage-entry time for `review_no_reviewer`, message id for `pm_held`). The same key on later runs refreshes `lastSeen` only.

- **Pushed once:** a finding is pushed while it is open with `notifiedAt` empty. The timer acks after a successful delivery (including "put in the held queue"). A missing recipient or a failed delivery leaves it for the next run.
- **Resolved:** a finding that no longer appears gets `resolvedAt`. Nothing is pushed for that.
- **Reopened:** if the same key appears again it is reopened (`firstSeen` reset, `notifiedAt` cleared) and pushed again. A new state, such as a new review round or a new idle spell, is a new key.
- **Source failures don't resolve anything:** if a source could not be read (registry, held-queue file, tmux window list, `ledger.json`), the rules that depend on it are left out of `evaluated`, and their open findings stay open. The CLI output lists them under `skipped` with the reason (e.g. `owner_inbox_stale` for a project without `docsDir`) — never silently.

Findings live in their own table, not as ledger events. `events` is append-only, and audit events would crowd `lastEvent` / `projectEvents` (the T11a P1-5 problem).

## Delivery

One notification per recipient per run, from `bridge:ledger-audit`, intent `notification`, `triggerKind: bridge_synth`. It never preempts:

- If the recipient's main turn is running or compacting, the message goes into the held queue and arrives with the other queued messages when the turn ends.
- Otherwise it is delivered directly.

The recipient's `lastMessageSource` is set to `agent`, so the Stop after handling it does not @ the owner.
