# Installation Guide

**English** · [简体中文](./SETUP.zh-CN.md)

This guide walks you through a complete Claudestra installation, starting from a fresh macOS or Linux machine. Expected time: **20–30 minutes**, most of which is spent clicking through the Discord Developer Portal.

If you only want the summary, see the quick install in the [README](./README.md#installation).

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Create a Discord application and bot](#2-create-a-discord-application-and-bot)
3. [Invite the bot to your server](#3-invite-the-bot-to-your-server)
4. [Prepare your server and collect IDs](#4-prepare-your-server-and-collect-ids)
5. [Install Claudestra](#5-install-claudestra)
6. [Run the setup wizard](#6-run-the-setup-wizard)
7. [Register the MCP server](#7-register-the-mcp-server)
8. [Start the pm2 services](#8-start-the-pm2-services)
9. [First conversation](#9-first-conversation)
10. [Attaching from your terminal](#10-attaching-from-your-terminal)
11. [Upgrading](#11-upgrading)
12. [Uninstalling](#12-uninstalling)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Prerequisites

Claudestra is tested on macOS. Linux should work but has not been exhaustively validated.

Install the five required tools:

```bash
# tmux
brew install tmux                                         # macOS
sudo apt install tmux                                     # Debian/Ubuntu

# Bun — JavaScript runtime for the bridge and manager
curl -fsSL https://bun.sh/install | bash

# pm2 — process supervisor
npm install -g pm2

# Claude Code — must be v2.1.80 or newer for Channel support
npm install -g @anthropic-ai/claude-code
```

Recommended but optional:

```bash
# macOS: safer delete (moves files to Trash instead of rm -rf)
brew install trash
```

Verify your versions:

```bash
tmux -V          # 3.x+
bun --version    # 1.x+
pm2 --version    # 5.x+
claude --version # 2.1.80+
```

---

## 2. Create a Discord application and bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, name it (for example `claudestra`), and confirm.
3. In the left sidebar, open **Bot**.
4. Click **Reset Token**, copy the new token, and store it somewhere safe. You will paste it into `.env` later.
5. Scroll to **Privileged Gateway Intents** and enable **all three**:
   - `PRESENCE INTENT`
   - `SERVER MEMBERS INTENT`
   - `MESSAGE CONTENT INTENT`
6. Click **Save Changes** at the bottom of the page.

> **Why all three intents?** The bridge listens for message content to route replies, watches member presence to resolve typing indicators, and fetches server members to validate the allow-list. Without these, the bot silently refuses to see messages.

---

## 3. Invite the bot to your server

1. Open **OAuth2 → URL Generator**.
2. Under **SCOPES**, check:
   - `bot`
   - `applications.commands`
3. Under **BOT PERMISSIONS**, check:
   - View Channels
   - Send Messages
   - Read Message History
   - Manage Channels (the bridge auto-creates one channel per agent)
   - Attach Files
   - Add Reactions
   - Embed Links
4. Copy the generated URL at the bottom of the page, open it in a browser, and authorize it into the server you want to manage.

The bot should now appear in the server's member list, initially offline. It will come online after you start pm2 in step 8.

---

## 4. Prepare your server and collect IDs

### 4.1 Enable Developer Mode in Discord

In Discord: **User Settings → Advanced → Developer Mode → On**.

This adds "Copy ID" to every right-click menu.

### 4.2 Create the control channel

Create a regular text channel in your server — for example `#claudestra-control`. This is the channel the master orchestrator will listen to.

### 4.3 Collect four IDs

Right-click each target and choose **Copy ID**:

| ID | How to copy |
|----|-------------|
| **Bot Token** | From the Developer Portal's Bot page (step 2.4) |
| **Guild ID** | Right-click the server icon |
| **User ID** | Right-click your own name/avatar anywhere |
| **Control Channel ID** | Right-click the channel you just created |

Keep these ready — the setup wizard will ask for them.

---

## 5. Install Claudestra

### Option A — One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
```

The installer will:

- Check for `git`, `tmux`, `bun`, `pm2`, and `claude` and print install hints for anything missing.
- Clone the repository to `~/repos/claudestra` (override with `CLAUDESTRA_DIR`).
- Run `bun install` and install Playwright's Chromium runtime for terminal screenshots.
- Print the exact commands to run next.

### Option B — Manual clone

```bash
git clone https://github.com/shawnlu96/claudestra.git ~/repos/claudestra
cd ~/repos/claudestra
bun install
npx playwright install chromium
```

You can clone into any directory. Claudestra resolves its own location at runtime via `import.meta.dir`, so it is not tied to `~/repos/claudestra`.

---

## 6. Run the setup wizard

```bash
cd ~/repos/claudestra
bun run setup
```

The wizard asks seven questions:

1. **Discord Bot Token** — from step 2.4
2. **Guild ID** — from step 4.3
3. **User ID** — your own, from step 4.3
4. **Control Channel ID** — from step 4.3
5. **Bridge port** — default `3847`, change only on conflicts
6. **Your name** — how the master agent should address you in replies
7. **MCP name** — default `claudestra`, only change if you know why

It then:

- Writes `.env`.
- Renders `master/CLAUDE.md.template` → `master/CLAUDE.md` with your name substituted.
- Prints the commands you need for steps 7 and 8.

---

## 7. Register the MCP server

Register the Claudestra channel-server as a global MCP server so every Claude Code process can load it:

```bash
# Remove a previous registration, if any
claude mcp remove claudestra -s user 2>/dev/null

# Register
claude mcp add claudestra -s user -- bun run ~/repos/claudestra/src/channel-server.ts
```

If you used a non-default `MCP_NAME` in step 6, substitute that name in both commands.

---

## 8. Start the pm2 services

```bash
cd ~/repos/claudestra
pm2 start ecosystem.config.cjs
pm2 save
```

On first install, also enable auto-start on reboot:

```bash
pm2 startup
# pm2 prints a sudo command; copy and run it once
```

The ecosystem file starts three processes:

| Process | Purpose |
|---------|---------|
| `discord-bridge` | Discord gateway + WebSocket router |
| `master-launcher` | Keeps the master tmux session alive and auto-confirms Claude Code prompts |
| `cron-scheduler` | Runs scheduled jobs and reports results |

Verify everything is online:

```bash
pm2 list
```

All three should be `online`.

---

## 9. First conversation

Open Discord on any device, go to your control channel, and send something like:

> @claudestra hello

Within a few seconds you should see a welcome message plus three buttons: **Agent Status**, **Browse Sessions**, **New Agent**. Click any of them — the response is immediate because admin buttons bypass the LLM.

If nothing happens, skip to [Troubleshooting](#13-troubleshooting).

---

## 10. Attaching from your terminal

When you're back at your desk you can jump straight into any running session.

```bash
# iTerm2: every session becomes a native tab
tmux -S /tmp/claude-orchestrator/master.sock -CC attach

# Plain mode: Ctrl-B + W to pick a window
tmux -S /tmp/claude-orchestrator/master.sock attach
```

Every agent is a window inside the `master` tmux session. The master window itself (window 0) is the orchestrator — the agent that listens to your control channel.

---

## 11. Upgrading

From Discord, ask the master agent to upgrade:

> check for updates

or

> upgrade the code

The master will run:

```bash
bun src/manager.ts version   # show status
bun src/manager.ts update    # git pull + pm2 restart
```

You can also do it manually:

```bash
cd ~/repos/claudestra
git pull
pm2 restart ecosystem.config.cjs
```

Both produce the same result. The Discord path is more convenient from your phone.

---

## 12. Uninstalling

```bash
pm2 delete discord-bridge master-launcher cron-scheduler
claude mcp remove claudestra -s user
trash ~/repos/claudestra ~/.claude-orchestrator /tmp/claude-orchestrator
# or use `rm -rf` if you don't have `trash`
```

Removing the bot from Discord: Server Settings → Members → right-click the bot → Kick. To also delete the bot entirely, revoke the application in the Developer Portal.

---

## 13. Troubleshooting

### The bot is online but ignores messages

Check Privileged Intents. All three must be enabled on the Developer Portal. Discord silently drops events the bot is not entitled to receive.

```bash
pm2 logs discord-bridge --lines 50
```

Look for `received message` lines. If there are none, the intents are the problem.

### The bot responds to buttons but not to messages

Your user ID is probably missing from `ALLOWED_USER_IDS`. Re-run `bun run setup` or edit `.env` directly and `pm2 restart discord-bridge`.

### Master agent never comes online

```bash
pm2 logs master-launcher --lines 50
```

Common causes:

- Claude Code authentication expired — run `claude` in a terminal once to re-auth.
- MCP server is not registered — redo step 7.
- `master/CLAUDE.md` missing — re-run `bun run setup`.

### Screenshot command fails on mobile

Discord caches slash commands per client for up to one hour. The first time you switch from global commands to guild-scoped ones, mobile clients may still show the old command. Restart Discord on your phone to clear the cache.

### `bun run setup` can't find `master/CLAUDE.md.template`

You are probably running it from outside the repository directory. Always `cd ~/repos/claudestra` first.

### Bridge keeps restarting

```bash
pm2 logs discord-bridge --err --lines 100
```

Usually this means the bot token is wrong, expired, or the `.env` file has a typo. Regenerate the token in the Developer Portal and re-run `bun run setup`.

---

## Where things live

| Path | Contents |
|------|----------|
| `~/repos/claudestra` (or wherever you cloned it) | Source code |
| `~/repos/claudestra/.env` | Runtime configuration (git-ignored) |
| `~/repos/claudestra/master/CLAUDE.md` | Rendered master agent instructions (git-ignored) |
| `~/.claude-orchestrator/registry.json` | Active agent registry |
| `~/.claude-orchestrator/cron.json` | Scheduled jobs |
| `~/.claude-orchestrator/cron-history.json` | Recent cron execution records |
| `/tmp/claude-orchestrator/master.sock` | Private tmux socket |
| `~/.claude/projects/` | Claude Code session JSONL files (source of truth for resume) |

---

## Next steps

- Read [CLAUDE.md](./CLAUDE.md) for an architecture deep-dive (written for contributors and agents).
- Look at `tests/cron.test.ts` to understand the cron expression grammar.
- Experiment with the `send_to_agent` MCP tool to build multi-agent workflows.
- Set up a scheduled job that runs every morning and reports to your control channel.
