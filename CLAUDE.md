# Claudestra — Architecture

**English** · [简体中文](./CLAUDE.zh-CN.md)

This document describes Claudestra's internal architecture and is intended for contributors, agents modifying the codebase, and anyone debugging production issues. New users should start with [SETUP.md](./SETUP.md) instead.

## System overview

Claudestra is a multi-session orchestrator built on top of Claude Code's native **Channel protocol** (an MCP extension). A single Bridge process fans out one Discord bot token across many Claude Code sessions by registering each one as an independent channel listener.

```
 Discord (one bot, one token)
        │
        ▼
 Bridge  ── bridge.ts, launchd-managed, ws://localhost:3847
        │
        ├── deliver(envelope)  ←── v2.0.0 unified routing
        │      ├─ to=local  (ws.send  → channel-server → Claude Code)
        │      ├─ to=user   (discordReply → user's channel)
        │      └─ to=api    (resolve HTTP waiter + SSE event)
        │
        ├── JSONL watcher                ├── HTTP hooks
        │                                │
        │   tool call → Discord          │   Stop     → drain watcher + complete ping
        │   claude text → Discord        │   Notification → stop typing only
        │   merged + debounced           │   30min safety timeout
```

**Message flow (all via `deliver(envelope)` since v2.0.0):**

- **Inbound** — Discord → Bridge's `messageCreate` handler → builds `Envelope{from, to, intent, content, meta}` → `deliver()` → `deliverToLocal` → ws.send to the right Claude Code session.
- **Outbound reply** — Claude Code calls `reply` MCP tool → channel-server → Bridge's `reply` handler → builds response envelope → `deliver()` → `deliverToUser` / `deliverToApi` → `discordReply` (chunking / reply_to / files / components) or HTTP-waiter resolution.
- **Agent↔agent** — `send_to_agent` MCP tool → `route_to_agent` handler → builds local→local envelope → `deliver()` → receiver sees `[🤖 来自 X]` prefix (auto-rendered by `renderContentForLocal`).
- **Streaming tool calls** — Claude Code writes JSONL → `jsonl-watcher` tails + pushes tool summaries (`📖 Read ...`) and assistant text (`💬 ...`) to Discord with 1.5s debounce. On Stop hook, watcher is **drained synchronously** (`drainChannelWatcher`) before marking the status "✅ 完成", so quick one-liners don't get lost between debounce windows.

**Envelope / Endpoint model (`src/bridge/router.ts`):**

Every message is described as `{ from: Endpoint, to: Endpoint, intent, content, meta }`. `Endpoint` is a discriminated union:

- `LocalEndpoint{ kind: "local", channelId, ws, agentName?, cwd? }` — one of our Claude Code sessions
- `UserEndpoint{ kind: "user", userId, channelId, username? }` — Discord human
- `ApiUserEndpoint{ kind: "api", tokenId, name, peer? }` — HTTP API user (v2.6.0+; `peer` marks an HTTP peer instance, v2.11+)

`intent` is `"request" | "response" | "notification" | "broadcast"`. Request envelopes hang a `PendingReply` + `PendingThread` keyed by the reply-back channel / thread id; response envelopes auto-clear those pendings via `inReplyTo` / `threadId` matching. Stop hooks use thread bookkeeping to close residual pendings and log which `thr_*` just ended.

Each Claude Code session has its own `channel-server` subprocess running as a stdio MCP server. The channel-server speaks MCP to Claude Code on one side and a lightweight WebSocket protocol to the Bridge on the other.

## Project layout

