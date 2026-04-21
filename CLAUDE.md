# Claudestra — Architecture

**English** · [简体中文](./CLAUDE.zh-CN.md)

This document describes Claudestra's internal architecture and is intended for contributors, agents modifying the codebase, and anyone debugging production issues. New users should start with [SETUP.md](./SETUP.md) instead.

## System overview

Claudestra is a multi-session orchestrator built on top of Claude Code's native **Channel protocol** (an MCP extension). A single Bridge process fans out one Discord bot token across many Claude Code sessions by registering each one as an independent channel listener.

```
 Discord (one bot, one token)
        │
        ▼
 Bridge  ── bridge.ts, pm2-managed, ws://localhost:3847
        │
        ├── WebSocket routing            ├── JSONL watcher                ├── HTTP hooks
        │                                │                                │
        │   channel → master             │   tool call → Discord          │   Stop       → stop typing
        │   channel → agent A            │   claude text → Discord        │   Notification → fallback
        │   channel → agent B            │   merged + debounced           │   30min safety timeout
        │   ...                          │                                │
```

**Message flow:**

- **Inbound** — Discord → Bridge → channel-server (MCP) → Claude Code session.
- **Outbound** — Claude Code `reply` tool → channel-server → Bridge → Discord.
- **Streaming tool calls** — Claude Code writes JSONL → jsonl-watcher tails the file → Bridge pushes formatted tool summaries to Discord.

Each Claude Code session has its own `channel-server` subprocess running as a stdio MCP server. The channel-server speaks MCP to Claude Code on one side and a lightweight WebSocket protocol to the Bridge on the other.

## Project layout

```
src/
  bridge.ts              Main entry: Discord client, WebSocket server, event dispatcher, slash commands
  bridge/
    config.ts            Shared runtime constants
    components.ts        Discord UI components + typing indicators
    discord-api.ts       Discord API wrappers (create/delete channel, edit message, etc.)
    management.ts        Admin button/select handlers that bypass the LLM
    screenshot.ts        Terminal screenshot pipeline (ANSI → HTML → PNG)
    jsonl-watcher.ts     JSONL session tailer → streaming tool summaries
    slash-catalog.ts     Hardcoded list of CC built-in slash commands (Discord-friendly subset)
    slash-registry.ts    Runtime registry of discovered skills per scope + per-channel resolver
    wedge-watcher.ts     Detects agents stuck >30min with no pane change + not idle → Discord alert
  channel-server.ts      Per-session MCP proxy (stdio MCP ↔ Bridge WebSocket)
  manager.ts             Agent lifecycle + cron + version/update CLI (JSON output)
  cron.ts                Cron scheduler daemon (pm2-managed)
  launcher.ts            Master tmux session guardian (pm2-managed)
  setup.ts               Interactive installation wizard
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → Bridge HTTP endpoint
  lib/
    bridge-client.ts     Shared Bridge WebSocket request helper
    tmux-helper.ts       Shared tmux command wrappers (tmuxRaw, isIdle, sendLine, …)
    claude-launch.ts     Unified Claude Code launch-command builder (flags, MCP_NAME, shell escaping)
    config-store.ts      Runtime config at ~/.claude-orchestrator/config.json (auto-update toggles)
    skills.ts            SKILL.md discovery — user / plugin / project sources + hardcoded natives
    jsonl-cost.ts        Parse ~/.claude/projects JSONL files → per-model token rollup
  ansi2html.ts           ANSI escape codes → coloured HTML
  html2png.ts            HTML → PNG via Playwright headless Chromium
  discord-reply.ts       Bash fallback: send a message through the Bridge directly
master/
  CLAUDE.md.template     Master agent instruction template (rendered by setup.ts)
  CLAUDE.md              Rendered local copy (git-ignored)
tests/
  cron.test.ts           Cron parser + scheduler test suite (46 cases)
install.sh               One-line installer
SETUP.md                 User-facing installation guide
```

## Features

