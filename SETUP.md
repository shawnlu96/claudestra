# Installation Guide

**English** · [简体中文](./SETUP.zh-CN.md)

The short version: **run `bun run setup`**. The interactive wizard walks you through every step with embedded instructions — you don't need to read this document.

This file exists as a reference for:

- Troubleshooting when the wizard errors out.
- Understanding what the wizard does under the hood.
- Operators who prefer to configure things by hand.

---

## Quick start

```bash
# 1. Install prerequisites (skip anything you already have)
brew install tmux                             # macOS
curl -fsSL https://bun.sh/install | bash      # Bun
npm install -g pm2                            # pm2
npm install -g @anthropic-ai/claude-code      # Claude Code 2.1.80+

# 2. Clone and run the wizard
curl -fsSL https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh | bash
cd ~/repos/claudestra
bun run setup
```

> **Tip:** `raw.githubusercontent.com` caches responses for ~5 minutes. If you're grabbing the installer right after a new release, add a cache-busting query string so you definitely get the latest script:
>
> ```bash
> curl -fsSL "https://raw.githubusercontent.com/shawnlu96/claudestra/main/install.sh?t=$(date +%s)" | bash
> ```

That's it. The wizard does everything else: it checks your dependencies, walks you through creating a Discord bot (with embedded links and click-by-click instructions), collects every ID it needs, writes `.env`, renders `master/CLAUDE.md`, registers the MCP server, and starts pm2.

### What you get out of the box

- **Multi-agent orchestration** — the master in `#control` spawns per-agent Discord channels, routes messages, attaches screenshots, handles interrupts.
- **Auto-update** — Claudestra itself polls for new releases every 30 min; Claude Code CLI every 7 days. Both are toggleable via `bun src/manager.ts auto-update status|<target> on|off`.
- **Discord slash autocomplete** — every skill in `~/.claude/skills/`, installed plugins, each agent's project-level `<cwd>/.claude/skills/`, plus a curated set of Claude Code built-ins (`/cost`, `/context`, `/compact`, `/mcp`, `/review`, …) show up as Discord slash commands. Rescanned every 30 min.
- **TUI modal adaptation** — numbered menus (`/model`) and arrow sliders (`/effort`) render as Discord buttons. Anything bridge can't parse → 🤖 button escalates to the master agent.
- **Cron scheduling** — `cron-add` / `cron-list` / `cron-history`; temporary agents spin up, run a prompt, report, and clean up.
- **Wedge detection** — if an agent's tmux pane stays unchanged for 30+ min while not idle, you get an @mention with one-click Esc / Ctrl+C rescue buttons.
- **`manager.ts cost` + `metrics`** — token-usage rollup from JSONL files + bridge event log summary.
- **Auto-interrupt on new message** — sending a Discord text while Claude is mid-task auto-injects Ctrl+C so the new message redirects instead of queuing.

---

## What the wizard actually does

The `bun run setup` command runs through eight numbered steps:

1. **Check system dependencies** — verifies `git`, `tmux`, `bun`, `pm2`, `claude` are installed and prints install commands for anything missing.
2. **Create a Discord application** — opens the Developer Portal and tells you which button to click.
3. **Get the bot token** — instructs you to reset the token and paste it. Validates length and format.
4. **Enable privileged intents** — reminds you which three intents to enable (bot silently drops messages otherwise).
5. **Invite the bot** — walks through the OAuth2 URL Generator with the exact scopes and permissions to select.
6. **Collect Discord IDs** — enables Developer Mode, then asks for guild ID, user ID, and control channel ID, validating each as a 17–20 digit snowflake.
7. **Set preferences** — your display name, MCP server name (default `claudestra`), and bridge port (default `3847`).
8. **Finalize** — writes `.env`, renders `master/CLAUDE.md` from the template, then optionally runs `bun install`, `playwright install`, `claude mcp add`, and `pm2 start` automatically.

After the wizard finishes, open Discord and say anything to the bot in your control channel. The master orchestrator will reply within a few seconds.

---

## Configuration reference

The wizard writes `.env` with seven variables:

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Bot token from the Developer Portal |
| `DISCORD_GUILD_ID` | Your Discord server (guild) ID |
| `ALLOWED_USER_IDS` | Comma-separated Discord user IDs that may talk to the bot |
| `CONTROL_CHANNEL_ID` | The control (master) channel ID |
| `BRIDGE_PORT` | WebSocket port (default `3847`) |
| `USER_NAME` | How the master agent addresses you in replies |
| `MCP_NAME` | MCP server name used by `claude mcp add` (default `claudestra`) |

Edit `.env` directly and `pm2 restart discord-bridge` to apply changes.

Runtime-mutable toggles live in a separate file — `~/.claude-orchestrator/config.json` — and are managed via `bun src/manager.ts auto-update ...`:

```bash
bun src/manager.ts auto-update status              # inspect current flags
bun src/manager.ts auto-update claudestra on|off   # this project's self-update (30-min poll)
bun src/manager.ts auto-update claude on|off       # Claude Code CLI auto-update (weekly poll)
```

