# Coordinator launch slimming (agents-PMSLIM1)

Code: `src/lib/pm-slim.ts`. Tests: `tests/pm-slim.test.ts`. Policy fields: `src/lib/ctx-boundary-policy.ts` (see also [context-boundary.md](context-boundary.md)).

## Why

Measured on the owner's machine (10-11): the resident PM session (`coordinator` policy) used about 92% of the week's cache reads. Its context averaged 196K after the 250K hard line, and settled back to about 114K after each compaction. Two costs can be cut without changing what the PM does:

1. **Tool definitions loaded at every request.** Coordinators never use the browser (`playwright`) or the web-search (`tavily`) MCP servers, but their tool schemas ride along in every request.
2. **`/save-compact` on every compaction.** It rewrites HANDOFF each time and costs a full extra turn. A `/compact <keep list>` keeps the same facts in the summary. The PM now writes HANDOFF itself when state actually changes. That is a PM habit, not code.

## Switch

`<state dir>/pm-slim.json`, read with `lib/state-file`:

```json
{ "mode": "observe" }
```

| mode | launch command / `--settings` | compaction injected by the bridge | state written |
|---|---|---|---|
| `off` | byte-for-byte unchanged | unchanged (`/save-compact`) | launch record (mode `off`) |
| `observe` (default when the file is missing) | byte-for-byte unchanged | unchanged | launch record with candidates |
| `on` | candidates merged into the agent's own `--settings` | `/compact <keep list>` | launch record (mode `on`) |

If the file can't be parsed, isn't an object, or has an unknown `mode`, the mode is `off`. A short diagnostic goes to stderr and into the record's `reasons`; the file contents are never echoed. If anything throws while the plan is computed, the plan is dropped (treated as `off`), no record is written, and one diagnostic line is logged. There is no recovery key.

## Who is a coordinator

The same policy table as the context boundary: `resolvePolicies(config.autoCompact.policies)` + `matchPolicy({ name, projectId })`, with `projectId` from the registry. The matched policy's id must be `coordinator`. To add a session, extend the `coordinator` entry's `match` in config.json; no agent name is hard-coded. These are always excluded:

- executors: `isExecutor` means the name is `agent-task-*` or the cwd is a linked worktree. The worktree check needs `spec.cwd`, which some launch paths do not pass; executors are still excluded by name there.
- Codex / Pi: their adapters don't go through `claudeLaunchOptions`.
- lend workers: `buildLendClaudeCommand`.
- the master: `launcher.ts` calls `buildClaudeCommand` directly, and the policy matcher only matches the master by its literal name.

## What `on` changes

### Settings

`ccLaunchSettings` (`autoCompactWindow`) and `ccDeny` are merged into the agent's own launch settings (`launchSettingsFor`). Only one `--settings` is passed, including in the sandbox, where `sandboxLaunchArgs` folds it into the same object.

- `autoCompactWindow` = policy `ccWindow` (built-in coordinator: 300000). It is Claude Code's native auto-compact trigger. CC compacts at about `window − 33K`, so about 267K here, which is above the coordinator `hardCap` of 250K. The bridge's step with a keep list therefore fires first, and native compaction backs up long turns mid-turn. **It is a trigger, not a per-request hard cap.** CC 2.1.296 ships the setting (`autoCompactWindow`, "Auto-compact window"; env `CLAUDE_CODE_AUTO_COMPACT_WINDOW`). The PM checks its effect against version evidence; synthetic tests only check the string.
- `permissions.deny` = existing deny rules first, then policy `ccDeny` (built-in coordinator: `["mcp__playwright", "mcp__tavily"]`), de-duplicated. Other `permissions` keys and every other settings key are kept.
- **Not** `--strict-mcp-config` / `--mcp-config`. User MCP server definitions are never read or copied, so the claudestra channel, caller-credential isolation and mem0 are untouched. Whether a deny rule also drops the tool definitions from context is for the PM to measure after rollout.

### Compaction action

`bridge/ctx-boundary.ts` `boundaryFor` passes the effective action through `pmSlimAction`. It turns `save-compact` into `compact` only when all of these hold:

- the matched policy is `coordinator`,
- the agent's **last launch record** says `mode: "on"` and its `session` matches the bridge's current session id (`null` for a fork, whose new id is unknown at launch; a record without `session` is ignored).

The bridge then reuses `compactCommand` with the policy `keep` (or `DEFAULT_KEEP_LIST`). Thresholds, the 15-minute guard, draft protection, window fitting and injection-failure handling are all unchanged. Executors and other policies are untouched.

## When it takes effect

At the next launch only: new, resume, fork and restart all go through `claudeLaunchOptions`. Flipping the switch never restarts a working PM. Because the bridge reads the per-agent launch record, not the switch file, a session started under `observe` keeps `/save-compact` until it is restarted.

The target is the registry name: `settingsName`, else `agentName`, else `agent-<displayName>` (a first-time resume / fork under a new name carries neither name; the manager's display name is the tmux name without the prefix). This only identifies the target; the command's self-name and settings-file semantics are unchanged.

Project matching uses the registry row's `projectId`. A first-time resume / fork has no registry row yet (the manager writes it only after a successful launch), so the target's project falls back to the launch `cwd`, resolved read-only with the same rules as the manager's `resolveOrCreateProject` (`resolveProjectForDirOrMain`, then `projectFromAssignments`). The manager writes any newly created project to `projects.json` before launching, so the read-only lookup sees it.

Config read failure means off: `pm-slim.json` unreadable, or `config.json` corrupt (`readConfigSync` would hand back the last good copy or safe defaults, so the launch checks `isConfigCorrupt` first and refuses).

## Launch record

`<state dir>/pm-slim/<agent>.json`, rewritten at every coordinator launch and **deleted** at any launch that does not slim (no coordinator match, config read failure, or the record cannot be written — the last case also drops the plan, so settings and injection fall back to baseline together):

```json
{ "at": "…", "session": "<session id>", "mode": "observe", "policy": "coordinator", "deny": ["mcp__playwright", "mcp__tavily"],
  "autoCompactWindow": 300000, "action": "compact", "keep": "default", "reasons": ["…"] }
```

It holds only tool-group names, the window, the action, whether the keep list comes from the policy or the default, and reasons. It contains no MCP server definitions, credentials, or keep-list text.

## Config fields

| field | type | bad value |
|---|---|---|
| `ccDeny` | non-empty string array; `null` = exclude nothing | non-array or non-string item → field ignored (inherits the built-in), one warning without the value |
| `ccWindow` | integer 100K–1M; `null` = don't pass it | ignored (no `autoCompactWindow`), one warning without the value |

Built-in `coordinator` defaults changed in this card (independent of the switch): window 180K, hardCap 250K, ccWindow 300K, ccDeny as above. The owner's machine already overrides window and hardCap to the same values.

## Post-rollout (PM)

1. Run in `observe` first. Check the candidate tool groups, window and compaction command in `pm-slim/<agent>.json`, and fill in the pending evidence.
2. Switch to `on`. At the next natural restart, compare tool-definition overhead and the post-compaction floor with PMCOST1, and record whether any `/save-compact` was still injected.