- **Multi-agent orchestration** — create, resume, kill, restart, list, browse history.
- **Agent-to-agent messaging** — `send_to_agent(target, text)` MCP tool injects messages directly into another agent's context via the Bridge.
- **Cron scheduling** — cron expressions spin up a temporary agent, run a prompt, report, and clean up.
- **Discord UI** — buttons, select menus, slash commands (`/status`, `/screenshot`, `/interrupt`, `/cron`).
- **LLM-free admin buttons** — status, peek, kill, restart, and cron actions execute directly on the Bridge for instant response with zero token cost.
- **Streaming tool output** — jsonl-watcher pushes `Read · Edit · Write · Bash · Grep` calls to Discord in near real-time.
- **Terminal screenshots** — ANSI-to-PNG pipeline lets you peek at a locked screen.
- **One-click interrupt** — Discord button sends `Ctrl+C` to the target agent's tmux window.
- **Idle detection** — Claude Code `Stop` / `Notification` hooks drive Discord typing indicators precisely; a 30-minute safety timeout catches edge cases.
- **Master guardian** — pm2-managed launcher keeps the master tmux session alive and auto-dismisses Claude Code confirmation prompts.
- **Safety rails** — `--disallowedTools` blocks `rm -rf`, `git push --force`, `git reset --hard`, `chmod 777`, and other destructive commands for every spawned agent.
- **Discord slash autocomplete for skills + built-ins** — on startup, the Bridge discovers every available slash command from four sources (user-level `~/.claude/skills/`, installed plugins in `~/.claude/plugins/cache/…`, per-agent `<cwd>/.claude/skills/`, and a curated set of Claude Code built-ins like `/cost`, `/mcp`, `/context`, `/compact`) and registers them as Discord slash commands. Invocations are re-scanned on every `manager.ts create|resume|kill|restart` via the `/skills/rescan` HTTP endpoint. When a user types a registered `/cmd args` in Discord, the bridge forwards the literal text to the channel's agent via `tmux send-keys`, so Claude Code interprets it natively. Project-level skills are filtered: typing a skill that only exists in another agent's cwd yields an ephemeral explanation instead of going through.

### Cross-Claudestra peer collaboration

Peers (other Claudestra installs running the same upstream) can share their specialist agents without giving each other SSH / filesystem access. The model evolved significantly in the v1.9.x line; this is the current state as of v1.9.26.

