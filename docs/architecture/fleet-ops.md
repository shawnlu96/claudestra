# Fleet ops: low-priority state, one-click toggle, batch actions

Owner-only batch management for Claude Code sessions: see which sessions are running at **low priority** (LP) or waiting at the usage wall, flip LP on/off, and fan the same action out to many agents with a per-agent result.

Code: `src/lib/lp-state.ts` (pane → state, decision table, menu navigation), `src/lib/fleet-plan.ts` (action whitelist, selection, summaries), `src/bridge/fleet/` (`runner.ts` key sequences, `lp-monitor.ts` polling + SSE, `service.ts` orchestration, `audit.ts` logging, `ws.ts` CLI entry), `src/bridge/local-api/fleet.ts` (HTTP), `src/manager/fleet.ts` (CLI), `web/features/fleet/` (panel + badge). Tests: `tests/lp-state.test.ts`, `tests/fleet-plan.test.ts`, `tests/fleet-runner.test.ts`, `tests/fleet-routes.test.ts`; pane samples in `tests/fixtures/lp/` were captured from sandbox agents at a real usage wall (CC 2.1.283).

## Why the pane, not statusLine

The statusLine JSON has no LP field — `rate_limits` only carries `used_percentage` / `resets_at` for the 5-hour, 7-day and spend windows. LP lives only in the CC process (`phase: active`, `resetsAtSeconds`). So the state comes from the footer under the input box, read with `capture-pane -p -e` (read-only, never `/status`). Only the footer counts: the same words in the conversation above (e.g. an agent discussing this feature) are ignored.

Footer copy comes from CC's remote config; the defaults we match:

| State | Footer / echo |
|---|---|
| on | `Lower priority until 3:20am` (+ `91% allowance left`, `/low-priority to stop`), `Working at lower priority · waiting for capacity` |
| off, offered | `/low-priority to continue now at lower priority · uses your weekly limit` |
| walled | `Usage limit reached · continuing automatically at 3:20am · esc to cancel` (also `… when it resets`, `… shortly`) |
| exhausted | `You've used this week's lower-priority allowance` |
| resumable | last echo in the pane is `Lower-priority mode is off … run /low-priority again to turn it back on` |

A footer that mentions low-priority but matches none of these is `unknown` — `/low-priority` is a toggle, so a misread would flip it the wrong way; unknown always refuses.

Facts found live that shape the runner:

