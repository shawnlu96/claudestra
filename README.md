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

- **Multi-agent orchestration** — create, resume, kill, restart, list, and browse session history.
- **Agent-to-agent messaging** — `send_to_agent(target, text)` MCP tool injects a message directly into another agent's context.
- **Cron scheduling** — declarative cron expressions spin up a temporary agent, run a prompt, notify Discord, then clean up.
- **Interactive Discord UI** — buttons, select menus, slash commands (`/status`, `/screenshot`, `/interrupt`, `/cron`).
- **LLM-free management** — state/kill/restart/cron buttons execute directly on the Bridge, zero-token overhead and near-instant response.
- **Streaming tool output** — JSONL watcher pushes `Read · Edit · Write · Bash · Grep` calls to Discord as they happen.
- **Terminal screenshots** — ANSI-to-PNG rendering so you can peek at any session even with the screen locked.
- **One-click interrupt** — a button in Discord sends `Ctrl+C` to the target session.
- **Idle detection** — Claude Code `Stop` / `Notification` hooks drive Discord typing indicators precisely.
- **Self-updating** — `bun src/manager.ts update` does `git pull` + `pm2 restart ecosystem.config.cjs` (only Claudestra's 3 processes; other pm2 apps you run are untouched) via natural language in Discord.
- **Safety rails** — `--disallowedTools` blocks `rm -rf`, `git push --force`, `chmod 777`, and other destructive commands.

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

# Versioning
bun src/manager.ts version   # show current version and whether an update is available
bun src/manager.ts update    # git pull && pm2 restart ecosystem.config.cjs (Claudestra's 3 processes only)
```

## Configuration

All runtime configuration lives in `.env` (created by `bun run setup`).

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Your Discord bot token |
| `DISCORD_GUILD_ID` | Discord server (guild) ID |
| `ALLOWED_USER_IDS` | Comma-separated list of Discord user IDs allowed to talk to the bot |
| `CONTROL_CHANNEL_ID` | Channel ID of your control (master) channel |
| `BRIDGE_PORT` | WebSocket port (default `3847`) |
| `USER_NAME` | How the master agent addresses you in replies |
| `MCP_NAME` | MCP server name used by `claude mcp add` (default `claudestra`) |

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
  channel-server.ts      Per-agent MCP proxy (one per Claude Code process)
  manager.ts             Agent lifecycle + cron + version/update CLI
  cron.ts                Cron scheduler daemon (pm2-managed)
  launcher.ts            Master tmux session guardian (pm2-managed)
  setup.ts               Interactive installation wizard
  hooks/
    typing-hook.ts       Claude Code Stop/Notification hook → typing indicator
  lib/
    bridge-client.ts     Shared WebSocket request helper
    tmux-helper.ts       Shared tmux command wrappers
    claude-launch.ts     Unified Claude Code launch-command builder
  ansi2html.ts           ANSI escape codes → coloured HTML
  html2png.ts            HTML → PNG (Playwright headless Chromium)
  discord-reply.ts       Bash fallback for sending messages via Bridge
master/
  CLAUDE.md.template     Master agent behaviour template (rendered by setup)
tests/
  cron.test.ts           Cron parser + scheduler tests (46 cases)
install.sh               One-line installer
SETUP.md                 Full installation guide
```

## Contributing

Issues and pull requests welcome. The core idea is simple; the hard parts are edge cases in tmux, Discord rate limits, and Claude Code channel lifecycle. Before submitting a PR:

1. `bun test` — keep the cron test suite green.
2. `bun build src/bridge.ts --target=bun` (and the same for each entry point) — catches most type issues fast.
3. Test the actual user flow end-to-end in a sandbox Discord server.

## License

[MIT](./LICENSE)
