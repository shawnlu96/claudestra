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
        ├── deliver(envelope)  ←── v2.0.0 unified routing
        │      ├─ to=local  (ws.send  → channel-server → Claude Code)
        │      ├─ to=peer   (discordReply → shared #agent-exchange)
        │      └─ to=user   (discordReply → user's channel)
        │
        ├── JSONL watcher                ├── HTTP hooks
        │                                │
        │   tool call → Discord          │   Stop     → drain watcher + complete ping
        │   claude text → Discord        │   Notification → stop typing only
        │   merged + debounced           │   30min safety timeout
```

**Message flow (all via `deliver(envelope)` since v2.0.0):**

- **Inbound** — Discord → Bridge's `messageCreate` handler → builds `Envelope{from, to, intent, content, meta}` → `deliver()` → `deliverToLocal` → ws.send to the right Claude Code session.
- **Outbound reply** — Claude Code calls `reply` MCP tool → channel-server → Bridge's `reply` handler → builds response envelope → `deliver()` → `deliverToUser` / `deliverToPeer` → `discordReply` (chunking / reply_to / files / components).
- **Agent↔agent** — `send_to_agent` MCP tool → `route_to_agent` handler → builds local→local envelope → `deliver()` → receiver sees `[🤖 来自 X]` prefix (auto-rendered by `renderContentForLocal`).
- **Streaming tool calls** — Claude Code writes JSONL → `jsonl-watcher` tails + pushes tool summaries (`📖 Read ...`) and assistant text (`💬 ...`) to Discord with 1.5s debounce. On Stop hook, watcher is **drained synchronously** (`drainChannelWatcher`) before marking the status "✅ 完成", so quick one-liners don't get lost between debounce windows.

**Envelope / Endpoint model (`src/bridge/router.ts`):**

Every message is described as `{ from: Endpoint, to: Endpoint, intent, content, meta }`. `Endpoint` is a discriminated union:

- `LocalEndpoint{ kind: "local", channelId, ws, agentName?, cwd? }` — one of our Claude Code sessions
- `PeerEndpoint{ kind: "peer", peerBotId, peerBotName, sharedChannelId }` — another Claudestra bot via shared `#agent-exchange`
- `UserEndpoint{ kind: "user", userId, channelId, username? }` — Discord human

`intent` is `"request" | "response" | "notification" | "broadcast"`. Request envelopes hang a `PendingReply` + `PendingThread` keyed by the reply-back channel / thread id; response envelopes auto-clear those pendings via `inReplyTo` / `threadId` matching. Stop hooks use thread bookkeeping to close residual pendings and log which `thr_*` just ended.

Each Claude Code session has its own `channel-server` subprocess running as a stdio MCP server. The channel-server speaks MCP to Claude Code on one side and a lightweight WebSocket protocol to the Bridge on the other.

## Project layout

```
src/
  bridge.ts              Main entry: Discord client, WebSocket server, deliver() dispatch, slash commands, Stop hooks
  bridge/
    router.ts            v2.0.0+ Envelope/Endpoint types + parseAddress + threadId helpers
    config.ts            Shared runtime constants
    components.ts        Discord UI components + typing indicators
    discord-api.ts       Discord API wrappers: discordReply (chunking / reply_to / files / components), channel CRUD, react, edit
    management.ts        Admin button/select handlers that bypass the LLM
    screenshot.ts        Terminal screenshot pipeline (ANSI → HTML → PNG)
    jsonl-watcher.ts     JSONL session tailer → tool summaries + assistant text stream + drain-on-Stop
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
    peers.ts             peers.json data model + PeerEvent encode/parse + effective mode
  ansi2html.ts           ANSI escape codes → coloured HTML
  html2png.ts            HTML → PNG via Playwright headless Chromium
  discord-reply.ts       Bash fallback: send a message through the Bridge directly
master/
  CLAUDE.md.template     Master agent instruction template (rendered by setup.ts)
  CLAUDE.md              Rendered local copy (git-ignored)
tests/
  cron.test.ts           Cron parser + scheduler test suite
  jsonl-cost.test.ts     JSONL token-usage rollup
  modal-parser.test.ts   Tmux modal detection
  peers.test.ts          v2.0.0+ PeerEvent encode/parse + effectivePeerMode
  router.test.ts         v2.0.0+ Envelope / Endpoint / parseAddress / makeResponseEnvelope
  skills.test.ts         SKILL.md discovery
  slash-registry.test.ts Slash command registry per-channel resolution
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
- **No-reply fallback (v1.9.37+, replaces the old rescue)** — if the agent ends its turn without calling `reply()`, the `jsonl-watcher` has already been streaming any assistant text to Discord as `💬 ...` (debounced 1.5s). On Stop hook, the Bridge synchronously **drains** that watcher (`drainChannelWatcher`): immediately re-polls the jsonl, cancels the debounce timer, and force-flushes the textQueue before marking the status "✅ 完成". The earlier v1.9.21–v1.9.36 "bridge rescue" mechanism (extract text from jsonl + re-post with `[bridge 兜底]` footer) was removed in 1.9.37 because it duplicated whatever the watcher already streamed — they both read the same jsonl and would each post the same text. Rate-limit messages (`You've hit your limit`) are tagged with `⛔` instead of `💬` and the paired `turn_duration` is suppressed so it doesn't look like real thinking time.
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
- **Message routing (v2.0.0+)**: every message-semantic bridge operation (inbound to agent / outbound reply / agent→agent forward / pushback from cross-peer calls / peer-direct and symmetric routes) constructs an `Envelope` and calls `deliver(env)`. The only direct `ws.send({type:"message"...})` / `channel.send({content})` calls outside `deliver` are **UI-class** side effects: the "💭 Thinking" status message with the Interrupt button, LLM-free admin button replies, `notifyMaster` broadcasts, `PeerEvent` announcements, peer→local relay fallback in `tryRouteForeignAgentExchange`, and hook-event text notifications. Everything that an agent ends up seeing in its MCP `<channel>` tag goes through `deliver` → `renderContentForLocal`.
- **`channel-server` reconnect (v1.9.36+)**: on WebSocket close, the channel-server only exits when the bridge sends an explicit "replaced" signal (another connection took over the same channel). Plain `code 1000` (bridge restart) is treated as a transient disconnect and triggers exponential-backoff reconnect, so `pm2 restart discord-bridge` no longer orphans every agent's MCP connection.

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
- Test suite (`bun test`) currently exercises pure logic (cron parser, JSONL cost rollup, tmux modal parser, peers.ts encode/parse, router.ts envelope helpers, skills discovery, slash-registry). `bridge.ts` itself has no isolated unit tests because of its Discord-client + ws + peers.json coupling — live verification through a second Claude Code session in a sandbox Discord server is the coverage there.
- New outbound Discord messages (reply, notification, forward) should build an `Envelope` and call `deliver()` rather than calling `discordReply` / `channel.send` directly. `renderContentForLocal` + `renderPeerDirectHeader` + `renderAgentExchangeToMasterHeader` centralise header rendering; don't hand-inject headers in call sites.
