# Ledger audit (T29)

A deterministic, LLM-free check that runs over the built-in ledger every 15 minutes and tells the PM only about things that look dropped. Nothing is fixed automatically; each finding carries one suggested action.

## Pieces

| Piece | File | Role |
|---|---|---|
| Rules | `src/lib/ledger-audit.ts` | `auditLedger(snapshot, now)` — pure; thresholds in `AUDIT_THRESHOLDS` |
| Snapshot | `src/lib/ledger-audit-snapshot.ts`, `ledger-audit-reviewers.ts` | Reads ledger, registry, tmux, session files, subagents, held queue, `ledger.json` |
| Store | `src/lib/ledger-audit-store.ts`, `ledger-audit-schema.ts` | `audit_findings` + `audit_baseline` tables (`audit_findings`: `SCHEMA_AUDIT`, the last step of `LEDGER_MIGRATIONS`; after migrating, `openLedger` checks the table and its two indexes exist and re-runs the steps if a parallel branch skipped them): open / still open / resolved / reopened, `notifiedAt` dedup |
| CLI | `src/manager/ledger-audit-cmd.ts` | `ledger audit [--project <id>] [--dry-run] [--json]`, `ledger audit --ack <key,key> [--queued <messageId>]` |
| Timer | `src/bridge/ledger-audit-service.ts` | Every 15 min (first run 90 s after start): run the CLI, push pending findings, ack |
| Read side | `src/lib/ledger-read.ts` | `GET /api/v1/ledger/:project` returns `audit` (unresolved findings); SSE `ledger` fires when a finding opens or closes |

The bridge stays a read-only ledger client: the timer calls `ledger audit --json` through `runManager`, and the CLI does all writes. Everything is read from files and tmux, not from bridge memory, so a manual CLI run and the timer see the same thing, and a bridge restart changes nothing.

## Rules and thresholds

| Rule | Fires when | Suggestion | Pushed to |
|---|---|---|---|
| `review_no_reviewer` | Task in `review` for > 20 min (since entering, or the last `note` / `review` event), no reviewer subagent running for it, no settled changes / block / pass verdict, and this round's review step (`task_steps`, round = task round, no verdict yet) is either unassigned or assigned to a local agent whose main turn is not running (then the text names it) | Dispatch a reviewer | dispatcher, else PM |
| `review_assigned_stale` | Task in `review`, this round's review step is assigned to a peer / human (no session to watch) and has no verdict > 2 h after the later of assignment and entering `review`; notes don't reset it, reassigning gives a new key | Ask the reviewer, reassign if silent | PM |
| `review_verdict_idle` | Task still in `review` after this round's last review says changes / block: > 5 min for manual or no workflow row, > 20 min for auto / observe; no subsequent review / final_review assignment or dispatch, no reviewer running; notes do not reset it | Read the report, move to fix or open the next round; notice includes verdict, P0 / P1 / P2 counts and report path | PM |
| `review_passed_idle` | Task still in `review` after this round's last review passed (`verdict: pass`): > 5 min for manual or no workflow row, > 30 min for auto / observe; no subsequent review assignment and no reviewer running; notes don't reset it | Review passed: move to merge, or wait for the owner's call | PM |