```
src/
  bridge.ts              Main entry: Discord client, WebSocket server, deliver() dispatch, slash commands, Stop hooks
  bridge/
    router.ts            v2.0.0+ Envelope/Endpoint types + parseAddress + threadId helpers; v2.6.0+ parseChatId (unified transport-prefixed chat_id keyspace) + ApiUserEndpoint
    adapters.ts          v2.6.0+ ChatAdapter interface + registry (NeutralMessage contract); Discord is the first adapter, deliverToUser dispatches by transport
    event-bus.ts         v2.6.0+ in-process event bus (seq + per-agent ring buffer) mirroring tool calls / assistant text / status → SSE
    config.ts            Shared runtime constants
    components.ts        Discord UI components + typing indicators
    discord-api.ts       Discord API wrappers: discordReply (chunking / reply_to / files / components), channel CRUD, react, edit
    management.ts        Admin button/select handlers that bypass the LLM
    screenshot.ts        Terminal screenshot pipeline (ANSI → HTML → PNG)
    jsonl-watcher.ts     JSONL session tailer → tool summaries + assistant text stream + drain-on-Stop
    slash-catalog.ts     Hardcoded list of CC built-in slash commands (Discord-friendly subset)
    slash-registry.ts    Runtime registry of discovered skills per scope + per-channel resolver
    wedge-watcher.ts     Detects agents stuck >30min with no pane change + not idle → Discord alert; v2.7+ link sentinel (window alive but channel-server offline >5min → repair button); v2.14+ the link alert also emits `session_anomaly(kind=link_down)` so web clients see it too — they used to get no signal at all when the MCP link went down
    sessions-inventory.ts v2.7+ neutral machine-wide session inventory: `claude agents --json` + jobs state + registry reconciliation → doppelganger detection
    session-reconciler.ts v2.7+ 10-min bg reconciler: new doppelganger → Discord alert with cleanup/adopt buttons + session_anomaly event
    bg-activity-watcher.ts v2.8+ bg activity tracker: discovers subagent jsonls + bg shell task outputs per agent session → streams into per-activity threads (ChatAdapter.provisionThread) + bg_task_* SSE events
    archive-sweeper.ts   v2.9+ daily archive sweep: every 24h snapshots all active agents' session jsonls (idempotent copy-if-larger) — covers crash/never-retired gaps that retirement-time archiving misses
  channel-server.ts      Per-session MCP proxy (stdio MCP ↔ Bridge WebSocket)
  manager.ts             Agent lifecycle + cron + version/update CLI (JSON output)
  cron.ts                Cron scheduler daemon (launchd-managed)
  launcher.ts            Master tmux session guardian (launchd-managed)
  setup.ts               Interactive installation wizard
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → Bridge HTTP endpoint
  lib/
    bridge-client.ts     Shared Bridge WebSocket request helper
    tmux-helper.ts       Shared tmux command wrappers (tmuxRaw, isIdle, sendLine, …)
    claude-launch.ts     Unified Claude Code launch-command builder (flags, MCP_NAME, shell escaping)
    config-store.ts      Runtime config at ~/.claude-orchestrator/config.json (auto-update toggles)
    skills.ts            SKILL.md discovery — user / plugin / project sources + hardcoded natives
    doctor.ts            v2.14+ read-only install health-check backing `manager.ts doctor` (runtime / config / daemons / bridge / MCP / agents)
    link-policy.ts       v2.14+ what channel-server does when the bridge says it was replaced (reconnect vs exit) — pure, unit-tested
    net-addr.ts          v2.14+ detect this host's reachable addresses (Tailscale CGNAT first, then RFC1918) for peer handshake `--url`
    jsonl-cost.ts        Parse ~/.claude/projects JSONL files → per-model token rollup
    peers.ts             peers.json data model (v2.11+ HTTP peers only) + handshake string encode/parse + atomic writes
    principals.ts        v2.6.0+ transport-scoped identity + API token CRUD/scope/rate-limit (~/.claude-orchestrator/principals.json)
    registry.ts          v2.9+ single reader for ~/.claude-orchestrator/registry.json (field normalization incl. cwd/dir compat); manager.ts stays the sole writer
    bg-jobs.ts           v2.7+ Claude Code bg job cleanup recipe: kill → wait daemon quiescent → quarantine job dir → on respawn, roster root-fix (v2.9.1: daemon's ~/.claude/daemon/roster.json workers list is the respawn authority — kill worker + transient daemon + drop the entry, only when no other worker would be affected)
    session-archive.ts   v2.8+ session jsonl snapshot on retirement (kill / fork rotation / adopt / resume-replace) → ~/.claude-orchestrator/archive/<agent>/ — counters CC cleanupPeriodDays
    session-history.ts   v2.9+ read-only history parsing: live + archived session jsonl → neutral paginated messages, backs GET /api/v1/agents/:name/history
  ansi2html.ts           ANSI escape codes → coloured HTML
  html2png.ts            HTML → PNG via Playwright headless Chromium
  discord-reply.ts       Bash fallback: send a message through the Bridge directly
master/
  CLAUDE.md.template     Master agent instruction template (rendered by setup.ts)
  CLAUDE.md              Rendered local copy (git-ignored)
tests/                     pure-logic suites only (run `bun test` for the live count); bridge.ts itself has no
                           isolated unit tests (Discord client + ws + peers.json coupling), live
                           verification through a sandbox session is the coverage there.
  agent-stats.test.ts      Per-agent usage rollup, compact-aware
  ask-user-question.test.ts AskUserQuestion detection in the TUI + keystroke synthesis
  bg-jobs.test.ts          Claude Code bg job cleanup recipe (roster root-fix)
  claude-launch.test.ts    Launch-flag builder: permission modes, effort, model aliases
  cron.test.ts             Cron parser + scheduler
  doctor.test.ts           v2.14+ install health-check: daemon exit classification + report formatting
  event-bus.test.ts        v2.6.0+ seq monotonicity, per-agent ring buffer, subscriber isolation
  http-peer.test.ts        v2.11+ HTTP peer handshake encode/parse + reply extraction
  jsonl-cost.test.ts       JSONL token-usage rollup
  link-policy.test.ts      v2.14+ what channel-server does when displaced — "stdio alive ⇒ never exit"
  modal-parser.test.ts     Tmux modal detection
  net-addr.test.ts         v2.14+ reachable-address detection: CGNAT/RFC1918 boundaries, no loopback
  permission-watcher.test.ts Permission-modal identity (dedupe key)
  principals.test.ts       v2.6.0+ token issue / scope / rate limit / terminal grant
  principals-snowflake.test.ts v2.14+ Discord ID validation — the only gate stopping a placeholder
                           from becoming a permanent fake owner in principals.json
  registry.test.ts         v2.9+ registry field normalization (cwd/dir compat)
  router.test.ts           v2.0.0+ Envelope / Endpoint / parseAddress / makeResponseEnvelope
  session-archive.test.ts  v2.8+ copy-if-larger snapshot semantics
  session-history.test.ts  v2.9+ jsonl → neutral messages: reply extraction, meta filtering, paging
  sessions-inventory.test.ts v2.7+ doppelganger detection / session reconciliation
  skills.test.ts           SKILL.md discovery
  slash-registry.test.ts   Slash command registry per-channel resolution
  stats-resets.test.ts     Usage-window reset detection
  web-gateway.test.ts      v2.13+ cross-origin verdict for the ws control plane (drive-by RCE guard)
install.sh               One-line installer
SETUP.md                 User-facing installation guide
```

