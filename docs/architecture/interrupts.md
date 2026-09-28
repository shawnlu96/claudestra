# Interrupts: preemption, stop words, cut records, resume hints

What happens when a human message or a stop button interrupts an agent mid-turn, and how the agent is told what was cut. Code: `src/bridge/preempt.ts` (entry points), `src/lib/interrupt-gate.ts` + `src/bridge/interrupt-gate.ts` (the only place keys are sent), `src/lib/turn-cuts.ts` + `src/bridge/turn-cuts.ts` (cut records), `src/lib/side-effects.ts`, `src/lib/stop-words.ts`, `src/lib/codex-tui-submit.ts`. Tests: `tests/interrupt-gate.test.ts`, `turn-cuts.test.ts`, `turn-cuts-book.test.ts`, `turn-state.test.ts`, `side-effects.test.ts`, `stop-words.test.ts`, `codex-tui-submit.test.ts`.

## Entry points

| Entry | Path | What it does |
|---|---|---|
| Human request (Discord, Web, API; not peers) | `deliverToLocal` → `preemptForHuman` | If the target's main turn is busy: interrupt, and only if a key was actually sent **and** (Claude Code) the pane shows the turn stopped, record a cut and put a headline on the message; then deliver. Claude Code and Codex preempt; Pi does not (its extension steers the message into the running turn). |
| Stop word (same path) | `preemptForHuman` with `stop` | Interrupts on all three runtimes, including Pi; inside the 1.5 s key gap it waits the gap out instead of dropping the stop. Always records a stop-class cut (no resume hint, Autopilot holds), even when nothing was running; the headline says truthfully whether it interrupted. |
| Stop button, `/interrupt`, `POST /api/v1/agents/:name/interrupt` | `manualInterrupt` | Sends the runtime's key unconditionally (Codex only when busy), records a `manual` cut (stopped) even when idle, marks the turn done. |
| Claude Code interrupted in its own terminal | jsonl-watcher sees `[Request interrupted by user` → `turn_interrupted` event | No key from the bridge within 5 s of that line → a `terminal` cut (stopped), and the status (stuck at `thinking`, CC sends no Stop) is settled to `done` unless a message was delivered since. |
| Codex interrupted in its own terminal | `/hook` with `interrupt: true` → `onCodexInterrupt` | `typing-hook` reports Codex's `Interrupt` hook as `StopFailure` + `interrupt`. A key from the bridge within 5 s = our own echo (the preempt records the cut); otherwise a `codex_interrupt` cut (stopped). |

Discord inbound used to preempt a second time before `deliver()`; that duplicate call is gone, and every human message goes through the one gate.

## Stop words (`lib/stop-words.ts`)

A message is a stop only if, after NFKC + lower-casing and dropping punctuation / whitespace, the **whole message** is one stop word (or the same one repeated), at most 8 characters, and it doesn't mention 继续 / 接着 / continue. List (design §3.6 + the owner-approved 等一下 / 等等 / wait): 停 停下 停止 先停 停一下 停停 别做了 别跑了 不要做了 取消 等一下 等等 stop abort cancel halt wait. A sentence that starts with one ("停！先别合", "Stop hook 为啥没触发", "等等，还有一个需求") is an ordinary message: the agent decides, and Claude Code / Codex are preempted by it anyway. The adversarial review's false-positive list is in `tests/stop-words.test.ts`.

## Cut records

At the moment of the interrupt the bridge snapshots the event bus (`inflightTools(agent)`: tool_start without tool_done since the last `done`) — the three runtimes share the jsonl-watcher translation layer, so this works the same everywhere. A cut stores the tools that were running, the last completed step, the side-effect class, the message the interrupted turn was handling (`turnTrigger`, from the last delivered inbound), who interrupted, and earlier unfinished cuts (`chain`, for interrupts during the interjection turn). The watcher polls every ~2 s, so a tool that started just before the interrupt shows up late as an errored tool_done; `lateInflight` adds it to the cut.

States: `open` → `resumed` (the agent started the same tool with the same command again — tracked per chain segment; the cut is `resumed` only when every segment is, and the hint lists only the segments not yet resumed), `stopped` (stop word / button / terminal), `hinted` (resume hint generated), `expired` (30 min). Persisted to `turn-cuts.json`, one per channel.

Side-effect classes (`lib/side-effects.ts`, rule table in the test): `none` (reads), `idempotent` (deploy, build, fetch, non-force push, kickstart), `check_first` (manager create/kill/…, commit, merge, Edit/Write, anything unknown), `external` (tag, release, force push, remote branch delete, publish, peer send_to_agent, HTTP writes via curl / wget / httpie / gh api, kubectl / helm / terraform / aws / gcloud / az changes, writes through MCP servers like Slack, GitHub, Gmail). Unknown Bash is always `check_first`.