- LP ends by itself at the reset time (+60 s), on the weekly limit, budget exhaustion, or after waiting too long; there is nothing to "turn off after recovery" in most cases.
- Sending `/low-priority` to a session that has not hit the wall prints `Lower-priority mode isn't available right now.` — LP cannot be enabled in advance, hence the "walled" selector.
- Turning LP on immediately starts an auto-continue turn; LP-then-compact interrupts it (Esc, only when a spinner is actually visible — two Escs within ~700 ms open Rewind), clears whatever Esc put back in the input (C-u, then waits for the redraw), then sends `/compact`.
- The rate-limit menu (`/rate-limit-options`) changes shape: 5 items, 4 items, or only `Stop and wait for limit to reset` / `Switch to usage credits` after a manual LP stop. The runner never counts steps: it presses arrows toward the exact label `Continue now at lower priority` and presses Enter only if the highlighted item equals it; otherwise Esc and fail. `Switch to usage credits`, `Upgrade`, `Team plan` and credit offers are never selectable (`MENU_ALLOWED_LABELS`).
- The existing busy regex (`CC_BUSY_RE`) contains `esc to cancel`, which the walled footer also contains, so an idle walled session reads as busy there. Fleet judges busy only from the spinner lines above the input box.
- At low priority `/compact` may first show `Working at lower priority … next try in 15s` before `Compacting conversation`; any spinner after the command counts as started. A short conversation answers `Not enough messages to compact.` → skipped.
- Dim text in the input box (`ESC[2m`) is CC's suggestion and gets replaced by typing; normal-colour text is someone's draft and blocks every key-sending action.
- Modals (`modal`): no input box at the bottom (rate-limit menu, permission prompt, AskUserQuestion, Rewind — which draws `▔` instead of `─`), or a box that is really a dialog (a numbered option on the `❯` line, or capitalised `Esc to cancel` / `Enter to select|confirm|continue` / `Tab to amend` inside or under it; the walled footer's lowercase `esc to cancel` does not count). Only the rate-limit menu may receive keys; every other dialog is refused without pressing anything — Esc on the bypass first-run prompt exits CC. Real samples: `modal-*.ansi`.

## Shared with T36

`paneQuotaState(plain, escaped) → { wall, lp, exhausted, menu, compacting, draft }` in `lib/lp-state.ts` is the pane gate of T36's context-boundary injector. It reads only `escaped` (plain is the fallback when that capture is empty); `draft` is also true when the input box cannot be read, so an unprovable-empty box never gets typed into. Either side changing this file tells the other.

## Actions and outcomes

`lp-on`, `lp-off` (set-to-state: already there → skipped; busy → failed "busy, not sent", since a queued toggle runs after the turn and may flip the wrong way), `compact` (with a keep list; busy → queued), `save-compact` (an executor — `agent-task-*` or a cwd inside a linked git worktree — gets `compact` instead: its save-compact resolves to the main repo's memory directory and overwrites the PM's HANDOFF), `lp-compact` (on → interrupt → clear → compact), `text` (delivered through `deliver()` as a bridge-origin message with a `[📣 批量指令 · 来自 …]` header, all runtimes). Each agent reports `done` / `queued` / `skipped` / `failed` with a reason. CC-only actions skip Pi and Codex agents; offline agents are skipped. `compact` / `save-compact` refuse while walled with LP off or exhausted (same rule as T36's gate: the command would just sit there).

Default keep list: `DEFAULT_COMPACT_KEEP` in `lib/fleet-plan.ts`, overridable via `config.json` `fleet.compactKeep`, editable per run in the panel. Newlines are collapsed — a newline in the TUI input submits.

Selection: explicit agents, `all`, `project`, plus AND-filters `walled` and `ctxOver`. The master is excluded unless named or `includeMaster` is set. Four agents run concurrently.

## Surfaces and permissions

- `GET /api/v1/fleet/state`, `POST /api/v1/fleet/run {action, select, dryRun?}` — `canRunFleet`: the owner principal (`isOwnerPrincipal`) with a full-scope manage credential. Guests, partial-scope devices, non-owner tokens and peers get 403.
- `manager fleet state` / `manager fleet <action> --agents a,b|--project p|--all [--walled] [--ctx-over N] [--include-master] [--keep …] [--text …] [--dry-run]` — sends ws `fleet_run` to the bridge; the bridge only accepts it on a connection whose upgrade was direct loopback without `X-Forwarded-For` (same trust as `route_to_agent`).
- `GET /api/v1/agents` rows carry `lowPriority` (not for peers); SSE `low_priority` (transient) fires when a polled state changes (every 30 s, and right after a fleet run).
- Web: the context badge's "存记忆 + Compact" and the composer's over-limit banner call `requestCompact(agent)` → `POST /fleet/run` for that one agent (owner only, same gate); the result text stays on the button / banner, a failure can be retried.
- Web: badge next to the sidebar name (lucide snail / hourglass / ban), panel from Agent 管理 → 批量管理. Discord stats dashboard: plain-text tag (`LP→3:20am`, `撞墙中`, `LP 本周额度已用完`), display only.
- Every run logs one line per agent to the bridge log (`🛰 [fleet] <runId> …`) and writes one project-level ledger note per affected project (who, when, action, per-agent results).

Out of scope: toggling LP automatically on wall / reset, and context-boundary auto-compaction (T36).