## Features

- **Multi-agent orchestration** — create, resume, kill, restart, list, browse history.
- **Agent-to-agent messaging** — `send_to_agent(target, text)` MCP tool injects messages directly into another agent's context via the Bridge.
- **Codex 调用 (v2.20+)** — `ask_codex(prompt, thread?, cwd?, sandbox?)` MCP tool lets any agent consult the local OpenAI Codex (ChatGPT.app's bundled CLI, subscription quota, no API key). Bridge spawns `codex exec` per call (zero resident processes; `codex exec resume` for named-thread continuity via `~/.claude-orchestrator/codex-threads.json`; sandbox/cwd fixed at thread creation — resume inherits them). Sandbox whitelist `read-only` (default) / `workspace-write`; `danger-full-access` deliberately unexposed. Concurrency cap 3; calls visible in the jsonl-watcher stream for audit. Runner in `lib/codex.ts` (`CODEX_BIN` overrides binary path). Design notes: the file-outbox/watcher approach (peer's BRIDGE.md) was evaluated and rejected for Claudestra — our return path is the MCP channel, so the tmux-injection complexity it solves doesn't exist here.
- **Cron scheduling** — cron expressions spin up a temporary agent, run a prompt, report, and clean up.
- **Discord UI** — buttons, select menus, slash commands (`/status`, `/screenshot`, `/interrupt`, `/cron`).
- **Interactive components in `reply()`** — button rows, single-select menus, and (v2.14+) `multiselect`: pick several options and submit once. Discord uses the native `max_values` (picking closes the menu); the web client renders checkboxes plus a submit button. Both send back the same wire format — `[select:<id>:<v1>,<v2>]`, values comma-separated — so one parser handles both. Prefer multiselect over a row of yes/no buttons when the choices are not mutually exclusive: one round trip instead of several.
- **LLM-free admin buttons** — status, peek, kill, restart, and cron actions execute directly on the Bridge for instant response with zero token cost.
- **Streaming tool output** — jsonl-watcher pushes `Read · Edit · Write · Bash · Grep` calls to Discord in near real-time.
- **Terminal screenshots** — ANSI-to-PNG pipeline lets you peek at a locked screen.
- **One-click interrupt** — Discord button sends `Ctrl+C` to the target agent's tmux window.
- **Idle detection** — Claude Code `Stop` / `Notification` hooks drive Discord typing indicators precisely; a 30-minute safety timeout catches edge cases.
- **Master guardian** — launchd-managed launcher keeps the master tmux session alive and auto-dismisses Claude Code confirmation prompts.
- **Guard rails (not a security boundary)** — `--disallowedTools` carries a blocklist (`rm -rf`, `git push --force`, `git reset --hard`, `chmod 777`, fork bomb) for every spawned agent. The rules are **prefix matches on the command string**, so equivalent spellings (`/bin/rm -rf`, `rm -fr`, `find … -delete`, `python -c`, variable expansion) bypass them, and there is no `PreToolUse` hook backstop. Since `DEFAULT_PERMISSION_MODE` is `bypassPermissions` (`lib/claude-launch.ts`), every agent is effectively an unrestricted shell running as the user — the blocklist only prevents accidents, never a determined prompt.
- **Multi-frontend API (v2.6.0+)** — the core is decoupled from Discord (design doc: `docs/design-multi-frontend.md`). Three transport-neutral channels: `GET /events` (SSE stream of tool calls / assistant text / agent status, `Last-Event-ID` replay), `POST /api/v1/agents/:name/messages` (Bearer-token inbound messaging with sync `wait`, multipart file upload, thread polling fallback), and `GET /stats`. Tokens are scoped per-agent (`manager.ts token-add <name> --agents a,b`; non-`--external` agents require `--force` — shared-context leak guard). API conversations are mirrored to the agent's Discord channel for auditability (`--no-mirror` to opt out). Outbound delivery goes through the `ChatAdapter` registry (`bridge/adapters.ts`) — adding Telegram or another platform means implementing one adapter, zero core changes. Bridge HTTP binds `127.0.0.1` by default (`BRIDGE_BIND` to open up).
- **Claude Code agents-mode integration (v2.7+)** — Claude Code 2.1.x runs a bg-agent daemon (`claude agents`, respawn-on-kill, ← key opens the agents view in every TUI). This system fights Claudestra's tmux-foreground model: a mis-pressed ← can fork a foreground session into a bg job ("doppelganger"), silently breaking the Discord link (2026-07-09 incident). Adaptation layers: **(1) visibility** — `SessionsInventory` (`bridge/sessions-inventory.ts`) merges `claude agents --json` + `~/.claude/jobs/*/state.json` + registry into a neutral session list with doppelganger detection, consumed by the Discord `/agents` panel (LLM-free buttons: detail / adopt / cleanup), `GET /api/v1/sessions`, and `POST /api/v1/sessions/:id/cleanup|adopt` (full-scope token required, 202 + `session_anomaly` SSE events); **(2) self-heal** — `manager.ts restart` detects the "running as a background agent" error and automatically retries with `--fork-session`, then probes the forked session id (projects-dir diff) and writes it back to the registry; `manager.ts adopt <name> <sessionId>` promotes a doppelganger to the official session, `resume --fork` adopts wild sessions; **(3) guards** — permission-watcher auto-escapes agents-view UIs (8s poll, Esc + notify), wedge-watcher's link sentinel alerts when a window is alive but its channel-server has been offline >5min (repair button), and a 10-min reconciler alerts on new doppelgangers with cleanup/adopt buttons. Cleanup recipe (`lib/bg-jobs.ts`, incident-proven): kill bg pids (never `--fork-session` referencers) → wait for daemon quiescence → quarantine the job dir → detect stubborn respawns and defer to the official TUI.
- **Background-activity threads (v2.8+)** — every agent's background work gets its own sub-conversation instead of polluting the main channel. `bridge/bg-activity-watcher.ts` polls each registered agent's session for two activity kinds: **subagents** (`~/.claude/projects/<slug>/<sessionId>/subagents/agent-*.jsonl`, same format as the main session) and **background shell tasks** (`/tmp/claude-<uid>/<slug>/<sessionId>/tasks/*.output`). A new file → `ChatAdapter.provisionThread` opens a thread under the agent's channel (Discord thread today, Telegram topic later); tool calls / assistant text / shell output stream in with a 2.5s debounce; 3 min of inactivity → completion summary + thread auto-archive. Lifecycle mirrors to SSE as `bg_task_started/update/completed` so a web frontend can render per-task progress lines without Discord. Restart-safe: the first poll baselines existing files without replaying. **Session archive** (`lib/session-archive.ts`): whenever a session retires (kill, fork rotation, adopt, resume-replace, or manual `manager.ts archive <name>`), its jsonl (+ subagents) is snapshotted to `~/.claude-orchestrator/archive/<agent>/` — Claude Code's `cleanupPeriodDays` prunes the originals, the archive is what makes chat history durable. Copy-if-larger semantics; conversation content stays in files, no database (owner-approved storage design 2026-07-10). v2.9+ adds a daily sweeper (`bridge/archive-sweeper.ts`) that re-snapshots every active agent's session, so long-lived sessions that never retire are archived too. SSE `bg_task_*` events carry a stable `id` (file basename: subagent id / shell task id), never server paths.
- **Read-only history API (v2.9+)** — the web-UI-facing counterpart of the archive: `GET /api/v1/agents/:name/history` lists an agent's sessions (live + archived snapshots merged, live wins when larger), `GET /api/v1/agents/:name/history/:sessionId` returns paginated neutral messages (`?limit=100&before=<seq>` pages backwards like a chat view; `?subagent=agent-xxx` reads a subagent conversation). Parsing lives in `lib/session-history.ts` (pure, unit-tested): user/assistant/compact-boundary entries become `{seq, ts, role, text, tools[], compactSummary?}`, meta entries and tool_result payloads are filtered, tool calls render through jsonl-watcher's `formatTool`. Token scope rules match the messaging endpoint; a killed agent's archives remain readable (that is the point of archiving). sessionId/subagent params are whitelist-validated before touching the filesystem.
- **Discord slash autocomplete for skills + built-ins** — on startup, the Bridge discovers every available slash command from four sources (user-level `~/.claude/skills/`, installed plugins in `~/.claude/plugins/cache/…`, per-agent `<cwd>/.claude/skills/`, and a curated set of Claude Code built-ins like `/cost`, `/mcp`, `/context`, `/compact`) and registers them as Discord slash commands. Invocations are re-scanned on every `manager.ts create|resume|kill|restart` via the `/skills/rescan` HTTP endpoint. When a user types a registered `/cmd args` in Discord, the bridge forwards the literal text to the channel's agent via `tmux send-keys`, so Claude Code interprets it natively. Project-level skills are filtered: typing a skill that only exists in another agent's cwd yields an ephemeral explanation instead of going through.

