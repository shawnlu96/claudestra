# Context boundaries: per-role compaction lines

Every turn re-reads the whole context (cache reads still count against the plan), so an executor sitting at 600K costs about ten times what it costs at 60K per turn. Context boundaries put a ceiling on task agents without touching the owner's long personal conversations. Code: `src/lib/ctx-boundary-policy.ts` (pure: config, matching, decision table, display), `src/bridge/ctx-boundary.ts` (the per-minute runner and the one injection entry point). Tests: `tests/ctx-boundary-policy.test.ts`, `tests/ctx-boundary.test.ts`, `tests/web-ctx-boundary-view.test.ts`.

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
- Fields: `match.projects` (project ids) / `match.names` (glob, `*` and `?`), `window`, `idleMinutes`, `hardCap` (≥ window), `action` (`compact` | `save-compact`), `ccWindow` (100K–1M or omitted), `keep` (one line; replaces the default keep list).
- Matching priority: a policy with both projects **and** names (both must hit) > projects only > names only; ties go to the first in the list. The master session is only matched by the literal name `master`, never by a wildcard.
- `config-store` keeps `policies` verbatim; validation happens in the resolver so a hand-written mistake is reported, not erased by the next settings save.
- Agents that match no policy use the global `window` / `idleHours` / `emergency` exactly as before (85% / 93% of the real window when statusline reports it).

## Executors never get `/save-compact`

An executor runs in a git worktree, but Claude Code resolves its auto-memory directory to the **main** checkout (`~/.claude/projects/-Users-…-claude-orchestrator/memory/`), the same one the PM uses. `/save-compact` writes `HANDOFF.md` there, so an executor's save-compact overwrites the PM's hand-off (observed 2026-09-29 01:49). Therefore:

- `effectiveAction(name, action)`: for `agent-task-*` a `save-compact` becomes `compact` with the keep list — whatever the policy says, and on the global fallback too. Every injection path applies it (the runner, the Discord "save + compact" button, `injectCompact` callers that pass `agentName`).
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
7. a queued message already waiting → skip (don't stack a second compaction)
8. at/over `hardCap` → inject (queued if busy)
9. over `window` and idle → inject
10. otherwise (busy) → wait

"Idle" = the last real conversation record is at least `idleMinutes` old **and** the pane shows no spinner / background work. File mtime is not used: CC touches session files on its own.

Pane facts (`wall`, `lp`, `menu`, `compacting`) come from `paneQuotaState` in `src/lib/lp-state.ts` (T35).

## Runner

- `startCtxBoundary()` runs once a minute from `bridge.ts`, in Discord and web-only mode alike (it used to live in the Discord stats dashboard, so web-only installs and the sandbox never auto-compacted).
- Claude Code agents only (the injected commands and pane parsing are CC's). Master is not in the registry and is not covered.
- Only agents over a line get their pane captured. Skips are logged once per reason change; injections always.
- `injectCompact(target, {action, keep})` is the single entry for every compaction injection (auto, the Discord "save + compact" button, T35's fan-out). It returns `executed` / `queued` / `skipped` (with a readable reason) / `failed`.

## Display

- Discord stats embed: the dot follows the boundary (🟢 below / 🟡 past the line / 🔴 past the hard cap), each agent gets `🧭 <policy> <line> 余/超 N · 上限 M`, config warnings are listed at the top.
- `GET /api/v1/agents` carries `ctxBoundary` (`policy`, `window`, `hardCap`, `remaining`, `level`, `warnings`). The web agent list tints and labels rows that hit a named policy; the usage panel shows every Claude Code session's boundary.
