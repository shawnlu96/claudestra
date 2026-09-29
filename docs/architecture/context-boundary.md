# Context boundaries: per-role compaction lines

Every turn re-reads the whole context (cache reads still count against the plan), so an executor sitting at 600K costs about ten times what it costs at 60K per turn. Context boundaries put a ceiling on task agents without touching the owner's long personal conversations. Code: `src/lib/ctx-boundary-policy.ts` (pure: config, matching, executor rule), `src/lib/ctx-boundary-decision.ts` (pure: which line applies, decision table, display), `src/bridge/ctx-boundary.ts` (the per-minute runner), `src/bridge/ctx-boundary-inject.ts` (the one injection entry point), `src/manager/ctx-boundary.ts` (switch and dry-run). Tests: `tests/ctx-boundary-policy.test.ts`, `tests/ctx-boundary.test.ts`, `tests/ctx-boundary-inject.test.ts`, `tests/ctx-boundary-lp.test.ts` (real screens), `tests/web-ctx-boundary-view.test.ts`.

## Switch and dry-run (rollout)

The switch `autoCompact.inject` is **off by default** and covers only what this feature adds: the named policies and the master. The existing behaviour — the global auto save-compact line and the 93% safety net — keeps running on its own settings whatever the switch says, so an upgrade never silently drops it.

- **Off**: named policies are ignored; every Claude Code agent except the master is compacted by the global line and safety net (the pre-T36 behaviour, now with the pane gate and typed-then-verify injection). The master is not auto-compacted. The embed lists the switch state at the top; the display shows each agent's effective line (the global one while off). Text left in an input box is still erased every tick.
- **On**: named policies apply to the agents they match, and the master joins the global path.

```bash
bun src/manager.ts ctx-boundary dry-run   # live registry, panes, config, persisted guard/cooldown → who would get what, and why; sends no key, writes nothing
bun src/manager.ts ctx-boundary on|off    # writes autoCompact.inject via config-store; the bridge re-reads it every tick, no restart
bun src/manager.ts ctx-boundary status
```

The web settings page (Settings → auto save memory + compact) has the same switch, backed by `GET/POST /api/v1/auto-compact` `{inject}` (full-scope credential; only a real boolean is accepted), so a web-only install can turn it on.

Dry-run evaluates twice and prints two sections, each listing only agents over a line with `会注入（…）：<the exact line>` or `不动：<reason>`: `existing` (the switch off — what runs regardless) and `gated` (named-policy agents and, separately, the master, as they would be with the switch on). Turn the switch on only after reading it.

## Two layers

| Layer | Who compacts | When | Keeps state? |
|---|---|---|---|
| 1. `ccWindow` → `--settings {"autoCompactWindow": N}` at launch | Claude Code itself | at about N − 33K, **also mid-turn** | CC's own summary only |
| 2. `window` / `hardCap` → bridge injects `/compact <keep list>` or `/save-compact` | the bridge | idle past `window`, or past `hardCap` even when busy (queued to the turn boundary) | keep list / memory save |

Layer 2 is meant to act first; layer 1 is the backstop for a single turn that runs away. So `hardCap` must sit below CC's real trigger point (`ccWindow − ~33K`); the resolver warns when it does not.

### What Claude Code does with `autoCompactWindow` (2.1.283, verified 2026-09-29)

- `claude -p "/autocompact" --settings '{"autoCompactWindow":150000}'` prints `Auto-compact window: 150k tokens (from settings)` — the key is honoured from `--settings`, no global settings change needed.
- The schema is an **integer between 100,000 and 1,000,000**; anything else is silently dropped (30000 → "1m tokens (default)"). We validate on read and surface the warning instead of letting it vanish.
- CC compacts at roughly the window minus ~33K (the old stray `750000` fired at ~720K).
- It is read at process start. A running session only gets it after a restart, and resuming a session already above it compacts on the first turn. Nothing restarts agents automatically; running executors are brought down by layer 2's `hardCap`.