### Cross-Claudestra peer collaboration

**HTTP peers (v2.11+, recommended)** — peers are just API clients of each other: each side issues the other a scoped Bearer token (`Principal.peer` marks it), and `send_to_agent("<agent>@<peer>")` POSTs the other bridge's `/api/v1/agents/:name/messages` with `wait`, falling back to thread polling (30s × 10min). Inbound rides the existing multi-frontend API unchanged (scope 403 / mirror / history all apply); the injected header renders as a 🤝 peer request, peer inbound never preempts a running turn and never gets slash passthrough. Replies push back to the caller as synthetic messages (same UX as local `send_to_agent`); all failures (network / auth / offline / timeout) are reported to the caller, never silent. Exposure = token scope; revoke = `peer-http-remove` (token dies instantly). State lives in `peers.json` `httpPeers[]` (0600, atomic writes). The old Discord-based peer mechanism (shared exchange channel, exposures, bot-to-bot routing) was removed in v2.11 — HTTP peers are the only cross-instance transport. v2.11.1+ adds a management surface: `GET /api/v1/peers` (list + inbound scope + local agents), `POST /api/v1/peers/{invite,join,accept}` (handshake), `POST /api/v1/peers/:name/{test,scope,remove}` — all full-scope-token only, mutations delegate to `runManager` so the CLI's R1 checks stay the single source of truth. **v2.15+ one-click invite**: `peer-invite-new` pre-issues the inbound token and embeds a one-time `joinSecret` in a v2 invite string (`pendingInvites[]` in peers.json, 24h TTL, expiry/revoke also revokes the token); `peer-join-auto` on B parses it, stores A, and POSTs A's unauthenticated-but-joinSecret-gated `POST /api/v1/peers/redeem` (rate-limited 10/min) — A registers B under B's self-reported name (collision-suffixed to prevent peer hijack), notifies the owner, no receipt/accept step. Joining exposes nothing of B by default (one-way peer; the web card shows 单向). The master orchestrator is **never shareable to peers** — `checkPeerScope` rejects unconditionally and `agentInScope` cuts off legacy peer tokens that list master. The web client renders this as Settings → Peers (one-click invite/join + pending-invite management, scope editor, reachability test); the 3-step handshake remains CLI-only for pre-v2.15 counterparts.

