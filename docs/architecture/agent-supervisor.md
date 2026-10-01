# Agent supervisor (i28-S1)

The scheduler daemon watches every agent that **has work in flight** and handles its failures with a fixed table: recover on
its own when it can, close the failure card once the agent recovers, and only then ask a person — the one who handed out the
work first, never the owner directly.

## Who is supervised

`lib/agent-supervisor-scope.ts` `supervisedAgents()` — the same function in the scheduler and in the bridge:

| In flight | Dispatcher (gets the report) |
|---|---|
| A scheduler order: the card is on the auto workflow, its active scheduler session's latest `dispatch` / `review` intent is `done` (sent) and the ledger has no delivery / verdict for it yet | the project PM, through `scheduler-fallback-manual` (same path as the auto tick's escalation) |
| A `send_to_agent` request: in `pending-agent-calls.json`, delivered (not in `held-messages.json`), not older than the bridge's 2-hour sweep | the calling agent |

Never supervised: `master`, lend workers (`agent-lend-*`, they have their own R5a watchdog), agents whose project is not in
`scheduler.json` or has `supervise: false`, and agents whose registry session is not the one the ledger bound.

## Switch

`scheduler.json`: `"supervise": true | false | { "enabled": bool, "stuckMin": 5..240 }` (absent = on, `stuckMin` 20), and
`projects.<id>.supervise: false` per project. With it off (or the scheduler disabled) the pass never calls the supervisor,
the auto tick is not wrapped, and the bridge-side hooks see an empty list — behaviour is identical to before
(`tests/agent-supervisor-scope.test.ts`, `tests/agent-supervisor-e2e.test.ts`).

## Detection (reuses existing signals only)

- **cyber_policy** — the bridge's "Codex 回合失败" card (`acp-link.ts`, `extra.failure = "error"`) whose text is OpenAI's
  "flagged for possible cybersecurity risk" sentence (the adapter maps `cyberPolicy` to category `request`, no actions).
- **overload / rate limit / 5xx** — `api_error_turn` (retryable ACP failures become API-error entries; Codex tmux too).
- **quota / login** — the bridge's quota / login cards.
- **host or window gone** — ACP: `worker-liveness.ts` four states; tmux: window present / absent. Two observations
  ≥ `MISS_GAP_MS` apart with the same agent / session / work (`agent-supervisor-judge.ts`, rules of R5a's `noteLiveness`).
- **stuck** (ACP only) — the turn is running and the host has seen no `session/update` for `stuckMin`, read from the host's
  heartbeat file `state/acp-activity/<agent>.json` (`agent-supervisor-activity.ts`). Bridge entries are never used for this:
  thought chunks are not forwarded and text is buffered, so a long-thinking turn would look stuck. Until the host writes the
  heartbeat (node i28-S1b) there is no file and nothing is judged stuck.

## Disposition table (`agent-supervisor-policy.ts`)

| Fault | Action | Limit | After the limit |
|---|---|---|---|
| overload / rate limit / 5xx | the bridge's 60-second resume, same session | 3 per piece of work, persisted (others keep the old 1 per run) | escalate every further error, report dispatcher once |
| cyber_policy | one fixed recovery message in the same session | 1 per piece of work | report dispatcher, advise "改 Claude 同家审、标待换模型终审" |
| host / window gone, stuck | `manager restart` (resumes the registry session), then one "上次中断了，接着做原来的单" | 2 restarts per agent per hour, 5 min apart | report dispatcher + tell the owner; no more auto-restarts for that work |
| quota / login | none | — | owner card as before + report dispatcher |

The order itself is never resent: after a restart the agent re-takes it with `take_order` / `take_review`.

## Bookkeeping and races

Every detection and action is a ledger `note` with `data.op = "supervise"` (`agent-supervisor-ledger.ts`), written through
the scheduler identity's `ledger scheduler-supervise`. Each external action is **claimed first** under a dedup key
(fault key + step + phase) and only performed if the claim was new; a claim without a result counts as done ("unknown",
never repeated). Counts for the limits come from these events, so a scheduler restart cannot reset them. The restart key is
anchored on the agent's previous restart claim, taken at the start of the round, so two rounds starting together claim the
same key. Right before restarting the supervisor checks again — once before the claim (so a recovered agent does not use up
the quota) and once after it (the claim waits on the ledger CLI): the agent must still be supervised with the same session and
work, and still down the same way (the scope is read after the probe, since the probe itself waits). The production effect
runs the same scope check (`RestartExpect.eligible`, synchronous: latest registry + ledger) once more right before it spawns
`manager restart`, and the child checks again after taking the restart lock (next section). A failed re-check records the claim as `skipped`, which does not count toward the restart limit.

## Bridge side (`agent-supervisor-bridge.ts`)

- `api-error-resume.ts` asks `overloadEscalate` on every API-error turn. Unsupervised channels get the old answer (escalate
  only when the error follows a resume within the window). For a supervised agent the grants are counted per work + session
  in `state/supervise-overload.json` (and, if that file is lost, from the ledger's booked resumes), so a bridge restart or a
  long gap cannot reset them; once 3 are used every further error escalates until the work changes, and a failed write
  escalates too. `quota-wall-wiring.ts` records each error and what the bridge did (`noteOverload`, supervised agents only)
  for the supervisor to book and report.
- Failure cards: a supervised agent's cyber_policy card is opened without an owner push while recovery attempts remain.
- Recovery: in a supervised project, the agent's next normally finished turn (`Stop`, own channel, not an API error)
  closes its open failed-turn cards (`stop-settle.ts` `closeRecoveredCards`); quota / login cards and other agents' cards are
  never touched. The auto tick stands aside (`agent-supervisor-hold.ts`) for the one card whose recovery the supervisor claimed.

## Re-check inside the restart child (`restart --expect`, node i28-S1c)

The scheduler's last check runs before it spawns `manager restart`; the child takes the per-agent restart lock about a second
later. So that a delivery, a hand-back to the PM, a session swap or a window coming back inside that second cannot still
lead to a restart, the supervisor passes `restart --expect <json> -- <agent>` (wire format: `agent-supervisor-expect.ts`:
exactly `v`, `agent`, `sessionId`, `down`, `workKey`; `agent` must equal the restart target, anything else is refused).
After taking the lock and before touching any window, the child (`src/manager/restart-expect.ts`) re-checks:

1. the agent is still supervised with the same session and work (`stillSupervised`, the same scope function the scheduler's
   own re-check uses; the supervise switch being off counts as out of scope);
2. a fresh probe (`agent-supervisor-probe.ts`, the same probe and the same `downOf` verdict) still shows the confirmed fault —
   `no_window` / `no_host`, or for `stuck` a running ACP turn with no update for `stuckMin`;
3. the scope once more after the probe, since the probe waits.

Any failed condition, and any read failure (scheduler.json, registry, ledger, probe `unknown` or throwing), releases the
lock without touching the window and returns `{ name, ok: false, skipped: <reason> }`. With `--expect`, refusals that happen before the
re-check passes are skipped too, since none of them touched a window: a create / rename / kill still in progress, a registry
entry missing its session or channel, the agent gone, another restart holding the lock (`markExpectSkips` / `expectMissing`).
A failure after the re-check passed stays a failure. The supervisor books that exactly like
its own failed re-check: `restart/done/skipped`, no restart-limit use, no report. Without `--expect`, restart reads none of
this and behaves as before. Tests: `tests/restart-expect.test.ts`.