Both default to `on`. The config file is lazily created on first write; you don't need to seed it manually.

---

## Manual installation (without the wizard)

If you really want to skip the wizard:

```bash
git clone https://github.com/shawnlu96/claudestra.git ~/repos/claudestra
cd ~/repos/claudestra
bun install
npx playwright install chromium

cp .env.example .env
# Edit .env and fill in all seven variables

sed "s/{{USER_NAME}}/YourName/g" master/CLAUDE.md.template > master/CLAUDE.md

claude mcp add claudestra -s user -- bun run $(pwd)/src/channel-server.ts

pm2 start ecosystem.config.cjs
pm2 save
```

---

## Upgrading

By default both Claudestra and Claude Code auto-update in the background — you don't need to do anything. Claudestra polls every 30 min, Claude Code weekly, and the upgrade only fires while every agent is idle. You get an @mention in `#control` before and after.

**To disable auto-update:**

```bash
bun src/manager.ts auto-update claudestra off   # stop updating this project
bun src/manager.ts auto-update claude off       # stop updating Claude Code CLI
```

**To trigger a manual upgrade:**

From Discord, ask the master agent:

> check for updates

or

> upgrade the code

That runs:

```bash
bun src/manager.ts version   # show status
bun src/manager.ts update    # git pull + pm2 restart
```

Or by hand:

```bash
cd ~/repos/claudestra
git pull
pm2 restart ecosystem.config.cjs
```

---

## Uninstalling

```bash
pm2 delete discord-bridge master-launcher cron-scheduler
claude mcp remove claudestra -s user
trash ~/repos/claudestra ~/.claude-orchestrator /tmp/claude-orchestrator
```

The `~/.claude-orchestrator` directory contains registry, config (auto-update toggles), cron jobs, and the metrics log — deleting it wipes all runtime state. If you only want to pause the bot without forgetting its state, `pm2 stop` everything and skip the `trash` line.

To remove the bot from Discord, kick it from your server. To delete it entirely, revoke the application in the Developer Portal.

---

## Troubleshooting

### Wizard can't find `master/CLAUDE.md.template`

Run it from inside the repo: `cd ~/repos/claudestra && bun run setup`.

### Bot is online but ignores messages

Check **Privileged Intents** — all three must be enabled on the Developer Portal. Discord silently drops events the bot isn't entitled to.

```bash
pm2 logs discord-bridge --lines 50
```

If there are no "received message" lines, intents are the problem.

### Bot responds to buttons but not to text

Your user ID is probably missing from `ALLOWED_USER_IDS`. Re-run `bun run setup` or edit `.env` directly and `pm2 restart discord-bridge`.

### Master agent never comes online

```bash
pm2 logs master-launcher --lines 50
```

Common causes:

- Claude Code auth expired → run `claude` once in a terminal to re-auth.
- MCP server not registered → re-run `bun run setup` or do `claude mcp add` manually.
- `master/CLAUDE.md` missing → re-run `bun run setup`.

### Bridge keeps restarting

```bash
pm2 logs discord-bridge --err --lines 100
```

Usually means the bot token is wrong or `.env` has a typo. Regenerate the token in the Developer Portal and re-run `bun run setup`.

### Slash commands missing or stale

Discord caches slash commands per client for up to an hour. If you've just installed a new Claude Code plugin or added a skill to `~/.claude/skills/` and the command isn't showing up in Discord autocomplete:

1. Wait up to 30 min (bridge rescans + re-registers automatically) **or** `pm2 restart discord-bridge` to force an immediate rescan.
2. Then restart the Discord mobile/desktop app to clear its client-side cache.

The same applies if Discord is still showing an old command list after a Claudestra upgrade.

---

## Where things live

| Path | Contents |
|------|----------|
| `~/repos/claudestra` | Source code (or wherever you cloned it) |
| `~/repos/claudestra/.env` | Runtime configuration (git-ignored) |
| `~/repos/claudestra/master/CLAUDE.md` | Rendered master agent instructions (git-ignored) |
| `~/.claude-orchestrator/registry.json` | Active agent registry |
| `~/.claude-orchestrator/config.json` | Auto-update toggles (created lazily on first `auto-update` call) |
| `~/.claude-orchestrator/cron.json` | Scheduled jobs |
| `~/.claude-orchestrator/cron-history.json` | Recent cron execution records |
| `~/.claude-orchestrator/metrics.jsonl` | Append-only bridge event log (summarised via `manager.ts metrics`) |
| `/tmp/claude-orchestrator/master.sock` | Private tmux socket |
| `~/.claude/projects/` | Claude Code session JSONL files (source of `manager.ts cost`) |

---

## Next steps

- Read [CLAUDE.md](./CLAUDE.md) for an architecture overview (written for contributors and agents).
- Try `send_to_agent` MCP tool for agent-to-agent workflows.
- Set up a cron job that runs every morning and reports to your control channel.