In a project with `meta.team` (T30), a pass that still owes an adversarial round (`owesAdversarial` on the spec card's review line, the same check as `ledger review --to merge`; a missing spec card counts as not owed) is reported as `review_no_reviewer` to the dispatcher instead — "还欠对抗式，派对抗式", or "check the spec card" when it can't be told — 20 min after the pass, and `review_passed_idle` is not raised.
| `executor_idle` | Task in `build` / `fix`, executor's main turn not busy, its session file unwritten for > 15 min (and ≥ 15 min in the stage), no `deliver` since entering | Ask the executor | dispatcher, else PM |
| `deliver_not_in_review` | Task in `build` / `fix`, a `deliver` recorded **after** entering that stage > 30 min ago, no `review` event after it (a skipped review `review→merge`, a send-back to `fix`, `blocked` never fire) | Check the stage | dispatcher, else PM |
| `pm_held` | A message to someone on the PM list has been held > 10 min **while that agent is idle**, or was claimed by `check_inbox` > 10 min ago without an ack | `check_inbox` | PM |
| `ship_stalled` | Task in `merge` > 30 min / `live` > 60 min with no `deploy` / `verify` event since; `merge` is exempt while `meta.queueFrozen` or while a dependency still blocks the task (`ledger-deps.ts` `blockedBy`: a code predecessor counts once it is live), and its clock starts at the latest of entering `merge`, the last `unfreeze` event and the last dependency release (a manual `done` counts from the edge's update, a derived one from the predecessor entering its satisfied stage) | Deploy / verify, then move the stage | PM |
| `reclaim_executor` | An `agent-task-*` whose tasks are all `done` / `cancelled` for > 30 min still has a tmux window | Kill it | PM |
| `task_agent_missing` | A task in `restate` / `build` / `review` / `fix` names an agent that is not in the registry | Reassign | PM |
| `orphan_executor` | An `agent-task-*` in this project's registry, created > 15 min ago (session-file birth time), has no task in the ledger | Create the task or reclaim | PM |
| `owner_inbox_stale` | An `ownerInbox` entry in the `ledger.json` next to `meta.docsDir` is `doing` / `in_progress` > 30 min after the owner said it | Check progress | PM |
| `review_witness_mismatch` | An auto card's `review` event carries `witness.mismatch` (`lib/caller-witness.ts`): the writer's tmux window, parent process chain or cwd does not fit the bound reviewer. Evidence only — every local agent can fake it, so the verdict is recorded, not refused | Check who wrote the verdict; if not the reviewer, take the card over (`workflow-set --mode manual --reason`) and re-review | PM |
| `merge_pm_blocked` | `autostart.mergePmWait` is `on` and MQWAKE1's candidate (`mergePmCandidate`) says a `merge` card needs a PM action, unchanged for > 10 min (see below) | The candidate's own next steps (re-shoot / review screenshots, `ui-approve`, a new `manual-merge-request` bound to the current head / specRev / round / review) | The reminder's PM (`mergePmTarget`: feature PM, else on-duty PM), else PM |

Boundaries are strict: exactly at the threshold does not fire.

A review / final_review assignment or dispatch after a verdict makes that verdict unsettled. The task resumes the waiting rules: `review_no_reviewer` for an idle local reviewer, or `review_assigned_stale` for a peer / human after 2 h.

- **Stage entry time** comes from the task's stage events. Imported tasks with approximate times (`approxTime`) are never judged on them.
- **Reviewers** are found in the `subagents/` of every agent in the project plus the PM list. A description counts when it reads like a review (`Review`, `Reviewer`, `Adversarial review`, `Recheck`, `审查`, `复验`, `复核`); every task-like token in it (`T8h+T11a` → two, `T2b-2`, `HF-182`, and any word with letters and digits such as `release-v2.32.0`; a trailing `-r1` is the round) is compared case-insensitively with ledger ids, and `r<N>` / `round N` / `第 N 轮` give the round. A reviewer counts as running until it answers, is stopped, or writes nothing for 30 min (same rules as the bg-activity cards). Only a missing `subagents/` dir means "none dispatched"; a PM without `cwd` / `sessionId`, an unreadable dir or a recent subagent whose `.meta.json` is missing or broken makes the review rules (`review_no_reviewer`, `review_assigned_stale`, `review_passed_idle`, `review_verdict_idle`, `deliver_not_in_review`) skip for that run.
- **Busy** means the tmux pane shows a main turn or compaction (`lib/turn-state.ts`). For `pm_held`, an `unknown` pane counts as busy when the session file was written in the last 3 min; while the PM is busy an already-open `pm_held` finding is kept open (`keep`), so busy/idle flips don't reopen and re-push it.
- **PM / dispatcher** both come from `meta.pms`. With `meta.team.dispatcher` set, that agent is the dispatcher; otherwise a name containing `dispatch` is. The first other name is the PM. A single name receives everything.

Only projects with a PM list are audited, unless `--project` names one. Writing results needs owner / master, or the project's PM with `--project`; `--dry-run` is open to anyone and uses the `LedgerReader` connection (`readwrite` + `create: false` + `query_only`), so it never creates or migrates the database; the notice ends with this command.

## Dedup and lifecycle

A finding's key is `project|rule|object|state fingerprint` (e.g. task + round + stage-entry time for `review_no_reviewer`, message id for `pm_held`). The same key on later runs refreshes `lastSeen` only. `review_verdict_idle` and `review_passed_idle` use task + round + review event seq: each verdict is notified once after ack, and a new verdict has a new key.

- **First run is silent:** the first run in which a rule is actually evaluated for a project (recorded per project + rule in `audit_baseline`, even when it finds nothing) marks that rule's open findings as already pushed (`silenced` in the CLI output; rules in `NO_SILENCE_RULES` — `merge_pm_blocked` — only get the baseline). Going live, or a source becoming readable for the first time, doesn't push a backlog; only what appears afterwards is pushed.
- **Pushed once:** a finding is pushed while it is open with `notifiedAt` empty. The timer acks after a direct delivery. When the notice went into the held queue it acks with `--queued <messageId>`: the finding is no longer pending, and the next run sets `notifiedAt` once that message has left the queue (if the queue file can't be read it counts as still queued). A missing recipient or a failed delivery leaves it for the next run.
- **Resolved:** a finding that no longer appears gets `resolvedAt`. Nothing is pushed for that.
- **Reopened:** if the same key appears again it is reopened (`firstSeen` reset, `notifiedAt` cleared) and pushed again. A new state, such as a new review round or a new idle spell, is a new key.
- **Source failures don't resolve anything:** if a source could not be read (registry, held-queue file, tmux window list, `ledger.json`), the rules that depend on it are left out of `evaluated`, and their open findings stay open. The CLI output lists them under `skipped` with the reason (e.g. `owner_inbox_stale` for a project without `docsDir`) — never silently.

Findings live in their own table, not as ledger events. `events` is append-only, and audit events would crowd `lastEvent` / `projectEvents` (the T11a P1-5 problem).

## Delivery

One notification per recipient per run, from `bridge:ledger-audit`, intent `notification`, `triggerKind: bridge_synth`. It never preempts:

- If the recipient's main turn is running or compacting, the message goes into the held queue and arrives with the other queued messages when the turn ends. `lastMessageSource` is left alone: that turn is probably handling an owner message, and the owner must still get the completion @.
- Otherwise it is delivered directly, and the recipient's `lastMessageSource` is set to `agent` so the Stop after handling it does not @ the owner.

If the dispatcher can't be reached for 2 runs in a row, the dispatcher's rules (`review_no_reviewer`, `executor_idle`, `deliver_not_in_review`) go to the PM (`fallback` in the CLI output) until it is back online; the switch is logged once. Changes in `skipped` are logged once per change, so a source that stays unreadable is visible in the bridge log without repeating every run. Notices carry `meta.waitForIdle: true`, which is only a marker until T13a wires it into `deliverToLocal`.

## Merge waiting on a PM (MQWATCH1)

`src/lib/ledger-audit-merge-pm.ts` is the audit-side fallback for MQWAKE1's merge reminder (`docs/architecture/scheduler-autostart.md`). It does not judge requests or screenshots itself: the snapshot (`readMergePm`, same read-only connection) calls `mergePmCandidate` for every `merge` card, reads the same switch (`mergePmMode`) and the reminder's recipient (`mergePmTarget`), and the rule only times and reports.

- **Clock and key.** The block counts from the later of entering `merge` and the card's last event that is not a `note`, `memory` or ask-family event, so PM notes, memory entries and the scheduler's own `merge_pm_wait` notes never push it back. The key is task + head + specRev + round + request + the candidate's blocking key: no time buckets; the same block is reported once (also across restarts, via `audit_findings`), and a new head / request / binding is a new finding. Under 10 min an already-open key is kept open.
- **Clearing.** Once a valid replacement request or a new screenshot approval is recorded, the card leaves `merge` or reaches a final state, the candidate disappears and the finding resolves on the next evaluated run. Normal queueing, `await_ci` / train runs (open intents), an explicit revoke, `unknown` external effects (open intent or `mergeUnknown`) and repository handoff produce no candidate. That MQWAKE1 already messaged the PM is shown in the detail but never treated as resolution.
- **Modes.** `on`: findings as above. `observe`: candidates are computed; with none the rule is evaluated as usual, with some they are listed in `skipped` as a local diagnostic and nothing is reported or resolved. `off` — and a switch that can't be read, which also logs one local line — skips the rule: nothing new is written or sent. Whenever the rule is not evaluated (`off`, `observe` with candidates, unreadable sources) its open findings are passed back as `keep`: they stay open but never enter `pending`, so a finding stored under `on` and not yet delivered is not sent after switching to `off` / `observe`.
- **Unreadable sources.** If the candidates, the baseline, the rule's open findings or the scheduler config (handoff) can't be read, the rule is skipped and open findings stay open. The skip reason carries no error text; details go to the local log only.
- **First run.** Findings depend only on candidates and elapsed time, never on `audit_baseline`, so `--dry-run` reports them on a fresh project too; under `on` the rule is always evaluated. `merge_pm_blocked` is listed in the store's `NO_SILENCE_RULES`: its first evaluated run still records the baseline but does not mark open undelivered findings as pushed. A finding whose delivery failed (PM offline, no ack, not queued) stays in `pending` across runs and restarts until a real ack, while solved blocks resolve on the same run.
- **Text.** Detail and suggestion come from the candidate's text (task id, request seq, short head, review seq, blocking key): no local paths, screenshot paths or digests, credentials. The rule writes nothing but `audit_findings` / `audit_baseline` through the normal store.

## Audit failure alerts (SFAIL1) and the unreadable-ledger boundary

This section records current behaviour and its accepted limits (r1 P2 `ledger-down-no-alert`). It describes no fix: there is no fallback route when the ledger itself cannot be read.

**Escalation.** `ledgerAuditTicker` counts completed rounds that failed, in bridge memory (`src/bridge/ledger-audit-failure.ts`). A round fails as `manager_failed` (`ledger audit --json` returned `ok: false` or threw), `invalid_response` (the success envelope fails `auditResult`; an incomplete envelope neither resets the streak nor acks findings) or `round_failed` (anything after that, including a failed ack). A round skipped because the previous one is still running is not counted. Only from the 3rd consecutive failed round on is a failure notice attempted; one fully successful round (`ok`) resets the streak, the retry delays and the per-project notices. Original findings delivery and ack are unchanged: findings are only pushed / acked from a valid envelope, as described under Dedup and Delivery.

**Recipient.** Each notice goes to the on-duty PM of each audited project (same project set as `ledger audit --json`), resolved through a short-lived `LedgerReader` connection (`query_only`, `create: false`; no schema creation, migration or role write) from the read-only role data in the ledger: the `activePm` pointer, else the first non-dispatcher name in `meta.pms`. The name must be in `meta.pms` and not be the dispatcher; if any project's PM can't be verified, no notice goes out that round. The text is fixed (project, failure kind, summary, "check the local audit log; this round is not zero findings"); command output, errors and paths stay in the local log.

**When the ledger itself can't be read.** The recipients come from the same ledger, so if it is missing, still being created, or fails to open / query, no recipient can be verified and nothing is sent. What remains is local diagnostics only: `⚠️ 台账巡检出错` is logged once per failure streak, and `台账巡检失败告警尚未登记` once until the next successful round. Recipient lookup then retries on eligible failed rounds with the existing bounded backoff (1, 2, 4, then at most 8 ticker intervals, i.e. 2 h). This silence is **not** "no findings" and **not** "notice delivered". There is no cold-start fallback, no cached role approval and no owner / master fallback notice: the counters are in memory, so a bridge restart starts a new streak, and while the ledger stays unreadable no recipient is ever found. A fallback route would need its own design and a real permission basis; this document grants none.

**Receipt limits.**
- `sent` means the router accepted direct delivery; `queued` means the notice went into the held queue under its message id. Neither is a read receipt, and a queued notice is not tracked afterwards (unlike findings' `--queued` ack).
- Once a project's notice is `sent` / `queued`, it is not re-sent or updated during that streak; its failure kind is the one from the round in which the project's notice was first created (which can be later than the first eligible round when recipient verification fails), even if later rounds fail differently. A `failed` delivery is retried on the same backoff with the same message id.
- Recovery does not cancel a notice that is still queued: it stays in the held queue and, if the normal delivery conditions are later met, may reach the PM out of date. Recovery sends no "recovered" notice. After recovery a new streak creates a new notice with a new id, so the PM may get an old queued notice and a new one.
- A queued notice is not guaranteed to arrive, before or after recovery. The held queue's existing limits apply: an ordinary held item is given up after 24 h (`HELD_GIVE_UP_MS`, `src/bridge/held-queue.ts`), and all items held for a target are discarded when that agent is killed (`dropHeldOnKill`, `src/bridge/held-flush.ts`). The failure-alert mechanism stops retrying once it has the `queued` receipt, does not observe these outcomes and does not resend; a given-up or discarded notice is simply not delivered. This is a documented limit, not a queue change.

**Operations.** Checking this is the agent's job, with the existing read-only health and log tools (bridge log lines above, `ledger audit --dry-run`); the owner is not asked to run commands. Reports quote conclusions only, not production output, identities, paths or credentials.

## Follow-ups

- **Still open with T30:** route by `currentHandler`; let `review_no_reviewer` / `deliver_not_in_review` read `dispatch` events (`data.round`) before falling back to subagent descriptions; honour the `meta.team.audit` switch. Automatic escalations (`data.auto: true`) must be told apart if the audit ever counts escalations.
- **After T13a wires `meta.waitForIdle` into delivery:** drop the busy check + hold in `ledger-audit-service.ts` and just deliver.
- **Audit failure with an unreadable ledger (r1 P2 `ledger-down-no-alert`):** recorded above as an accepted current limit; a fallback alert route is not implemented and needs its own design and permission basis.