## Configuration (`config.json` → `autoCompact.policies`)

```json
"autoCompact": {
  "window": 450000, "idleHours": 0.2, "emergency": true,
  "policies": [
    { "id": "coordinator", "match": { "names": ["agent-pm-*", "agent-claudestra"] } },
    { "id": "proj-x", "match": { "projects": ["proj-x"] }, "window": 150000, "hardCap": 200000 }
  ]
}
```

- Built-ins (no machine-specific names): `executor` = `agent-task-*`, window 200K / idle 3 min / hardCap 250K / ccWindow 300K / `compact`; `coordinator` = `agent-pm-*`, window 300K / idle 5 min / hardCap 400K / `save-compact` (coordinators need to leave a HANDOFF; executors must not — see below).
- Entries merge onto the built-in with the same `id` (write only what changes); `"enabled": false` turns one off; a new `id` is a new policy. Order: configured entries first (as written), untouched built-ins after.
- `match` is replaced as a whole, never combined with the inherited one: `{"id":"executor","match":{"projects":["x"]}}` makes executor a project-only policy (not "project x **and** agent-task-*"). An empty `match` drops the entry — for a built-in id that disables the built-in too, so the resolver says so; use `enabled: false` to turn one off on purpose.
- A broad policy can take executors away from the built-in: a names-only policy listed before it whose pattern may hit `agent-task-*` (`agent-*`, `*`), or any project-only policy (projects outrank names). The resolver warns ("会抢在内置 executor 之前"); the executor then gets that policy's numbers.
- Fields: `match.projects` (project ids) / `match.names` (glob, `*` and `?`), `window`, `idleMinutes`, `hardCap` (≥ window), `action` (`compact` | `save-compact`), `ccWindow` (100K–1M or omitted), `keep` (replaces the default keep list; `normalizeCompactKeep()` in `lib/ctx-boundary-policy.ts` is the only entry and the only producer of the `CompactKeep` type that `injectCompact` accepts — anything else that types a keep list, such as T35's `fleet.compactKeep`, calls it too. A list ending in a backslash is refused: in CC, backslash + Enter inserts a newline instead of submitting. Line breaks (`\r\n`, `\r`, `\n`) together with the whitespace at the ends of each line become one space, and the 800-character cap counts the result. A keep list with any other control character (C0, C1, U+2028 / U+2029) or an invisible format character (`\p{Cf}` except ZWNJ, ZWJ and the soft hyphen) is reported and the default list is used, because it is typed into the input box verbatim: ESC would interrupt the turn, a zero-width or bidi character makes the box check fail, and a much longer line risks tmux rejecting the `send-keys`).
- Matching priority: a policy with both projects **and** names (both must hit) > projects only > names only; ties go to the first in the list. The master session is only matched by the literal name `master`, never by a wildcard.
- `config-store` keeps `policies` verbatim; validation happens in the resolver so a hand-written mistake is reported, not erased by the next settings save.
- Agents that match no policy use the global `window` / `idleHours` / `emergency` exactly as before (85% / 93% of the real window when statusline reports it).

## Executors never get `/save-compact`

An executor runs in a git worktree, but Claude Code resolves its auto-memory directory to the **main** checkout (`~/.claude/projects/-Users-…-claude-orchestrator/memory/`), the same one the PM uses. `/save-compact` writes `HANDOFF.md` there, so an executor's save-compact overwrites the PM's hand-off (observed 2026-09-29 01:49). Therefore:

- "Executor" = the name is `agent-task-*` **or** the working directory is a linked git worktree (`.git` is a file whose `gitdir:` points at `…/worktrees/<name>`). The worktree test is the root cause itself, so a renamed worktree agent is covered. A submodule also has a `.git` file, but it points at `…/modules/…` and its memory directory is its own, so it is not an executor. Registry `parent` / `task` are deliberately not used: the PM's dispatch assistant carries both but runs in the ledger directory with its own memory, and needs `save-compact` for its HANDOFF.
- `effectiveAction(executor, action)`: for an executor a `save-compact` becomes `compact` with the keep list — whatever the policy says, and on the global fallback too. `injectCompact` takes an `InjectTarget` that carries the executor flag (build one with `injectTargetFor(name)`), so no caller can skip the rule.
- The resolver warns when a `save-compact` policy could reach executors: a name pattern whose literal prefix overlaps `agent-task-` (`agent-*`, `*`, `agent-task-t36`), or a project-only policy.
- Unmatched personal agents keep `save-compact`: each lives in its own repository, so their memory directories don't collide.

## Decision table (`boundaryDecision`)

First match wins:

1. below both lines → nothing
2. anything injected a compaction into this window in the last 15 min → skip (`recent`)
3. the pane shows compacting, or the spinner line reports an API retry (`No response from the API … retrying` replaces "Compacting conversation" mid-compaction) → skip
4. injected less than 30 min ago and still above the line → skip (injections can be swallowed; retry after 30 min)
5. pane unreadable → skip (never type blind)
6. the foreground process is not Claude Code (`pane_current_command` is not `claude`, `claude.exe`, `node` or a version number — CC exited and a shell is left; the keep list would be typed into zsh) → skip
7. the pane is in copy-mode (someone scrolling history in the web terminal; `send-keys` would drag them back to the bottom) → skip
8. quota wall and low-priority not on → skip, **without** starting the retry timer
9. a selection menu on screen → skip (the quota-wall menu's option 3 buys usage credits; a digit in the keep list could pick it)
10. a queued message already waiting → skip (usually the previous `/compact`; don't stack a second one) — checked before the draft step so it is reported as "queued"
11. text in the input box → skip, **even past the hard cap**: a half-typed owner message would be submitted glued to `/compact …` (reproduced in a private tmux)
12. at/over `hardCap` → inject (queued if busy)
13. over `window` and idle → inject
14. otherwise (busy) → wait

Steps 3 and 5–11 are `paneBlock()`, shared by every caller. Step 8 also covers "low-priority allowance exhausted" (`exhausted`). A failed send (window gone, tmux error) keeps the error text in the log, records no injection guard, and retries after 5 minutes instead of 30.

"Idle" = the last real conversation record is at least `idleMinutes` old **and** the pane shows no spinner / background work (CC touches session files on its own, so mtime alone is unreliable, and a long tool call leaves it untouched). The global path (personal agents) additionally keeps the old condition — session-file mtime at least `idleHours` old — so personal agents are compacted no more often than before; named policies use only the new definition.

### Pane gate (`lp-state`)

Pane facts come from `paneQuotaState(plain, escaped)` in `src/lib/lp-state.ts` — one function shared with T35's fleet actions — on **one** `capture-pane -p -e` (`plain` is its `stripAnsi`; two separate captures disagreed 15 times in 200 while the screen was changing). The gate (`paneGateOf` → `paneBlock`) adds three facts of its own: `apiRetry` (`paneShowsApiRetry`), `copyMode` and `notCc` (both from one `list-panes -F '#{pane_in_mode}\t#{pane_current_command}'`). It blocks on `wall` (walled, or the quota menu open) unless low-priority is on, `exhausted`, `menu` (no input box — quota menu, permission prompt, AUQ, Rewind, model / effort confirm, bypass first-run — or a box that is really a dialog: numbered options, `Esc to cancel` / `Enter to select`), `compacting`, queued messages ("Press up to edit queued messages" — usually the previous `/compact`; sending again would stack; reported as its own reason), and `draft`: anything in the box that is not provably empty — a draft, queued messages, bash mode (`!` prompt; `/compact` would run as a shell command, so it counts even when empty), or a box it cannot read (a plain capture without colours). The box and the `❯` prompt are recognised only at column 0, so indented look-alikes in the conversation, tool output or code blocks are never taken for the input box; CC caps the box at 7 visible lines and scrolls, so long drafts are still recognised. Named policies, the global path and the Discord "save + compact" button all go through it; there is no switch to bypass it. An unreadable pane (window gone — capture uses `tmuxRawStrict`, an empty capture counts as unreadable) is never typed into: tmux `send-keys` to a missing window does not fail, so it would only report a fake "sent". Samples: `tests/fixtures/lp/` (`input-*` real CC 2.1.283 input boxes incl. bash mode, long and ruled drafts; `modal-*` real dialogs).

Why `-e`: in a plain capture an empty input box still shows CC's grey suggestion (`❯ Try "write a test for <filepath>"`); only the `ESC[2m` in the escaped capture tells it apart from a real draft (`❯ owner half typed msg`). A multi-line draft continues on indented lines inside the box.

### Global path vs. the old code

Where the global path is not identical to the old stats-dashboard code:

- **Scope**: the old code ran only in Discord mode and only for agents with a `channelId`. The runner covers every active Claude Code agent, including agents without a channel and web-only installs, which get automatic compaction for the first time (defaults 400K / 3 h unless configured).
- **Executor rule**: on the global path an executor (`agent-task-*`, or a personal agent whose working directory is a linked worktree; submodules are not) gets `/compact` with the keep list instead of `/save-compact`, which would overwrite the PM's HANDOFF.md.
- **Live session**: usage is read from the session actually running in the window (below), not only the `sessionId` in the registry.
- **Master** is covered once the switch is on (global path: `/save-compact`, 400K / 3 h idle, 93% lifeline); while it is off the master is left alone, as before. The old code built its target from the registry key (`master:=agent-master`) while the window is named `master`, so it never read master's pane and master had no lifeline at all.
- **Idle**: both the new and the old condition must hold, so it fires no more often than before (review r2 compared 3024 cases: every difference was "old fires, new waits").

## Runner

- `startCtxBoundary()` runs once a minute from `bridge.ts`, in Discord and web-only mode alike (it used to live in the Discord stats dashboard, so web-only installs and the sandbox never auto-compacted).
- Claude Code agents only (the injected commands and pane parsing are CC's), master included (registry `agent-master` → window `master`, `agentWindowName`).
- Every tick each agent is first matched to the session actually running in its window (`resolveSessionIdsForWindows`: one `ps`, one tmux pane listing and one read of `~/.claude/sessions/` for all agents; CC rewrites `~/.claude/sessions/<pid>.json` on `/clear`, verified 2026-09-29). A registry still pointing at the pre-`/clear` file neither compacts the fresh session every 30 minutes nor hides a fresh session that is over the line.
  - Only a registered CC that is the pane process itself or one of its descendants counts (`pickCcSessionUnderPane`). The `tmux` field in the registration (`master:@x.%N`) carries no socket, so a CC in another tmux server with the same pane number and directory would match it; it cannot be a descendant of this pane.
  - A CC started under another candidate (a nested `claude -p` run by the agent) is dropped; among the rest the one launched from the agent's directory, most recent first.
- Only agents over a line get their pane captured.
- Skips are logged once per reason change; injections always.
- The 15-minute injection guard, the 30-minute cooldown and the text left in input boxes are persisted (`state/ctx-boundary-injected.json`, `state/ctx-boundary-trig.json`, `state/ctx-boundary-pending-echo.json`), so a bridge restart in the middle of a save-compact turn does not queue a second one and still erases what an earlier injection left behind.
- Past the hard cap but blocked by a draft, queued message, menu, quota wall or copy-mode — or an injection left its text in the box, or the window is too small even for `/compact` — the owner gets one alert per agent per 30 minutes: a `session_anomaly` event (`kind: "ctx_boundary_blocked"`, rendered as a system line in the web chat) and, for a Discord channel, a message there. Blocking is right; staying silent would end in CC's own ~967K compaction.

## Injection (`injectCompact`)

`injectCompact(injectTarget, {action, keep, pane?})` is the single entry for every compaction injection (auto, the Discord "save + compact" button, T35's fan-out). Returns `executed` / `queued` / `skipped` (with a readable reason) / `failed` (with `leftover: true` when typed text was left in the box).

1. Refuse within 15 minutes of the last injection into that window — for every caller, the manual button included.
2. Check the keep list again with `normalizeCompactKeep`. The parameter only accepts its branded `CompactKeep`, so a caller cannot pass a raw string; the runtime check stops a cast.
3. Read the pane and run `paneBlock`.
4. Pick the longest command that fits the window (next section): the configured keep list, else the default list, else a bare `/compact`. When none fits, skip as `window-small`, press nothing, alert the owner and retry after 5 minutes.
5. Type the command (`send-keys -l`) **without** Enter, then read the pane again (every 200 ms, up to 5 frames). CC wraps the line at word boundaries and drops the space at each wrap, so the box text is compared with whitespace removed.
   - box equals the command, no dialog → press Enter; record the guard.
   - the box is full and two frames show only the tail of the command (the estimate was short) → erase it and type the next shorter command.
   - compacting / API retry / a queued message appeared → erase what we typed (below) and skip.
   - a dialog / menu / quota wall / copy-mode / non-CC process appeared → press nothing (a key could answer the dialog); remember the text as pending. Every later tick — switch on or off, so text left by the manual button goes too — checks pending windows and erases it once the box shows exactly that text again; after a day it is dropped.
   - the box holds something else (the owner typing at the same time) → press nothing, erase nothing, alert.
6. Erasing = two frames 300 ms apart both show exactly our text (or, with the box full, its tail) and no dialog (the same rule as T35's echo cleanup), then BSpace in batches of at most 200 (tmux rejects one `send-keys` with ~1500 of them as "command too long"). After each batch the box must show exactly the remaining prefix of our text, or its tail when the box is full (up to 5 frames while CC catches up).
   - Anything else — the owner touched the box — stops with no further key; a dialog stops too.
   - On a stop the pending record keeps the text as it was before the last batch plus that batch's size, because some of those keys may have gone to the dialog. The next tick accepts any prefix of that text within the batch-size range, and erases what the box really holds. If several lengths match (repeated text in a cut-off box), it erases nothing.

### Fitting the input box (`lib/ctx-boundary-fit.ts`)

CC's input box shows at most `max(3, ⌊height/2⌋ − 5)` rows (12–60 rows high) and `width − 4` columns per row (16–200 wide), measured on CC 2.1.283 in a private tmux. A longer text shows only its last rows, and the first shown row still starts with `❯`, so a truncated box cannot be told from a short one except by its row count.

- The row count is estimated by replaying wrap-ansi (hard, trim, word wrap; CJK counts 2 columns). It matched CC row for row from 16 to 120 columns, except once at 24 columns where CC used one more row, so a command must fit with one row to spare.
- A single-row command only needs a free column for the cursor.
- Examples: the default list (186 characters) fits from 80×24 up but not at 40×24. An 800-character all-CJK list needs 120×40; smaller windows fall back to the default list, which is why the 800 cap stays.
- The window size is read with the pane capture. `ctx-boundary dry-run` prints the command each agent would get at its current size, the fallback, or the skip.

The box text comes from `lp-state` (`inputText`), which treats U+00A0 as a plain space: real CC draws the prompt as `❯` + NBSP, and T35 compares its own echo character by character.

Every tmux call here uses `tmuxRawStrict`, so a window that vanished between capture and send is a failure (retried after 5 minutes), not a fake "sent".
- Display calls resolve the policies once per 2 s (one `/api/v1/agents` request or one embed render reads the config once).

## Display

- Discord stats embed: the dot follows the boundary (🟢 below / 🟡 past the line / 🔴 past the hard cap), each agent gets `🧭 <policy> <line> 余/超 N · 上限 M`, config warnings are listed at the top.
- `GET /api/v1/agents` carries `ctxBoundary` (`policy`, `window`, `hardCap`, `remaining`, `level`, `warnings`). The web agent list tints and labels rows that hit a named policy; the usage panel shows every Claude Code session's boundary.
