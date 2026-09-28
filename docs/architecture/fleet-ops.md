# Fleet ops: low-priority state, one-click toggle, batch actions

Owner-only batch management for Claude Code sessions: see which sessions are running at **low priority** (LP) or waiting at the usage wall, flip LP on/off, and fan the same action out to many agents with a per-agent result.

Code: `src/lib/lp-state.ts` (pane → state, decision table), `src/lib/fleet-plan.ts` (action whitelist, selection, summaries), `src/bridge/fleet/` (`runner.ts` key sequences, `lp-monitor.ts` polling + SSE, `service.ts` orchestration, `audit.ts` logging, `ws.ts` CLI entry), `src/bridge/local-api/fleet.ts` (HTTP), `src/manager/fleet.ts` (CLI), `web/features/fleet/` (panel + badge). Tests: `tests/lp-state.test.ts`, `tests/fleet-plan.test.ts`, `tests/fleet-runner.test.ts`, `tests/fleet-routes.test.ts`; pane samples in `tests/fixtures/lp/` were captured from sandbox agents at a real usage wall (CC 2.1.283).

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
- Turning LP on immediately starts an auto-continue turn; LP-then-compact interrupts it (Esc, only when a spinner is actually visible — two Escs within ~700 ms open Rewind). If Esc puts our own `/low-priority` back into the input, it is cleared with C-u; any other text there may be someone typing, so the window is skipped (LP stays on, no compaction) and nothing is cleared.
- The rate-limit menu (`/rate-limit-options`, also shown on its own at the wall) changes shape: 5 items, 4 items, or only `Stop and wait for limit to reset` / `Switch to usage credits` after a manual LP stop. Fleet recognises it (the session counts as walled; `lp-off` skips) but **never presses a key on any menu or dialog, Esc included**: Enter, digits and Esc all have side effects there (`Switch to usage credits`, permission `1 = Yes`, cancelling the wall). `lp-on` on a menu fails with a hint to pick `Continue now at lower priority` by hand.
- The existing busy regex (`CC_BUSY_RE`) contains `esc to cancel`, which the walled footer also contains, so an idle walled session reads as busy there (T41). Fleet strips `esc (or type) to cancel` case-insensitively and then applies `CC_BUSY_RE` to the whole visible area above the input box (a spinner can sit above a long todo list).
- At low priority `/compact` may first show `Working at lower priority … next try in 15s` before `Compacting conversation`; any spinner after the command counts as started. A short conversation answers `Not enough messages to compact.` → skipped.
- Dim text in the input box (`ESC[2m`) is CC's suggestion and gets replaced by typing; normal-colour text is someone's draft and blocks every key-sending action.
- The input box is found only by column-0 borders and a column-0 prompt (`❯`, or `!` in bash mode, where `/compact` would run as a shell command and so always counts as a draft); conversation text, tool output and code blocks are indented, so a quoted "box" there cannot hide a real menu below it. The bottom 20 lines are checked for a numbered menu / `Enter to confirm` first, whether or not a box was found.
- Modals (`modal`, a stable field T36 relies on): no input box at the bottom (rate-limit menu, permission prompt, AskUserQuestion, Rewind — which draws `▔` instead of `─`), or a box that is really a dialog (a numbered option on the `❯` line, or capitalised `Esc to cancel` / `Enter to select|confirm|continue` / `Tab to amend` inside or under it; the walled footer's lowercase `esc to cancel` does not count). Only the rate-limit menu may receive keys; every other dialog is refused without pressing anything — Esc on the bypass first-run prompt exits CC. Real samples: `modal-*.ansi`.

## Shared with T36

`paneQuotaState(plain, escaped) → { wall, lp, exhausted, menu, compacting, draft }` in `lib/lp-state.ts` is the pane gate of T36's context-boundary injector. Callers take one `capture-pane -p -e` and pass it as `escaped` (plain is only the fallback when that is empty); `menu` is `LpRead.modal`; `draft` is true whenever the input is not provably empty (draft, queued or unreadable). Either side changing this file tells the other.

## Actions and outcomes

`lp-on`, `lp-off` (set-to-state: already there → skipped; busy → failed "busy, not sent", since a queued toggle runs after the turn and may flip the wrong way), `compact` (with a keep list; busy → queued), `save-compact` (an executor — `agent-task-*` or a cwd inside a linked git worktree — gets `compact` instead: its save-compact resolves to the main repo's memory directory and overwrites the PM's HANDOFF), `lp-compact` (on → interrupt → clear → compact), `text` (delivered through `deliver()` as a bridge-origin message with a `[📣 批量指令 · 来自 …]` header, all runtimes). Each agent reports `done` / `queued` / `skipped` / `failed` with a reason. CC-only actions skip Pi and Codex agents; offline agents are skipped. `compact` / `save-compact` refuse while walled with LP off or exhausted (same rule as T36's gate: the command would just sit there).

Default keep list: `DEFAULT_COMPACT_KEEP` in `lib/fleet-plan.ts` (no digits: typed into a numbered dialog by mistake, a digit selects an option), overridable via `config.json` `fleet.compactKeep`, editable per run in the panel. Keep lists and batch text go through `neutralizeDelegateMarker`. Before typing, the runner reads the pane twice 300 ms apart and sends only if both reads pass; a `/compact` echo counts only under a command line that appeared after sending. Newlines are collapsed — a newline in the TUI input submits.

Selection: explicit agents, `all`, `project`, plus AND-filters `walled` and `ctxOver`. The master is excluded unless named or `includeMaster` is set. Four agents run concurrently.

## Surfaces and permissions

- `GET /api/v1/fleet/state`, `POST /api/v1/fleet/run {action, select, dryRun?}` — `canRunFleet`: the owner principal (`isOwnerPrincipal`) with a full-scope manage credential. Guests, partial-scope devices, non-owner tokens and peers get 403.
- `manager fleet state` / `manager fleet <lp-on|lp-off|compact|save-compact|lp-compact> --agents a,b|--project p|--all [--walled] [--ctx-over N] [--dry-run]` — sends ws `fleet_run`, accepted only on a direct-loopback upgrade. Any local process (including an agent's Bash) can reach it and cannot be told apart from the owner, so it is logged as `local-cli`, and batch text, custom keep lists and the master are refused there (web owner path only).
- `GET /api/v1/agents` rows carry `lowPriority` and SSE `low_priority` is delivered only for `canRunFleet` credentials (same gate as the batch API); SSE `low_priority` (transient) fires when a polled state changes (every 30 s, and right after a fleet run).
- Web: the context badge's "存记忆 + Compact" and the composer's over-limit banner call `requestCompact(agent)` → `POST /fleet/run` for that one agent (owner only, same gate); the result text stays on the button / banner, a failure can be retried.
- Web: badge next to the sidebar name (lucide snail / hourglass / ban), panel from Agent 管理 → 批量管理. Discord stats dashboard: plain-text tag (`LP→3:20am`, `撞墙中`, `LP 本周额度已用完`), display only.
- Every run logs one line per agent to the bridge log (`🛰 [fleet] <runId> …`) and writes one project-level ledger note per affected project (who, when, action, per-agent results).

## MCP tool (`fleet`)

Agents that schedule other agents (the master and PMs) call the batch actions themselves through the channel-server tool `fleet` (`src/lib/fleet-tool.ts`, registered in `channel-server.ts`). It is a thin client over the same ws `fleet_state` / `fleet_run`; nothing about execution differs from the panel and the CLI. Claude Code loads MCP tools lazily, so callers find it as `mcp__claudestra__fleet` via ToolSearch (the master template says so; a sandbox Haiku agent that wasn't told went for `manager fleet` in Bash instead).

- `fleet({op:"state"})` — one line per agent the caller may act on: online / busy / walled (reset time, LP offered) / LP on (until when, allowance left) / context tokens (from the session usage, not the pane's ctx%).
- `fleet({op:"run", action, select, dryRun?, text?})` — `action` is `lp_on` / `lp_off` / `lp_compact` / `compact` / `save_compact` / `text`; `select` takes `agents` / `all` / `project` plus the `walled` / `ctxOver` filters. **`dryRun` defaults to true** (only a literal `false` executes) and returns who would be acted on and who is skipped with why. `keep` is not accepted — compaction always uses `fleet.compactKeep`. `text` is at most 2000 characters, delivered through `deliver()` as a notification (no keys, no preemption) with the caller's name in the header.

Who may call (`src/lib/fleet-caller.ts`, tests in `tests/fleet-caller.test.ts`). The bridge identifies the caller from the channel registered on that ws connection (`clients`), never from a field in the request; the tool sends none.

| Connection | Result |
|---|---|
| control channel | master — every agent except the master itself |
| registry agent listed in a project's ledger `pms` | PM — only agents in the projects it is PM of; `all` expands to those projects, naming another project fails |
| registry agent listed in `config.json` `fleet.callers` | every agent except the master |
| agent with `external` on | refused (its turn may have been started by a peer message) |
| any other agent, executors included | refused: 只有大总管和 PM 能用 fleet |
| registered channel not in the registry | refused |
| unregistered connection with `via:"mcp"` | refused (a channel-server that failed to register must not fall into the CLI branch) |
| unregistered connection without it | the CLI branch (`manager fleet` above) — can't tell who it is: logged as `local-cli`, no text / keep / master |

Through the tool the master is never a target: naming it (with or without the `agent-` prefix) or `includeMaster` fails the whole request, the same line the CLI branch draws — the master is operated only by the owner from the web panel. Batch text is the one thing the tool may do that the CLI branch may not, because here the bridge knows who is sending; it goes through the same delegate-marker neutralisation as the panel's text (`parseFleetAction`). The caller never acts on itself — it is mid-turn while calling, so naming itself with `compact` / `lp_compact` / `save_compact` fails the whole request, and any other way it gets selected puts it in `excluded` with the reason. Runs are logged and noted in the ledger with the caller's name as the actor and `mcp` as the channel.

Out of scope: toggling LP automatically on wall / reset, and context-boundary auto-compaction (T36).