- **Shared `#agent-exchange` channel** — when a peer bot joins your guild, bridge auto-creates a `#agent-exchange` channel and scopes the peer bot to that single channel (View/Send on `#agent-exchange`, Deny View on everything else). All cross-peer communication flows through these shared channels. Broadcast notifications (exposure grant/revoke, hello) travel here as HTML-comment-encoded `PeerEvent` markers that both bridges parse.
- **Explicit exposure model** — `bun src/manager.ts peer-expose <agent> <peer|all> --purpose "..."` selectively opens one of your local agents to a specific peer bot. Stored in `~/.claude-orchestrator/peers.json`. Peer's bridge learns capabilities from the broadcast and caches in its own `peers.json`.
- **Direct-mode routing (v1.9.21+, default for new exposures)** — peer sends a request to `#agent-exchange`; your bridge looks up `exposures[peer].mode === "direct"` and **injects the message straight into the target agent's WebSocket**, bypassing your master. Agent replies directly to `#agent-exchange` `@ peer-bot`. 6-hop old chain becomes 2-3 hops; both masters drop out of the happy path. Fallback mode `via_master` (the old v1.8–v1.9.0 behavior) is still available via `--mode via_master` for scenarios that need LLM-driven routing.
- **Symmetric routing (v1.9.22+)** — you `@peer-bot` in `#agent-exchange`: bridge detects you're not `@`-ing our bot, skips forwarding to our master. Peer's bridge receives the event on the foreign `#agent-exchange` and applies the same direct-routing logic on their side. Completes the picture so both directions are fast.
- **Multi-candidate disambiguation (v1.9.26+)** — if several direct exposures match the peer bot, bridge first tries keyword matching (C: agent name mentioned in message body ⇒ unique match ⇒ route). No unique match ⇒ Discord buttons posted in-channel; user clicks one (D: zero LLM turn, zero master participation).
- **Cross-peer `send_to_agent`** — agents call `send_to_agent({ target: "peer:<peer_bot_name>.<agent_name>" })` or short `target: "<agent>@<peer>"` to invoke a peer agent. Bridge posts to shared `#agent-exchange` `@ peer bot` and registers a pending-peer-call; peer's reply is push-delivered back to the caller's ws as a synthetic `[🤖 peer X/Y 回复] ...` user message (replacing old fetch-message polling).
- **Trust model** — simplified "trust transfer": once you `peer-expose` an agent to a peer bot, that peer's humans (who are already in peer's `#agent-exchange`) are trusted transitively. No allowlist sync needed; the peer's channel membership IS the trust boundary.
- **Push-back replaces polling (v1.9.21+)** — bridge's `route_to_agent` (local) and `handlePeerRouteToAgent` (cross-peer) both record `pendingAgentCalls` / `pendingPeerCalls`. When target posts their reply, bridge synthesizes an internal "message" event to the caller's ws. Callers simply `end_turn` and wait for the synthesized user message, no `fetch_messages` loop needed.
- **Reply rescue (v1.9.21+, refined through v1.9.25)** — every Discord-inbound message sets a pending entry keyed by channel. If the target Claude Code session ends its turn (Stop hook) without having called `reply()`, the bridge reads that session's JSONL, extracts the latest assistant-text output, and posts it to Discord on the agent's behalf (footer `_📋 [bridge 兜底] …_`). No NAG injection (the v1.9.20 NAG concept was removed — it polluted context and frequently misfired). Only runs on `Stop`/`StopFailure`, not on `Notification`, to prevent duplicate posts.
- **`[EOT]` end-of-thread marker** — agent appends `[EOT]` to its final reply when closing a conversation; receiving bridge drops rather than forwards, preventing two bots from ack-looping in `#agent-exchange`.

## Runtime commands

```bash
# First-time setup: collect Discord config, write .env, render master/CLAUDE.md
bun run setup

# Start everything (bridge + launcher + cron-scheduler)
pm2 start ecosystem.config.cjs

# Agent lifecycle
bun src/manager.ts create   <name> <dir> [purpose]
bun src/manager.ts resume   <name> <sessionId> [dir]
bun src/manager.ts kill     <name>
bun src/manager.ts restart  [name]
bun src/manager.ts list
bun src/manager.ts sessions [search]

# Cron jobs
bun src/manager.ts cron-add     <name> "<cron>" <dir> <prompt...>
bun src/manager.ts cron-list
bun src/manager.ts cron-remove  <name|id>
bun src/manager.ts cron-toggle  <name|id>
bun src/manager.ts cron-history [name|id]

# Cross-Claudestra peer collaboration (v1.9+)
bun src/manager.ts peer-status                                             # list peer bots + exposures + capabilities
bun src/manager.ts peer-expose <agent> <peer|all> --purpose "..."          # default mode=direct (bridge-level routing)
bun src/manager.ts peer-expose <agent> <peer> --mode via_master --purpose "..." # legacy: route through master
bun src/manager.ts peer-revoke <agent> <peer|all>                          # revoke an exposure
bun src/manager.ts invite-link --peer                                      # generate minimum-permission OAuth URL for peer

# Versioning
bun src/manager.ts version   # current version + whether an update is available
bun src/manager.ts update    # git pull + pm2 restart ecosystem.config.cjs (only Claudestra's 3 processes)

# Auto-update toggles (both default on; launcher polls on a schedule and only upgrades when all agents are idle)
bun src/manager.ts auto-update status
bun src/manager.ts auto-update claudestra on|off   # Claudestra self-update (30 min poll)
bun src/manager.ts auto-update claude on|off       # Claude Code CLI (weekly poll)

# Token usage aggregation (parses ~/.claude/projects/<slug>/<sessionId>.jsonl)
bun src/manager.ts cost [--agent <name>] [--today|--week]

# Tests
bun test
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord server (guild) ID |
| `ALLOWED_USER_IDS` | Comma-separated Discord user IDs allowed to talk to the bot |
| `CONTROL_CHANNEL_ID` | Control channel ID for the master orchestrator |
| `BRIDGE_PORT` | WebSocket port (default `3847`) |
| `MCP_NAME` | MCP server name used by `claude mcp add` (default `claudestra`) |
| `USER_NAME` | How the master agent addresses the operator in replies |
| `BRIDGE_URL` | Optional override for the channel-server's WebSocket target |
| `MASTER_DIR` | Optional override for the master tmux session's working directory |

## tmux topology

Every agent is a **window** inside the single `master` session. This lets `tmux -CC attach` present each agent as an iTerm2 native tab.

```
master (session, private socket at /tmp/claude-orchestrator/master.sock)
  ├── window 0: master orchestrator (the "大总管")
  ├── worker-alpha
  ├── worker-bravo
  └── worker-...