## Runtime commands

```bash
# First-time setup: collect Discord config, write .env, render master/CLAUDE.md
bun run setup

# Start everything (bridge + launcher + cron-scheduler)
bun src/manager.ts install-cli   # writes + loads the 3 launchd daemons

# Agent lifecycle
bun src/manager.ts create   <name> <dir> [purpose]
bun src/manager.ts resume   <name> <sessionId> [dir] [--fork]   # --fork: adopt a wild/bg-occupied session as a branched copy
bun src/manager.ts adopt    <name> <sessionId>   # promote a bg doppelganger to the agent's official session + restart
bun src/manager.ts archive  <name>               # snapshot the agent's current session jsonl to ~/.claude-orchestrator/archive/
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

# Cross-Claudestra peer collaboration — HTTP peers (no Discord dependency;
# peers talk over the /api/v1 surface directly. Design: docs/design-http-peers.md)
# v2.15+ one-click invite (recommended): A generates, B pastes, B's bridge calls
# A's /api/v1/peers/redeem automatically — no receipt/accept. Single-use, 24h TTL,
# expiry/revoke also revokes the embedded token. Joining exposes nothing of B by
# default (one-way grant); symmetric access = B sends an invite of their own.
bun src/manager.ts peer-invite-new --agents <a,b|*> [--url <my-bridge-url>] [--force]  # A: print one-click invite (auto-URL: Tailscale first; warns if BRIDGE_BIND is loopback)
bun src/manager.ts peer-join-auto '<invite>' [--agents <x,y>] [--url <my-url>] [--force]  # B: paste invite, done (--agents = optional reverse exposure)
bun src/manager.ts peer-invite-list               # pending invites (sweeps expired + revokes their tokens)
bun src/manager.ts peer-invite-revoke <inv_id>    # void an unredeemed invite + its embedded token
# Legacy 3-step handshake (needed when the other side runs pre-v2.15):
bun src/manager.ts peer-http-invite <name> --agents <a,b> [--url <my-bridge-url>] [--force] [--rotate]  # A: print invite string (--url is auto-detected if omitted: Tailscale first, then LAN)
bun src/manager.ts peer-http-join <name> '<invite>' --agents <x,y> --url <my-url> [--force]           # B: store A, print receipt
bun src/manager.ts peer-http-accept <name> '<receipt>'                                                # A: complete handshake
bun src/manager.ts peer-http-test <name>          # GET peer /agents — verify reachability + scope
bun src/manager.ts peer-http-list                 # list HTTP peers + handshake state
bun src/manager.ts peer-http-scope <name> --agents <a,b|*> [--force]  # v2.11.1+: change inbound scope in place (token unchanged, effective immediately)
bun src/manager.ts peer-http-remove <name>        # delete peer + revoke the token we issued
# send_to_agent target syntax: "<agent>@<peer>" or "peer:<peer>.<agent>"
# master is NEVER shareable to peers (hard rule v2.15+, --force does not override;
# legacy peer tokens listing master are cut off in agentInScope)

# Versioning
# Health check (read-only; the first thing to run when something is broken)
bun src/manager.ts doctor [--json]

# Versioning
bun src/manager.ts version   # current version + whether an update is available
bun src/manager.ts update    # git pull + reload the 3 launchd daemons

# Auto-update toggles (both default on; launcher polls on a schedule and only upgrades when all agents are idle)
bun src/manager.ts auto-update status
bun src/manager.ts auto-update claudestra on|off   # Claudestra self-update (30 min poll)
bun src/manager.ts auto-update claude on|off       # Claude Code CLI (weekly poll)

# Multi-frontend API tokens (v2.6.0+; scope = per-agent whitelist, "*" = all non-master)
bun src/manager.ts token-add <name> --agents <a,b|*> [--force] [--no-mirror] [--terminal]  # --terminal = 远程终端(宿主 shell 级)独立授予
bun src/manager.ts token-list
bun src/manager.ts token-revoke <tokenId|name>
bun src/manager.ts create <name> <dir> --external   # mark agent as safe-to-expose (R1 guard)

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
| `BRIDGE_BIND` | HTTP/ws bind address (default `127.0.0.1`; set `0.0.0.0` to expose — bring your own reverse proxy/TLS) |
| `BRIDGE_CORS_ORIGIN` | v2.10+ CORS allowlist: comma-separated origins or `*` (default unset = no CORS headers) |
| `BRIDGE_STATIC_DIR` | v2.10+ static dir served by the bridge (SPA fallback included; default unset = off) |

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

- The master orchestrator is window 0 of the `master` tmux session. the `com.claudestra.launcher` launchd agent guarantees it exists and is running Claude Code.
- Every agent's Discord channel ID is recorded in `~/.claude-orchestrator/registry.json`. The Bridge uses this registry to route incoming Discord messages to the correct channel-server.
- The MCP server name (`MCP_NAME`) must match between `claude mcp add`, the channel-server's registration, and the JSONL watcher's tool-filter prefix. It is centralised in `src/bridge/config.ts` and `src/lib/claude-launch.ts`.
- Agent names are validated against a shell-metacharacter blocklist on create/resume but loosely normalised on kill/restart to keep historical CJK names working.
- Tool call display is debounced through `WATCHER_CONFIG.debounceMs` (default 1500 ms) to avoid Discord rate limits during bursty tool sequences.
- **Message routing (v2.0.0+)**: every message-semantic bridge operation (inbound to agent / outbound reply / agent→agent forward / pushback from HTTP-peer calls) constructs an `Envelope` and calls `deliver(env)`. The only direct `ws.send({type:"message"...})` / `channel.send({content})` calls outside `deliver` are **UI-class** side effects: the "💭 Thinking" status message with the Interrupt button, LLM-free admin button replies, `notifyMaster` broadcasts, and hook-event text notifications. Everything that an agent ends up seeing in its MCP `<channel>` tag goes through `deliver` → `renderContentForLocal`.
- **`channel-server` lifecycle (v2.14+)**: the governing constraint is that **channel-server has no supervisor** — Claude Code neither respawns a dead stdio MCP server nor reconnects to it, so any exit is a permanent disconnect for that agent. Two rules follow. (1) **Register only after the MCP handshake.** `mcp.oninitialized` gates the bridge connection, so a stray process that merely runs `channel-server.ts` can never claim the channel — which matters because `DISCORD_CHANNEL_ID` is injected by Claude Code and inherited by every Bash subprocess, making an accidental run inside the agent's own repo trivially easy. A 30s fallback registers anyway if the SDK never fires the callback. (2) **Being displaced is not a reason to die.** On `replaced` / `close(4001)` the process checks whether its stdio is still open: if Claude Code is still using it, it backs off and re-registers to take the channel back (3s→60s, and the counter only resets after holding the channel for 30s, so two live instances degrade to a slow alternation instead of a 3-second thrash); only `mcp.onclose` is a legitimate exit. Decision logic is isolated in `lib/link-policy.ts` and unit-tested. Plain `code 1000` (bridge restart) is still a transient disconnect → exponential-backoff reconnect.

## Contributing tips

- **Release process**: commits and `git push` to `main` are fine to do autonomously. Creating a `git tag v*` and a GitHub Release (`gh release create`) requires **explicit owner approval** every time — never tag-and-release on your own initiative.
- **Batch releases, don't spray them** (owner-mandated 2026-07-08 after reviewing 59 releases in 2.5 months): non-urgent changes accumulate in `main` and ship as **one release at the end of a work session/day**, bundling everything since the last release (v2.5.4 is the reference example: five features/fixes, one release). Only production-down hotfixes justify an immediate solo release. Same-day multi-release chains (e.g. 4 releases on 2026-04-25) usually mean the release was cut before verification — verify first, then cut. And keep version semantics honest: new user-facing capability = minor, even if small; patch is for fixes/refactors/polish only.
- **Version bump rules** (owner-mandated, refined 2026-04-20 starting v1.7.0):
  - **Patch** (`x.y.Z`) — bug fixes, small enhancements, extra CLI subcommands, refactors, tests, docs, UI polish. Most changes land here. If the bump is specifically a bug fix, also **delete the buggy release** via `gh release delete <tag> --yes --cleanup-tag` so the Releases list contains no broken versions. Polish/small-feature patches don't delete the previous version.
  - **Minor** (`x.Y.0`) — genuinely new user-facing capability that deserves a one-line "现在你可以 ..." headline. Examples: v1.3.0 Claude Code auto-update, v1.5.0 Discord slash autocomplete. Older minors are kept as history.
  - **Major** (`X.0.0`) — breaking change or system-level rearchitecture. Owner bumps these manually; never bump major on your own initiative.
  - Heuristic: if you're writing release notes and catch yourself opening with "修了..." / "加了个..." / "补了测试" / "重构了..." — that's a **patch**. Only headline-worthy new capability = minor.
- `tmux-helper.ts` and `claude-launch.ts` are the canonical places for tmux commands and Claude Code launch flags. Don't inline these in new files.
- Admin buttons that should skip the LLM go in `bridge/management.ts`. Add the `id` to both `handleMgmtButton` and the relevant panel builder.
- Before shipping, run `bun run check` (= `tsc --noEmit` + `bun test`). **`bun build` does not typecheck** — it happily compiles `const x: number = "str"`, so the old advice to rely on it for type errors was wrong. Still build each entry point (`bridge`, `channel-server`, `manager`, `launcher`, `cron`, `setup`) to catch module-resolution errors that typechecking misses. CI runs all three on every push and PR.
- Test suite (`bun test`) currently exercises pure logic (cron parser, JSONL cost rollup, tmux modal parser, peers.ts encode/parse, router.ts envelope helpers, skills discovery, slash-registry). `bridge.ts` itself has no isolated unit tests because of its Discord-client + ws + peers.json coupling — live verification through a second Claude Code session in a sandbox Discord server is the coverage there.
- New outbound Discord messages (reply, notification, forward) should build an `Envelope` and call `deliver()` rather than calling `discordReply` / `channel.send` directly. `renderContentForLocal` centralises header rendering; don't hand-inject headers in call sites.