## What the agent sees

1. **Headline** on the interrupting message (`withInterruptNote`, inserted after the source header so history parsing strips it block by block): what was running and whether it can be rerun, what the turn was handling, and that Claude Code's "STOP … wait for the user" tool result is the interrupt's fixed wording, not a request to give up. Stop words get a `⏹` headline instead: stop, confirm, don't resume.
2. **Resume hint** (`[⏯ 打断收尾]`): on the first normal `Stop` after the interrupting message was delivered, if the cut is still open. It goes through the held queue with `waitForIdle`, so it is never sent mid-turn. `Envelope.meta.waitForIdle` has fixed semantics that other features reuse (T11a answers): deliver only when the main turn is idle; while busy or compacting, hold and flush on Stop / compaction end / the minute sweep; never preempt — such an envelope is never an `isHumanRequest`, even from a human. It lists the cut tool with its class and check hint, the last completed step, and the human message the interrupted turn was handling: "not replied" if nothing went to that address since it was delivered, "check whether you answered it" if the only replies came after the cut (they may have answered the interjection). A held hint is dropped before delivery if the agent resumed meanwhile, was interrupted or stopped again (the newer cut chains the unfinished segment), or 30 minutes passed. The Stop of the turn it starts doesn't @ the owner (like Autopilot's nudges). `external` adds a fixed "check first, don't just rerun"; Codex adds "the command may still be running in the background". Never replays anything.

## Runtimes

| | Claude Code | Codex | Pi |
|---|---|---|---|
| Human message while busy | Esc, then deliver (not C-c, below) | Esc, then deliver (typed into the TUI, below) | steered into the running turn, no interrupt |
| Stop word / button | Esc | Esc (only when busy) | C-c |
| Interrupt signal | none (bridge marks done itself) | `Interrupt` hook ~0.5 s after Esc | extension reports `agent_settled` → treated as `Stop` |
| Background subagents | survive (Esc; C-c on an idle main turn would kill them) | — | — |
| Transcript | cut tool_use gets an `is_error` result "The user doesn't want to proceed … STOP …", then `[Request interrupted by user for tool use]` | `<turn_aborted>` developer message; the aborted command **may keep running** (a `ping` finished in the background after Esc, 2026-09-28) | not verified (below) |

### Claude Code: a stuck `thinking` status vs. a clearly idle pane

The event status can stay `thinking` after the turn has ended (interrupted from the terminal: CC sends no Stop; or relit after a Stop). Before, that made the bridge preempt an idle agent, tell it "this message interrupted you, resume what was cut" (it then redid work a human had just stopped) and hold agent messages until the 2-minute reconcile. Now `turnState` (`stuckThinkingIdle`) trusts the pane when it is **clearly** idle: two captures ~1 s apart both idle (prompt present, no spinner, no compaction / API-retry banner, TUI contract recognised) and nothing in the agent's event ring (jsonl activity, deliveries; background-agent progress excluded) for 8 s. The probe then settles the status to `done` (`trigger: pane_idle`). A turn that has just started still counts as busy (the delivery and the first jsonl writes are recent). Codex / Pi keep using the event status only.

### Claude Code: Esc, never C-c (background subagents)

Verified on Claude Code 2.1.283 in the sandbox (2026-09-28), a background subagent running `ping` while the main turn ran a foreground `ping`:

| Key | Main turn busy | Main turn idle, only background agents running |
|---|---|---|
| C-c | main turn interrupted, background agent keeps running | **"All background agents stopped"** — every background agent is killed |
| Esc | main turn interrupted, background agent keeps running | nothing happens, background agent keeps running |

The source agrees: the interrupt handler returns early while a query is running; only when nothing is running does C-c fall through to "stop all background agents", while Esc is bound with `suppressBackgroundAgentKill: true`. Both leave the same transcript markers (the cut tool_use gets the "STOP … wait for the user" error result, then `[Request interrupted by user for tool use]`).

The busy check could say "busy" while the main turn was idle (production on 2026-09-28 22:16:44 preempted an idle PM and killed its background reviewer); with C-c that misjudgment killed background work, with Esc it is a no-op. So Claude Code's `interruptKeys` is `["Escape"]` for preemption, stop words and the stop buttons alike. Graceful exit (`restart` / `kill`) still uses C-c: stopping everything is what exiting means.

Double Esc opens Rewind (≤600 ms apart). Every Esc — interrupts, AUQ cancel, watchers, and manager's `tmux-send-keys` from the Discord buttons — goes through `tmuxSendEscape` (`lib/esc-guard.ts`): the window is identified by tmux's `#{window_id}` (so `master:0` from the interrupt and `windowTarget("master")` from AUQ cancel are the same window; `windowKey` also maps them together as a fallback), a cross-process lock in the runtime dir is held for the whole send, and the next Esc waits until 1200 ms after the previous one **finished** — spacing by scheduled time was not enough: under load a tmux call can take hundreds of ms and two keypresses landed close enough to open Rewind in the sandbox. The gate additionally spaces its own keys ≥1.5 s. Before sending, a pane in tmux copy-mode is taken out of it (keys would otherwise be eaten by tmux).

