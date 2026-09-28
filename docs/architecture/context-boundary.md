# Context boundaries: per-role compaction lines

Every turn re-reads the whole context (cache reads still count against the plan), so an executor sitting at 600K costs about ten times what it costs at 60K per turn. Context boundaries put a ceiling on task agents without touching the owner's long personal conversations. Code: `src/lib/ctx-boundary-policy.ts` (pure: config, matching, executor rule), `src/lib/ctx-boundary-decision.ts` (pure: which line applies, decision table, display), `src/bridge/ctx-boundary.ts` (the per-minute runner and the one injection entry point). Tests: `tests/ctx-boundary-policy.test.ts`, `tests/ctx-boundary.test.ts`, `tests/web-ctx-boundary-view.test.ts`.

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
- Fields: `match.projects` (project ids) / `match.names` (glob, `*` and `?`), `window`, `idleMinutes`, `hardCap` (≥ window), `action` (`compact` | `save-compact`), `ccWindow` (100K–1M or omitted), `keep` (one line; replaces the default keep list).
- Matching priority: a policy with both projects **and** names (both must hit) > projects only > names only; ties go to the first in the list. The master session is only matched by the literal name `master`, never by a wildcard.
- `config-store` keeps `policies` verbatim; validation happens in the resolver so a hand-written mistake is reported, not erased by the next settings save.
- Agents that match no policy use the global `window` / `idleHours` / `emergency` exactly as before (85% / 93% of the real window when statusline reports it).

## Executors never get `/save-compact`

An executor runs in a git worktree, but Claude Code resolves its auto-memory directory to the **main** checkout (`~/.claude/projects/-Users-…-claude-orchestrator/memory/`), the same one the PM uses. `/save-compact` writes `HANDOFF.md` there, so an executor's save-compact overwrites the PM's hand-off (observed 2026-09-29 01:49). Therefore:

- "Executor" = the name is `agent-task-*` **or** the working directory is a linked git worktree (`.git` is a file). The worktree test is the root cause itself, so a renamed worktree agent is covered. Registry `parent` / `task` are deliberately not used: the PM's dispatch assistant carries both but runs in the ledger directory with its own memory, and needs `save-compact` for its HANDOFF.
- `effectiveAction(executor, action)`: for an executor a `save-compact` becomes `compact` with the keep list — whatever the policy says, and on the global fallback too. `injectCompact` takes an `InjectTarget` that carries the executor flag (build one with `injectTargetFor(name)`), so no caller can skip the rule.
- The resolver warns when a `save-compact` policy could reach executors: a name pattern whose literal prefix overlaps `agent-task-` (`agent-*`, `*`, `agent-task-t36`), or a project-only policy.
- Unmatched personal agents keep `save-compact`: each lives in its own repository, so their memory directories don't collide.

## Decision table (`boundaryDecision`)

First match wins:

