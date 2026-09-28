# Usage-limit wall (额度闸)

Every Claude Code agent on one machine runs on the same subscription. When one of them hits the weekly or 5-hour limit, all of them have — the next turn anywhere fails with the same synthetic `You've hit your weekly limit · resets …` entry. Before the wall existed (2026-09-28 22:19), that turned into a mess: the 60-second API-error auto-resume woke 11 agents that failed again at once, every agent→agent message woke a turn that failed immediately, the Stop-hook drain fallback forwarded the limit text to callers as if it were their answer (and consumed the return route), and after the owner used a reset card someone had to press Esc in 12 windows and re-nudge every agent by hand.

The wall makes that one machine-wide state handled by the bridge.

## Code map

| Piece | File |
|---|---|
| Limit text, reset time, menu match, `Limits reset` echo | `src/lib/quota-wall-text.ts` |
| State machine (enter / merge / exit sources / resume list) | `src/lib/quota-wall.ts` |
| Owner notices and the resume message | `src/lib/quota-wall-notice.ts` |
| Runtime: tick, recovery steps, hold decision | `src/bridge/quota-wall.ts` |
| Production wiring + API-error auto-resume | `src/bridge/quota-wall-wiring.ts` |
| Held-queue reason / counts / release | `src/bridge/held-queue.ts` (`reason: "quota_wall"`) |
| Drain fallback on API-error turns | `src/bridge/stop-settle.ts` |
| CLI | `src/manager/quota-wall.ts` (`quota-wall status|clear`) |
| Local API | `GET /api/v1/quota/wall`, `POST /api/v1/quota/wall/clear` (`bridge/local-api/quota.ts`, owner only) |
| Web | `web/features/quota-wall/` (banner), `web/features/chat/notice-merge.ts` + `src/lib/api-error-rows.ts` (error rows) |

State: `~/.claude-orchestrator/quota-wall.json` (written on every change, survives bridge restarts). `manager quota-wall clear` drops `quota-wall-clear.req` next to it; the bridge picks it up on its next 15 s tick (no HTTP route: the CLI has no `/api/v1` credential, and the request survives a bridge that is down).

## Rules

- **Enter** on an `api_error_turn` whose `error` is `rate_limit` **and** whose text starts with `You've hit your … limit` (a 429 "would exceed your account's rate limit" is a transient throttle, not a wall — it keeps the normal 60-second resume), or when the status-line usage cache shows ≥ 100 % for a window whose reset time hasn't passed. Later hits merge into the same wall (kind = the heavier one, reset time = the later one). Only Claude Code agents (master included); Codex and Pi have their own quotas.
- **While walled**, `deliverToLocal` holds every message to a Claude Code agent that isn't from a human (agent→agent, peer, bridge-synthesised: missions, api-error-resume, watchdog nudges). Human messages (Discord user, non-peer API user, button clicks) go through — the owner may be on their way to `/limit-reset` in that window. Held wall items never age (no "still queued" notice, no 24 h give-up). The send_to_agent return book isn't swept while walled and its clocks restart on exit.
- **API errors while walled** are recorded for resume-on-exit instead of the 60-second resume, and never escalate.
- **Drain fallback**: a turn that ended in an API error (`StopFailure`, or last assistant entry `isApiErrorMessage`) settles nothing — no push-back to the caller, pending kept, API waiters left to their real reply or timeout. Applies to every API error, not just the wall.
- **Notify** the owner once, 20 s after entering (so the first wave is merged in): kind, reset time, how many agent messages are queued, how many reset cards are usable (read-only from T2b-2's data). The bridge never uses a card and never picks a menu option.
- **Exit** on the first of: reset time + 1 min; a new `Limits reset · …` echo in any Claude Code window (echoes already on screen when the wall started don't count); the T2b-2 read-only usage probe, every 5 min, showing < 100 % (its own interval, backoff and `quotaClaudeBackground` switch apply); the status-line cache showing < 100 % scraped after the wall started; `quota-wall clear` / the web banner's button.
- **Recover** in persisted, idempotent steps: (1) send one Esc to every window whose screen is *exactly* the limit menu — title, consecutive options starting with "Stop and wait for limit to reset", every option a known label (from the Claude Code binary), the Esc hint as the last line; anything else is logged and listed for the owner, never keyed; (2) turn wall items back into normal held items (fresh timestamps) and flush channels in order of their earliest item; (3) send `[额度恢复] …` to each interrupted agent that didn't just receive queued messages and isn't already running. Then one notice: menus closed, messages delivered, agents resumed, duration.
- **Web**: API-error entries render as one system row, consecutive identical ones merged as `×N`, in history and live.

## Integration points

- `quotaWall()` (from `bridge/quota-wall-wiring.ts`) exposes `active()`, `until()` (reset time while walled) and `onExit(cb)` for the Autopilot scheduler.
- The recovery resume message should move to `meta.waitForIdle` once that exists; until then the bridge checks the main turn is idle right before sending.