Limit: a stop button or stop word no longer stops an agent's background subagents; only its main turn. Stopping those needs Claude Code's own kill-agents chord in the terminal.

### Codex: the queue stalls after an interrupt

Verified on codex-cli 0.153.4 (2026-09-28): after Esc the TUI shows "Conversation interrupted - tell the model what to do differently" and stops taking items from its queue. A message sent with `codex queue` afterwards stays in `~/.codex/queue_1.sqlite` indefinitely; another queue write or an empty Enter does not release it; only a turn submitted from the TUI itself does, after which the queued items run in order. Upstream reports of the same family: [openai/codex#17095](https://github.com/openai/codex/issues/17095), [openai/codex#37974](https://github.com/openai/codex/issues/37974). This also affected the stop button before preemption existed: after it, every later message to that Codex agent stalled.

Fix: the bridge remembers per Codex channel that an interrupt happened since the last normal `Stop` (`TurnCuts.takeAfterInterrupt`, in memory) and tags the next inbound with `meta.after_interrupt`. Codex's `CodexQueueSink` then types that one message into the TUI instead of queueing it (`lib/codex-tui-submit.ts`). Guards around it:

- the channel-server declares `typeIn: true` in its register frame; the bridge only preempts (or sends a stop word's Esc to) Codex channels that declared it — an older channel-server would leave every message stuck in the paused queue while the sender sees "delivered";
- one bridge preempt per Codex turn: until the next normal `Stop`, later human messages queue behind the earlier ones instead of being typed ahead of them (order A, B, C stays A, B, C); stop words still interrupt;
- if typing can't be done, the channel-server falls back to `codex queue`, tells the sender the message waits behind the paused queue, and reports `codex_typein_failed` so the bridge tags the next message again; "pasted but no submit seen" is also reported to the sender;

- target is the exact pane id from `TMUX_PANE`, and `TMUX` must point at Claudestra's tmux socket; otherwise it falls back;
- it pastes only when the composer is recognisably empty — no busy status line, no dialog or backtrack overlay, and the bold `›` line holds nothing but the dim placeholder (read from `capture-pane -e`); anything else falls back to `codex queue` with a log line, never a blind paste;
- control characters are stripped first (`sanitizeForPaste`: all C0/C1 except `\n` / `\t`, `\r` → `\n`): tmux doesn't remove an embedded `ESC[201~`, and everything after that end-of-paste marker would arrive as keystrokes (`!shell`, C-c) — found by the adversarial review;
- bracketed paste (`set-buffer` + `paste-buffer -p`), so newlines, quotes, `$`, backticks and CJK arrive verbatim (verified live), then Enter; success = the turn starts or the composer empties; a second Enter covers an Enter taken as a newline; if the paste can't be confirmed the composer is cleared before falling back, so a message is never both typed and queued.

Once that typed turn ends, the queue drains normally again (verified: a queued message ran 10 s after the typed turn's Stop). **Takes effect only for Codex agents started after this change** (the channel-server process is per session); running Codex agents need a restart.

### Pi (not verified — no Pi install on the test machine)

Inferred from source: Stop words and the stop button send C-c (`PI_CONTROL.interruptKeys`); ordinary human messages keep being steered (`claudestra-extension.ts` `deliverAs: "steer"` while streaming), so Pi never gets preemption cuts or resume hints. After C-c the extension still receives `agent_settled` and posts `Stop`; the stop-class cut is already `stopped`, so nothing is sent. The stop-word message itself arrives as a follow-up once the turn has settled. How Pi records an aborted tool in its session file, and whether an aborted bash keeps running, still need a live check.

## Autopilot

A stop (stop word, stop button, terminal interrupt) is the human taking over: Autopilot (`bridge/mission.ts`) yields with `human_stopped` until the human says something that is not a stop, and with `cut_notice` while a resume hint is still waiting to be delivered, so the hint and Autopilot's "keep going" nudge don't stack.

## Sandbox results (2026-09-28, Claude Code)

Long foreground command cut by an interjection → headline delivered → agent answered, inspected the half-written file and reran it on its own (cut `resumed`, no hint). Interjection that asked for an answer only → `Stop` → resume hint 2 s later listing the cut command and the unreplied request → agent checked and reran. `停。` → interrupt (then C-c; Esc since the switch) → `⏹` headline → agent confirmed stop, no hint. API stop → `manual` cut, stopped.