1. below both lines → nothing
2. compacting (pane shows it, or anything injected a compaction in the last 15 min) → skip
3. injected less than 30 min ago and still above the line → skip (injections can be swallowed; retry after 30 min)
4. pane unreadable → skip (never type blind)
5. quota wall and low-priority not on → skip, **without** starting the retry timer
6. a selection menu on screen → skip (the quota-wall menu's option 3 buys usage credits; a digit in the keep list could pick it)
7. text in the input box → skip, **even past the hard cap**. `tmux send-keys` types literally and presses Enter, so a half-typed owner message would be submitted glued to `/compact …` (reproduced in a private tmux)
8. a queued message already waiting → skip (don't stack a second compaction)
9. at/over `hardCap` → inject (queued if busy)
10. over `window` and idle → inject
11. otherwise (busy) → wait

Step 5 also covers "low-priority allowance exhausted" (`exhausted`). A failed send (window gone, tmux error) keeps the error text in the log, records no injection guard, and retries after 5 minutes instead of 30.

"Idle" = the last real conversation record is at least `idleMinutes` old **and** the pane shows no spinner / background work (CC touches session files on its own, so mtime alone is unreliable, and a long tool call leaves it untouched). The global path (personal agents) additionally keeps the old condition — session-file mtime at least `idleHours` old — so personal agents are compacted no more often than before; named policies use only the new definition.

### Pane gate (`lp-state`)

Pane facts come from `paneQuotaState(plain, escaped)` in `src/lib/lp-state.ts` — one function shared with T35's fleet actions — on **one** `capture-pane -p -e` (`plain` is its `stripAnsi`; two separate captures disagreed 15 times in 200 while the screen was changing). The gate blocks on `wall` (walled, or the quota menu open) unless low-priority is on, `exhausted`, `menu` (no input box — quota menu, permission prompt, AUQ, Rewind, model / effort confirm, bypass first-run — or a box that is really a dialog: numbered options, `Esc to cancel` / `Enter to select`), `compacting`, and `draft`: anything in the box that is not provably empty — a draft, queued messages, bash mode (`!` prompt; `/compact` would run as a shell command, so it counts even when empty), or a box it cannot read (a plain capture without colours). The box and the `❯` prompt are recognised only at column 0, so indented look-alikes in the conversation, tool output or code blocks are never taken for the input box; CC caps the box at 7 visible lines and scrolls, so long drafts are still recognised. Named policies, the global path and the Discord "save + compact" button all go through it (`CtxBoundaryDeps.gateGlobal` stays as a switch for tests and rollback). An unreadable pane (window gone — capture uses `tmuxRawStrict`, an empty capture counts as unreadable) is never typed into: tmux `send-keys` to a missing window does not fail, so it would only report a fake "sent". Samples: `tests/fixtures/lp/` (`input-*` real CC 2.1.283 input boxes incl. bash mode, long and ruled drafts; `modal-*` real dialogs).

Why `-e`: in a plain capture an empty input box still shows CC's grey suggestion (`❯ Try "write a test for <filepath>"`); only the `ESC[2m` in the escaped capture tells it apart from a real draft (`❯ owner half typed msg`). A multi-line draft continues on indented lines inside the box.

### Global path vs. the old code

Where the global path is not identical to the old stats-dashboard code:

- **Scope**: the old code ran only in Discord mode and only for agents with a `channelId`. The runner covers every active Claude Code agent, including agents without a channel and web-only installs, which get automatic compaction for the first time (defaults 400K / 3 h unless configured).
- **Executor rule**: a personal agent whose working directory is a linked worktree or a git submodule (both have a `.git` file) is treated as an executor and gets `/compact` with the keep list instead of `/save-compact`.
- **Idle**: both the new and the old condition must hold, so it fires no more often than before (review r2 compared 3024 cases: every difference was "old fires, new waits").

## Runner

- `startCtxBoundary()` runs once a minute from `bridge.ts`, in Discord and web-only mode alike (it used to live in the Discord stats dashboard, so web-only installs and the sandbox never auto-compacted).
- Claude Code agents only (the injected commands and pane parsing are CC's). Master is not in the registry and is not covered.
- Only agents over a line get their pane captured. Skips are logged once per reason change; injections always.
- `injectCompact(injectTarget, {action, keep})` is the single entry for every compaction injection (auto, the Discord "save + compact" button, T35's fan-out). It returns `executed` / `queued` / `skipped` (with a readable reason) / `failed`, and records the injection guard only after a successful send.
- Display calls resolve the policies once per 2 s (one `/api/v1/agents` request or one embed render reads the config once).

## Display

- Discord stats embed: the dot follows the boundary (🟢 below / 🟡 past the line / 🔴 past the hard cap), each agent gets `🧭 <policy> <line> 余/超 N · 上限 M`, config warnings are listed at the top.
- `GET /api/v1/agents` carries `ctxBoundary` (`policy`, `window`, `hardCap`, `remaining`, `level`, `warnings`). The web agent list tints and labels rows that hit a named policy; the usage panel shows every Claude Code session's boundary.
