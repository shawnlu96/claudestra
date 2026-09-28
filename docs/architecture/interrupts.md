# Interrupts: preemption, stop words, cut records, resume hints

What happens when a human message or a stop button interrupts an agent mid-turn, and how the agent is told what was cut. Code: `src/bridge/preempt.ts` (entry points), `src/lib/interrupt-gate.ts` + `src/bridge/interrupt-gate.ts` (the only place keys are sent), `src/lib/turn-cuts.ts` + `src/bridge/turn-cuts.ts` (cut records), `src/lib/side-effects.ts`, `src/lib/stop-words.ts`, `src/lib/codex-tui-submit.ts`. Tests: `tests/interrupt-gate.test.ts`, `turn-cuts.test.ts`, `side-effects.test.ts`, `stop-words.test.ts`, `codex-tui-submit.test.ts`.

## Entry points

| Entry | Path | What it does |
|---|---|---|
| Human request (Discord, Web, API; not peers) | `deliverToLocal` → `preemptForHuman` | If the target's main turn is busy: interrupt, record a cut, put a headline on the message, deliver. Claude Code and Codex preempt; Pi does not (its extension steers the message into the running turn). |
| Stop word (same path) | `preemptForHuman` with `stop` | Interrupts on all three runtimes, including Pi. The cut is born `stopped`: no resume hint. |
| Stop button, `/interrupt`, `POST /api/v1/agents/:name/interrupt` | `manualInterrupt` | Sends the runtime's key unconditionally (Codex only when busy), records a `manual` cut (stopped), marks the turn done. |
| Codex interrupted in its own terminal | `/hook` with `interrupt: true` → `onCodexInterrupt` | `typing-hook` reports Codex's `Interrupt` hook as `StopFailure` + `interrupt`. Our own Esc is recognised as an echo (a cut exists from the last 15 s); otherwise a `codex_interrupt` cut (stopped) is recorded. |

Discord inbound used to preempt a second time before `deliver()`; that duplicate call is gone, and every human message goes through the one gate.

## Stop words (`lib/stop-words.ts`)

A message is a stop if, after NFKC + lower-casing, it is a stop word alone (or the same one repeated, up to 8 chars), or starts with a stop word followed by punctuation or a space ("停！先别合", "等一下，先看看 X"). The rest of the sentence is still delivered to the agent. Mid-sentence use ("我等一下再看") is not a stop. `wait` / `cancel` need punctuation after them ("wait for the build" is a request). List: 停 停下 停下来 停止 先停 先停下 停一下 停停 暂停 别做了 别跑了 不要做了 取消 等一下 等等 先等等 先等一下 stop abort halt wait cancel.

## Cut records

At the moment of the interrupt the bridge snapshots the event bus (`inflightTools(agent)`: tool_start without tool_done since the last `done`) — the three runtimes share the jsonl-watcher translation layer, so this works the same everywhere. A cut stores the tools that were running, the last completed step, the side-effect class, the message the interrupted turn was handling (`turnTrigger`, from the last delivered inbound), who interrupted, and earlier unfinished cuts (`chain`, for interrupts during the interjection turn). The watcher polls every ~2 s, so a tool that started just before the interrupt shows up late as an errored tool_done; `lateInflight` adds it to the cut.

States: `open` → `resumed` (the agent started the same tool with the same command again), `stopped` (stop word / button), `hinted` (resume hint sent), `expired` (30 min). Persisted to `turn-cuts.json`, one per channel.

Side-effect classes (`lib/side-effects.ts`, rule table in the test): `none` (reads), `idempotent` (deploy, build, fetch, non-force push, kickstart), `check_first` (manager create/kill/…, commit, merge, Edit/Write, anything unknown), `external` (tag, release, force push, remote branch delete, mutating curl / gh api, publish, peer send_to_agent). Unknown Bash is always `check_first`.

## What the agent sees