```

Attach locally:

```bash
tmux -S /tmp/claude-orchestrator/master.sock -CC attach
```

## Key invariants

- The master orchestrator is window 0 of the `master` tmux session. `master-launcher` (pm2) guarantees it exists and is running Claude Code.
- Every agent's Discord channel ID is recorded in `~/.claude-orchestrator/registry.json`. The Bridge uses this registry to route incoming Discord messages to the correct channel-server.
- The MCP server name (`MCP_NAME`) must match between `claude mcp add`, the channel-server's registration, and the JSONL watcher's tool-filter prefix. It is centralised in `src/bridge/config.ts` and `src/lib/claude-launch.ts`.
- Agent names are validated against a shell-metacharacter blocklist on create/resume but loosely normalised on kill/restart to keep historical CJK names working.
- Tool call display is debounced through `WATCHER_CONFIG.debounceMs` (default 1500 ms) to avoid Discord rate limits during bursty tool sequences.

## Contributing tips

- **Release process**: commits and `git push` to `main` are fine to do autonomously. Creating a `git tag v*` and a GitHub Release (`gh release create`) requires **explicit owner approval** every time — never tag-and-release on your own initiative.
- **Version bump rules** (owner-mandated, refined 2026-04-20 starting v1.7.0):
  - **Patch** (`x.y.Z`) — bug fixes, small enhancements, extra CLI subcommands, refactors, tests, docs, UI polish. Most changes land here. If the bump is specifically a bug fix, also **delete the buggy release** via `gh release delete <tag> --yes --cleanup-tag` so the Releases list contains no broken versions. Polish/small-feature patches don't delete the previous version.
  - **Minor** (`x.Y.0`) — genuinely new user-facing capability that deserves a one-line "现在你可以 ..." headline. Examples: v1.3.0 Claude Code auto-update, v1.5.0 Discord slash autocomplete. Older minors are kept as history.
  - **Major** (`X.0.0`) — breaking change or system-level rearchitecture. Owner bumps these manually; never bump major on your own initiative.
  - Heuristic: if you're writing release notes and catch yourself opening with "修了..." / "加了个..." / "补了测试" / "重构了..." — that's a **patch**. Only headline-worthy new capability = minor.
- `tmux-helper.ts` and `claude-launch.ts` are the canonical places for tmux commands and Claude Code launch flags. Don't inline these in new files.
- Admin buttons that should skip the LLM go in `bridge/management.ts`. Add the `id` to both `handleMgmtButton` and the relevant panel builder.
- Before shipping, run `bun test` and `bun build src/<entry>.ts --target=bun` for each entry point (`bridge`, `channel-server`, `manager`, `launcher`, `cron`, `setup`) to catch type errors quickly.
- The cron test suite exercises the parser and next-run computation but does not run real agents — integration testing happens in a sandbox Discord server.
