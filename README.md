# Claudestra

**English** · [简体中文](./README.zh-CN.md)

> Manage multiple local Claude Code sessions from Discord.

Claudestra lets you run Claude Code on your workstation and drive it from anywhere — phone, tablet, or another machine — through Discord. Each session lives in tmux, so the moment you're back at your desk you can attach and keep going in the same process.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-bun-fbf0df.svg)](https://bun.sh)
[![Claude Code](https://img.shields.io/badge/requires-claude--code_2.1.80%2B-d97757.svg)](https://claude.com/claude-code)

---

## Why

Claude Code is a terminal-only tool: if you aren't at your computer, you aren't using it. Claudestra puts a persistent Discord front door in front of your local sessions so you can:

- Chat with any active Claude Code session from your phone.
- Run several sessions in parallel — one Discord channel per session.
- Return to your desk and attach to the **same** running process via `tmux`.
- Watch tool calls stream in real time (Read / Edit / Bash / Grep).
- Schedule recurring tasks that spin up a temporary agent and report back.

## How it works

```
 Your phone (Discord)
        │
        ▼
 Discord Bot  ──  one token, many channels
        │
        ▼
 Bridge (Bun, pm2)            ws://localhost:3847
        │
        │  WebSocket  ├──  channel-server ◄─► Claude Code (session A)
        │             ├──  channel-server ◄─► Claude Code (session B)
        │             └──  channel-server ◄─► Claude Code (session C)
        │
        │  JSONL watcher
        └──  tails each session file and pushes tool calls to Discord

 Your Mac (iTerm2)
        │  tmux -CC attach
        └──  every session shows up as a native tab
```

Claudestra builds on Claude Code's native **Channel protocol** (MCP) rather than scraping terminal output. The Bridge process acts as a fan-out layer that routes Discord messages to the correct `channel-server` instance, working around the official plugin's one-token-one-session limitation.

## Features

### Core orchestration
- **Multi-agent lifecycle** — create, resume, kill, restart, list, and browse session history.
- **Agent-to-agent messaging** — `send_to_agent(target, text)` MCP tool injects a message directly into another agent's context.
- **Cron scheduling** — declarative cron expressions spin up a temporary agent, run a prompt, notify Discord, then clean up.
- **Cross-Claudestra peer collaboration (v1.8+, redesigned v1.9+)** — invite your friend's bot; bridge automatically creates a `#agent-exchange` shared channel. Opt-in `peer-expose <agent> <peer>` selectively exposes specific local agents to each peer. v1.9.21+ `direct` mode: bridge routes peer requests **straight to the target agent, bypassing both masters** — 2-3 hops instead of 6. v1.9.22+ symmetric: you `@peer-bot` in `#agent-exchange` and peer's bridge routes directly to their agent; no master turns either way. v1.9.26+ disambiguation: multi-candidate routes fall back to Discord button picker (no LLM turn). Agents can call `send_to_agent({ target: "peer:alice.future_data" })` to cross-peer invoke by fully-qualified name.
- **LLM-free management** — status / kill / restart / cron buttons execute directly on the Bridge, zero-token overhead and near-instant response.

### Discord UI
- **Interactive components** — buttons, select menus, slash commands.
- **Slash autocomplete for every skill (v1.5+)** — user-level skills from `~/.claude/skills/`, installed plugins, project-level `<cwd>/.claude/skills/`, Claude Code's bundled skills, plus a curated set of built-in commands (`/cost`, `/context`, `/compact`, `/mcp`, `/review`, `/effort`, `/model`, …) all appear as Discord slash commands. Auto-rescanned every 30 minutes.
- **TUI modal adaptation (v1.5+)** — numbered menus (`/model`) and arrow sliders (`/effort`) render as Discord buttons; anything bridge can't parse gets a 🤖 button that escalates to the master agent.
- **Streaming tool output** — JSONL watcher pushes `Read · Edit · Write · Bash · Grep` calls to Discord as they happen.
- **Terminal screenshots** — ANSI-to-PNG rendering so you can peek at any session even with the screen locked.
- **One-click interrupt** — a button in Discord sends `Ctrl+C` to the target session.
- **Auto-interrupt on new message (v1.5+)** — send a new Discord message while Claude is mid-task and the bridge auto-sends Ctrl+C so your new message redirects rather than queues.
- **Idle detection** — Claude Code `Stop` / `Notification` hooks drive Discord typing indicators precisely.

### Reliability & ops
- **Auto-update (v1.3+, configurable v1.4+)** — Claudestra itself polls GitHub every 30 min; Claude Code CLI every 7 days. Only upgrades while every agent is idle. Toggle per-target via `bun src/manager.ts auto-update <target> on|off`.
- **Reboot survival (v1.7.9+)** — `pm2 startup` gets automated during setup; on reboot the launcher revives every registry-known agent with `claude --resume` into its original Discord channel.
- **Session-idle Discord buttons (v1.3+)** — when Claude Code's resume dialog appears, agents surface buttons in Discord (resume from summary / resume full / don't ask again); master auto-confirms to stay always-on.
- **Wedge watcher (v1.6+)** — if an agent's tmux pane stays unchanged for 30 min while not idle, you get an @mention with Esc / Ctrl+C rescue buttons.
- **Self-updating** — `bun src/manager.ts update` does `git pull` + `pm2 restart ecosystem.config.cjs` (only Claudestra's 3 processes; other pm2 apps untouched).

### Observability
- **Token-usage rollup (v1.6+)** — `bun src/manager.ts cost [--agent <name>] [--today|--week]` aggregates per-agent / per-model tokens straight from Claude Code's JSONL files.
- **Metrics log (v1.7+)** — append-only `~/.claude-orchestrator/metrics.jsonl` records every bridge event (`slash_invoked`, `agent_completed`, `agent_wedged`, `error`, …). Summarise via `bun src/manager.ts metrics`.
- **Master TUI proxy (v1.7+)** — master can drive any agent's terminal via `tmux-screenshot` / `tmux-capture` / `tmux-send-keys` / `tmux-wait-idle` CLI helpers. Used to handle TUI modals the bridge can't parse.

### Safety & utilities
- **`--disallowedTools` safety rails** — blocks `rm -rf`, `git push --force`, `chmod 777`, etc. for every spawned agent; presets (`default` / `strict` / `readonly` / `paranoid`) per-agent via `manager.ts permissions`.
- **One-click bot invite URL (v1.8.1+)** — `bun src/manager.ts invite-link [--peer]` auto-decodes your Application ID from the bot token and prints the ready-to-click Discord OAuth URL. `--peer` generates a minimum-permission link for a friend.

## Requirements

| Tool | Minimum | Install |
|------|---------|---------|
| macOS or Linux | — | — |
| [Bun](https://bun.sh) | 1.x | `curl -fsSL https://bun.sh/install \| bash` |
| [tmux](https://github.com/tmux/tmux) | 3.x | `brew install tmux` |
| [pm2](https://pm2.keymetrics.io/) | 5.x | `npm install -g pm2` |
| [Claude Code](https://claude.com/claude-code) | 2.1.80+ | `npm install -g @anthropic-ai/claude-code` |
| Discord Bot | — | [Developer Portal](https://discord.com/developers/applications) |

## Installation

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
```

The installer checks prerequisites, clones the repository, and runs `bun install` + `playwright install`. Afterwards, run the interactive setup wizard:

```bash
cd ~/repos/claudestra
bun run setup
```

### Manual

```bash
git clone https://github.com/shawnlu96/claudestra.git ~/repos/claudestra
cd ~/repos/claudestra
bun install
npx playwright install chromium
bun run setup
```

For a step-by-step walkthrough — creating a Discord application, enabling privileged intents, collecting IDs — see **[SETUP.md](./SETUP.md)**.

## Daily use

### From Discord (phone)

In your control channel:

| Command | What it does |
|---------|--------------|
| `/status` | List every agent and its state |
| `/screenshot` | Render the current channel's terminal as PNG |
| `/interrupt` | Send `Ctrl+C` to the current agent |
| `/cron` | Open the cron-job management panel |

In any agent channel, just type — your message goes straight to that Claude Code session. Tool calls stream back as they execute.

### From your terminal

```bash
# Attach with iTerm2 native tabs
tmux -S /tmp/claude-orchestrator/master.sock -CC attach

# Or plain tmux
tmux -S /tmp/claude-orchestrator/master.sock attach
```

Every agent is a window inside the `master` session. Switch with `Ctrl-B n/p` or click the iTerm2 tab.

### CLI reference

```bash
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

# Versioning & auto-update
bun src/manager.ts version                          # current version + whether update available
bun src/manager.ts update                           # git pull + pm2 restart (Claudestra only)
bun src/manager.ts auto-update status               # show auto-update toggles
bun src/manager.ts auto-update claudestra on|off    # Claudestra self-update (30-min poll)
bun src/manager.ts auto-update claude on|off        # Claude Code CLI (weekly poll)

# Observability
bun src/manager.ts cost [--agent <n>] [--today|--week]   # per-agent token usage
bun src/manager.ts metrics [--today|--week|--since <ISO>] [--agent <n>] [--raw]

# Permissions (per-agent disallowed tools)
bun src/manager.ts permissions list
bun src/manager.ts permissions presets
bun src/manager.ts permissions get <name>
bun src/manager.ts permissions set <name> --preset <default|strict|readonly|paranoid>
bun src/manager.ts permissions reset <name>

# Bot invite URL (v1.8.1+)
bun src/manager.ts invite-link           # owner — full permissions
bun src/manager.ts invite-link --peer    # friend — minimum peer-scope permissions

# Cross-Claudestra peer collaboration (v1.9+)
bun src/manager.ts peer-status                                     # list peer bots / your exposures / their capabilities
bun src/manager.ts peer-expose <agent> <peer|all> \
  --purpose "..."                                                  # expose your agent to peer (mode defaults to "direct")
bun src/manager.ts peer-expose <agent> <peer> --mode via_master    # legacy: route through master instead of direct
bun src/manager.ts peer-revoke <agent> <peer|all>                  # revoke exposure (peer's capability auto-removed)

# Low-level tmux control (for master to handle TUI modals bridge can't parse)
bun src/manager.ts tmux-screenshot <agent>
bun src/manager.ts tmux-capture <agent> [lines]
bun src/manager.ts tmux-send-keys <agent> <keys...>
bun src/manager.ts tmux-wait-idle <agent> [ms]
```

## Configuration

Install-time config lives in `.env` (created by `bun run setup`):

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token |
| `DISCORD_GUILD_ID` | Discord server (guild) ID |
| `ALLOWED_USER_IDS` | Comma-separated list of Discord user IDs allowed to talk to the bot |
| `CONTROL_CHANNEL_ID` | Channel ID of your control (master) channel |
| `BRIDGE_PORT` | WebSocket port (default `3847`) |
| `USER_NAME` | How the master agent addresses you in replies |
| `MCP_NAME` | MCP server name used by `claude mcp add` (default `claudestra`) |

Runtime toggles live in `~/.claude-orchestrator/config.json` (managed via `manager.ts auto-update`, lazily created):

| Key | Purpose |
|-----|---------|
| `autoUpdate.claudestra` | Claudestra self-update, 30-min poll (default `true`) |
| `autoUpdate.claudeCode` | Claude Code CLI update, weekly poll (default `true`) |

Other state files under `~/.claude-orchestrator/`: `registry.json` (active agents), `cron.json` + `cron-history.json`, `metrics.jsonl`.

## Project layout

```
src/
  bridge.ts              Discord gateway + WebSocket router + event dispatcher
  bridge/
    config.ts            Shared runtime constants
    components.ts        Discord UI components + typing indicators
    discord-api.ts       Discord API wrappers
    management.ts        Direct-execution handlers for admin buttons
    screenshot.ts        Terminal screenshot (ANSI → HTML → PNG)
    jsonl-watcher.ts     JSONL session tailer → streaming tool calls
    slash-catalog.ts     Curated Claude Code built-in slash commands
    slash-registry.ts    Runtime skill registry + per-channel resolver
    permission-watcher.ts Discord-button prompts for runtime permission dialogs
    wedge-watcher.ts     Detect stuck agents (no pane change + not idle)
  channel-server.ts      Per-agent MCP proxy (one per Claude Code process)
  manager.ts             Agent lifecycle + cron + version + metrics + tmux control CLI
  cron.ts                Cron scheduler daemon (pm2-managed)
  launcher.ts            Master tmux session guardian (pm2-managed)
  setup.ts               Interactive installation wizard
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → typing indicator
  lib/
    bridge-client.ts     Shared WebSocket request helper
    tmux-helper.ts       Shared tmux command wrappers
    claude-launch.ts     Unified Claude Code launch-command builder
    config-store.ts      Runtime auto-update toggles (~/.claude-orchestrator/config.json)
    skills.ts            SKILL.md discovery from user / plugin / project sources
    jsonl-cost.ts        Parse ~/.claude/projects JSONL → per-model token rollup
    metrics.ts           Append-only bridge event log
  ansi2html.ts           ANSI escape codes → coloured HTML
  html2png.ts            HTML → PNG (Playwright headless Chromium)
  discord-reply.ts       Bash fallback for sending messages via Bridge
master/
  CLAUDE.md.template     Master agent behaviour template (rendered by setup)
tests/                   78 cases across 5 files
  cron.test.ts           Cron parser + scheduler
  modal-parser.test.ts   TUI modal detection
  skills.test.ts         SKILL.md discovery + name sanitisation
  slash-registry.test.ts Skill resolver + per-agent isolation
  jsonl-cost.test.ts     Token rollup
install.sh               One-line installer
SETUP.md                 Full installation guide
```

## Contributing

Issues and pull requests welcome. The core idea is simple; the hard parts are edge cases in tmux, Discord rate limits, and Claude Code channel lifecycle. Before submitting a PR:

1. `bun test` — keep all 78 cases green.
2. `bun build src/bridge.ts --target=bun` (and the same for each entry point) — catches most type issues fast.
3. Test the actual user flow end-to-end in a sandbox Discord server.

## License

[MIT](./LICENSE)