1. **Headline** on the interrupting message (`withInterruptNote`, inserted after the source header so history parsing strips it block by block): what was running and whether it can be rerun, what the turn was handling, and that Claude Code's "STOP … wait for the user" tool result is the interrupt's fixed wording, not a request to give up. Stop words get a `⏹` headline instead: stop, confirm, don't resume.
2. **Resume hint** (`[⏯ 打断收尾]`): on the first normal `Stop` after the interrupting message was delivered, if the cut is still open. It goes through the held queue with `waitForIdle`, so it is never sent mid-turn. `Envelope.meta.waitForIdle` has fixed semantics that other features reuse (T11a answers): deliver only when the main turn is idle; while busy or compacting, hold and flush on Stop / compaction end / the minute sweep; never preempt — such an envelope is never an `isHumanRequest`, even from a human. It lists the cut tool with its class and check hint, the last completed step, and human messages the interrupted turn never replied to (no reply to that address between the message's delivery and the cut). `external` adds a fixed "check first, don't just rerun"; Codex adds "the command may still be running in the background". Never replays anything.

## Runtimes

| | Claude Code | Codex | Pi |
|---|---|---|---|
| Human message while busy | Esc, then deliver (not C-c, below) | Esc, then deliver (typed into the TUI, below) | steered into the running turn, no interrupt |
| Stop word / button | Esc | Esc (only when busy) | C-c |
| Interrupt signal | none (bridge marks done itself) | `Interrupt` hook ~0.5 s after Esc | extension reports `agent_settled` → treated as `Stop` |
| Background subagents | survive (Esc; C-c on an idle main turn would kill them) | — | — |
| Transcript | cut tool_use gets an `is_error` result "The user doesn't want to proceed … STOP …", then `[Request interrupted by user for tool use]` | `<turn_aborted>` developer message; the aborted command **may keep running** (a `ping` finished in the background after Esc, 2026-09-28) | not verified (below) |

### Claude Code: Esc, never C-c (background subagents)

Verified on Claude Code 2.1.283 in the sandbox (2026-09-28), a background subagent running `ping` while the main turn ran a foreground `ping`:

| Key | Main turn busy | Main turn idle, only background agents running |
|---|---|---|
| C-c | main turn interrupted, background agent keeps running | **"All background agents stopped"** — every background agent is killed |
| Esc | main turn interrupted, background agent keeps running | nothing happens, background agent keeps running |

The source agrees: the interrupt handler returns early while a query is running; only when nothing is running does C-c fall through to "stop all background agents", while Esc is bound with `suppressBackgroundAgentKill: true`. Both leave the same transcript markers (the cut tool_use gets the "STOP … wait for the user" error result, then `[Request interrupted by user for tool use]`).

The busy check can say "busy" while the main turn is idle (the event status stays `thinking` when a turn ends without a Stop hook, e.g. interrupted from the terminal; production on 2026-09-28 22:16:44 preempted an idle PM and killed its background reviewer). With C-c that misjudgment killed background work; with Esc it is a no-op. So Claude Code's `interruptKeys` is `["Escape"]` for preemption, stop words and the stop buttons alike. Every interrupt Esc goes through `tmuxSendEscape` (≥1200 ms between Escs per window, shared with the watchers), and the gate spaces any two keys ≥1.5 s, so a double-Esc Rewind can't be triggered. Graceful exit (`restart` / `kill`) still uses C-c: stopping everything is what exiting means.

Limit: a stop button or stop word no longer stops an agent's background subagents; only its main turn. Stopping those needs Claude Code's own kill-agents chord in the terminal.

### Codex: the queue stalls after an interrupt

Verified on codex-cli 0.153.4 (2026-09-28): after Esc the TUI shows "Conversation interrupted - tell the model what to do differently" and stops taking items from its queue. A message sent with `codex queue` afterwards stays in `~/.codex/queue_1.sqlite` indefinitely; another queue write or an empty Enter does not release it; only a turn submitted from the TUI itself does, after which the queued items run in order. Upstream reports of the same family: [openai/codex#17095](https://github.com/openai/codex/issues/17095), [openai/codex#37974](https://github.com/openai/codex/issues/37974). This also affected the stop button before preemption existed: after it, every later message to that Codex agent stalled.

Fix: the bridge remembers per Codex channel that an interrupt happened since the last normal `Stop` (`TurnCuts.takeAfterInterrupt`, in memory) and tags the next inbound with `meta.after_interrupt`. Codex's `CodexQueueSink` then types that one message into the TUI instead of queueing it (`lib/codex-tui-submit.ts`):

- target is the exact pane id from `TMUX_PANE`, and `TMUX` must point at Claudestra's tmux socket; otherwise it falls back;
- it pastes only when the composer is recognisably empty — no busy status line, no dialog or backtrack overlay, and the bold `›` line holds nothing but the dim placeholder (read from `capture-pane -e`); anything else falls back to `codex queue` with a log line, never a blind paste;
- bracketed paste (`set-buffer` + `paste-buffer -p`), so newlines, quotes, `$`, backticks and CJK arrive verbatim (verified live), then Enter; success = the turn starts or the composer empties; a second Enter covers an Enter taken as a newline; if the paste can't be confirmed the composer is cleared before falling back, so a message is never both typed and queued.

Once that typed turn ends, the queue drains normally again (verified: a queued message ran 10 s after the typed turn's Stop). **Takes effect only for Codex agents started after this change** (the channel-server process is per session); running Codex agents need a restart.

### Pi (not verified — no Pi install on the test machine)

Inferred from source: Stop words and the stop button send C-c (`PI_CONTROL.interruptKeys`); ordinary human messages keep being steered (`claudestra-extension.ts` `deliverAs: "steer"` while streaming), so Pi never gets preemption cuts or resume hints. After C-c the extension still receives `agent_settled` and posts `Stop`; the stop-class cut is already `stopped`, so nothing is sent. The stop-word message itself arrives as a follow-up once the turn has settled. How Pi records an aborted tool in its session file, and whether an aborted bash keeps running, still need a live check.

## Sandbox results (2026-09-28, Claude Code)

Long foreground command cut by an interjection → headline delivered → agent answered, inspected the half-written file and reran it on its own (cut `resumed`, no hint). Interjection that asked for an answer only → `Stop` → resume hint 2 s later listing the cut command and the unreplied request → agent checked and reran. `停。` → interrupt (then C-c; Esc since the switch) → `⏹` headline → agent confirmed stop, no hint. API stop → `manual` cut, stopped.
