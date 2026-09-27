# Installation Guide

**English** · [简体中文](./SETUP.zh-CN.md)

The short version: **run `bun run setup`**. The interactive wizard walks you through every step with embedded instructions — you don't need to read this document.

This file exists as a reference for:

- Troubleshooting when the wizard errors out.
- Understanding what the wizard does under the hood.
- Operators who prefer to configure things by hand.

> **Two front doors — the web client is the default.** The wizard installs the
> **web client** by default: a PWA-installable app with streaming chat, a live
> remote terminal and chat-history search. It is a static bundle (`web/out`)
> that the bridge serves itself — no second service, no account, no password:
> a browser is **paired** to your machine once (`claudestra pair`, QR / link /
> 8-char code) and then just opens. The wizard also sets up phone access: the
> relay by default (one address for every machine, nothing to install on the
> phone; ENTER picks the official relay), or Tailscale if you prefer.
>
> **Discord is optional** (you would create your own bot — 5 extra steps) and is
> only asked about if you pick it at the "Pick your frontends" step. The Discord
> sections below only matter if you did. For web details see
> **[web/SETUP.md](./web/SETUP.md)**.

---

## Quick start

```bash
# 1. Install prerequisites (skip anything you already have)
brew install tmux                             # macOS
curl -fsSL https://bun.sh/install | bash      # Bun
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

That's it. The wizard does everything else: it checks your dependencies, walks you through creating a Discord bot (with embedded links and click-by-click instructions), collects every ID it needs, writes `.env`, renders `master/CLAUDE.md`, registers the MCP server, and installs the three launchd daemons.

### Cross-Claudestra peer collaboration (HTTP peers)

Two Claudestra instances can share specialist agents without a shared Discord server, a second bot, or filesystem / SSH access — peers are simply API clients of each other, each holding a Bearer token the other side issued and scoped to specific agents.

**One-click invite (v2.15+, recommended)** — two steps, no forms:

1. **A creates an invite**: in the web client, Settings → Peer collaboration → *Create invite* (pick which agents to expose), or `bun src/manager.ts peer-invite-new --agents <a,b>`. On the relay this is a link (`https://<relay>/i#…`); without a relay it's a string. Send it to the other side over any private channel (DM, Signal, whatever).
2. **B opens it** (link → lands in their own Claudestra's join page, one click) **or pastes it**: Settings → Peer collaboration → *Join*, or `bun src/manager.ts peer-join-auto '<invite>'`. B's bridge calls A back automatically — done. A gets a notification with the new peer's name.

Invites are single-use and expire after 24h (the embedded token is revoked on expiry/revocation — `peer-invite-list` / `peer-invite-revoke <id>` manage pending ones). Joining exposes **nothing** of B by default: it's a one-way grant (B can call A's shared agents). For two-way access, B sends A an invite of their own — the entries merge into one peer.

The older three-step handshake (`peer-http-invite` / `peer-http-join` / `peer-http-accept`) still works and is what you need when the other side runs a pre-v2.15 Claudestra.

From then on any agent can call `send_to_agent({ target: "<agent>@<peer>", text: "..." })` — the bridge POSTs the peer's `/api/v1` messages endpoint and pushes the reply back to the caller as a synthetic message, no polling. `peer-http-list` shows peers + handshake state; `peer-http-remove <peer>` deletes the peer and revokes the token you issued, cutting access instantly.

Notes:

- **Token scope is the permission model**: only agents named in the invite are callable; anything else gets a 403. `peer-http-scope <peer> --agents ...` changes it later without re-handshaking.
- **The master orchestrator can never be shared** — hard rule since v2.15, `--force` does not override it (and legacy peer tokens that list master are cut off at the API layer).
- **`--force` for non-external agents**: exposing an agent not created with `--external` requires `--force` (a confirm dialog in the web UI) — agents sharing context with your own conversations shouldn't be casually exposed (the R1 guard).
- **Connectivity**: on the relay (next section, the default) there is nothing to do — both sides only hold an outbound connection, and peer addresses are `relay://<fingerprint>`. Without a relay the two bridges must reach each other directly: the bridge listens on `127.0.0.1` only by default, so set `BRIDGE_BIND` (invite generation warns you if it's still loopback), and give them a private path — [Tailscale](https://tailscale.com) on both machines (invite URLs auto-prefer the Tailscale address), any private network, or an HTTPS reverse proxy.

### Reach it from anywhere: the relay (default) or Tailscale

The relay is the default way out, and it needs nothing installed on the phone or the other computer. Your bridge keeps one outbound WebSocket to a relay; the relay hosts the web client at **one address** — `https://<relay-domain>/` — and routes `/m/<fingerprint>/api/v1/…` to whichever paired machine you are looking at; it also forwards other instances' peer calls (`relay://<fingerprint>` as the peer address). No public IP, no open port, no certificate on your side. Tailscale is the alternative (traffic stays inside your own private network, no third party): pick option 2 in the wizard's *Phone access* step — it points `tailscale serve` at the **bridge port**, so the address is `https://<mac>.<tailnet>.ts.net/`.

`bun run setup`'s *Phone access* step configures the relay by default: ENTER takes the official relay `wss://relay.sunstriker.cc`, and right after install it prints a pairing QR code — scan it and the phone is paired. Doing it by hand is equivalent to:

1. One line in `.env`, then restart the bridge:

   ```
   RELAY_URL=wss://relay.example.com    # the relay you use (hosted, or one you run yourself)
   RELAY_NAME=mini                      # optional display name in the relay directory (also the legacy subdomain label)
   ```

   The bridge log prints `🛰 中继: 已连接 …`. The machine's identity on the relay is its key fingerprint (`claudestra relay-status`), not a hostname.
2. On the computer run `claudestra pair`: it prints a QR code, a link (`https://relay.example.com/pair#…`) and an 8-character code (10 minutes, single use). Scan the QR with the phone camera, open the link in any browser, or type the code at `https://relay.example.com/` — short-code pairings wait for you to confirm in the terminal (or the web client's Devices panel). The browser then holds a device credential issued by *your* bridge; there is no password. One browser can pair several machines and switch between them in the top bar. The web client's Peer panel has a *Pair a new device* button for the same thing.
3. Invites become links: Settings → Peer collaboration → *Create invite* yields `https://relay.example.com/i#…`. The other side opens it and lands in their own Claudestra's join page; someone without one is guided to install first.

Honest note: this version of the relay terminates TLS and hosts the page's JavaScript, so it can read tunnelled traffic (including the device cookie) — trusting a hosted relay means trusting its operator, like any SaaS. Run your own with [docs/relay/self-host.md](docs/relay/self-host.md); protocol and boundaries are in [docs/relay/protocol.md](docs/relay/protocol.md), the full design in [docs/design-hosted-frontend.md](docs/design-hosted-frontend.md).

### What you get out of the box

- **Multi-agent orchestration** — the master in `#control` spawns per-agent Discord channels, routes messages, attaches screenshots, handles interrupts.
- **Auto-update** — Claudestra itself polls for new releases every 30 min; Claude Code CLI every 7 days. Both are toggleable via `bun src/manager.ts auto-update status|<target> on|off`.
- **Discord slash autocomplete** — every skill in `~/.claude/skills/`, installed plugins, each agent's project-level `<cwd>/.claude/skills/`, plus a curated set of Claude Code built-ins (`/cost`, `/context`, `/compact`, `/mcp`, `/review`, …) show up as Discord slash commands. Rescanned every 30 min.
- **TUI modal adaptation** — numbered menus (`/model`) and arrow sliders (`/effort`) render as Discord buttons. Anything bridge can't parse → 🤖 button escalates to the master agent.
- **Cron scheduling** — `cron-add` / `cron-list` / `cron-history`; temporary agents spin up, run a prompt, report, and clean up.
- **Wedge detection** — if an agent's tmux pane stays unchanged for 30+ min while not idle, you get an @mention with one-click Esc / Ctrl+C rescue buttons.
- **`manager.ts cost` + `metrics`** — token-usage rollup from JSONL files + bridge event log summary.
- **Auto-interrupt on new message** — sending a Discord text while Claude is mid-task auto-injects Ctrl+C so the new message redirects instead of queuing.
- **Multi-frontend API (v2.6+)** — Bearer-token HTTP API (`/api/v1` + SSE `/events`) so any frontend can talk to your agents: `bun src/manager.ts token-add <name> --agents <a,b|*>` issues scoped tokens. The web client below is built entirely on this.
- **Web client (v2.10+)** — PWA-installable app: streaming chat with tool cards and diffs, live remote terminal, chat-history search, Skills panel, background-task threads. A static bundle served by the bridge itself (or by the relay); browsers pair with a code instead of logging in. Build, pairing and phone access: [web/SETUP.md](./web/SETUP.md).
- **Session archive & history (v2.8+)** — every retired session's JSONL is snapshotted to `~/.claude-orchestrator/archive/`, plus a daily sweep of live sessions; chat history survives Claude Code's `cleanupPeriodDays` pruning and stays readable via the history API even after an agent is killed.
- **Background-activity threads (v2.8+)** — subagents and background shell tasks stream into their own Discord threads (auto-archived on completion) instead of flooding the agent's main channel.
- **Claude Code agents-mode guards (v2.7+)** — detects and heals "doppelganger" background sessions created by Claude Code's bg-agent daemon (the ← key trap): `/agents` inventory panel, one-click adopt/cleanup, automatic `--fork-session` retry on restart.

---

## What the wizard actually does

The `bun run setup` command runs through numbered steps — how many depends on which frontends you pick (Discord adds five; the web client adds two: *Build the web frontend* — `npm install` + `npm run build` into `web/out` — and *Phone access*), so expect 8–13 plus an initial language prompt:

1. **Check system dependencies** — verifies `git`, `tmux`, `bun`, `claude` are installed and prints install commands for anything missing.
2. **Create a Discord application** — opens the Developer Portal and tells you which button to click.
3. **Get the bot token** — instructs you to reset the token and paste it. Validates length and format.
4. **Enable privileged intents** — reminds you which three intents to enable (bot silently drops messages otherwise).
5. **Invite the bot** — walks through the OAuth2 URL Generator with the exact scopes and permissions to select.
6. **Collect Discord IDs** — enables Developer Mode, then asks for guild ID, user ID, and control channel ID, validating each as a 17–20 digit snowflake.
7. **Set preferences** — your display name, MCP server name (default `claudestra`), and bridge port (default `3847`).
8. **Finalize** — writes `.env` (including `BRIDGE_STATIC_DIR=<repo>/web/out` when you picked the web client), renders `master/CLAUDE.md` from the template, then optionally runs `bun install`, `playwright install`, `claude mcp add`, and `manager.ts install-cli` (which writes and loads the launchd daemons) automatically.

After the wizard finishes, open `http://127.0.0.1:3847/` in a browser on the machine (or the phone address it printed), or — with Discord — say anything to the bot in your control channel. The master orchestrator will reply within a few seconds.

---

## Configuration reference

The wizard writes `.env` with these variables:

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Bot token from the Developer Portal |
| `DISCORD_GUILD_ID` | Your Discord server (guild) ID |
| `ALLOWED_USER_IDS` | Comma-separated Discord user IDs that may talk to the bot |
| `CONTROL_CHANNEL_ID` | The control (master) channel ID |
| `BRIDGE_PORT` | WebSocket port (default `3847`) |
| `USER_NAME` | How the master agent addresses you in replies |
| `MCP_NAME` | MCP server name used by `claude mcp add` (default `claudestra`) |
| `BRIDGE_STATIC_DIR` | Absolute path of the web client's static bundle (`<repo>/web/out`); written when you pick the web frontend — the bridge serves it at `http://127.0.0.1:<BRIDGE_PORT>/` |
| `RELAY_URL` / `RELAY_NAME` | Relay to connect to (phone access), optional display name — see *Reach it from anywhere* above |

Edit `.env` directly, then reload the bridge:

```bash
launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge
```

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

# Writes ~/Library/LaunchAgents/com.claudestra.{bridge,launcher,cron}.plist,
# loads them, and installs the `claudestra` CLI wrapper into ~/.local/bin
bun src/manager.ts install-cli
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
bun src/manager.ts update    # git pull + reload the three launchd daemons
```

Or by hand:

```bash
cd ~/repos/claudestra
git pull
bun src/manager.ts install-cli   # rewrites + reloads the three daemons
```

---

## Uninstalling

```bash
# 1. Stop and unload the three launchd daemons, then delete their plists.
#    Skipping the plist removal is the classic mistake: launchctl bootout only
#    stops the current instance, and KeepAlive brings it straight back on login.
for svc in bridge launcher cron; do
  launchctl bootout "gui/$(id -u)/com.claudestra.$svc" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/com.claudestra.$svc.plist"
done

# 2. Unregister the MCP server and the CLI wrapper
claude mcp remove claudestra -s user
rm -f ~/.local/bin/claudestra

# 3. Remove the Stop / StopFailure / Notification hooks that point at
#    src/hooks/typing-hook.ts from ~/.claude/settings.json (edit by hand —
#    the file may hold hooks belonging to other tools).

# 4. Delete the code and all runtime state
trash ~/repos/claudestra ~/.claude-orchestrator /tmp/claude-orchestrator
```

The `~/.claude-orchestrator` directory contains the registry, config (auto-update toggles), cron jobs, API tokens, peers, and the session archive — deleting it wipes all runtime state including your chat history snapshots.

To pause the bot without forgetting its state, stop the daemons but leave the plists and state in place:

```bash
for svc in bridge launcher cron; do launchctl bootout "gui/$(id -u)/com.claudestra.$svc"; done
```

To remove the bot from Discord, kick it from your server. To delete it entirely, revoke the application in the Developer Portal.

---

## Troubleshooting

### Start here: `doctor`

```bash
bun src/manager.ts doctor          # human-readable; --json for scripts
```

One command checks the whole install and tells you what to run for anything broken:
runtime versions (bun / claude / tmux), `.env` completeness and file permissions,
whether the Discord allowlist actually has a valid owner, all three launchd daemons,
whether port 3847 has exactly one listener and answers HTTP, MCP registration, typing
hooks, and whether every agent in the registry still has a live tmux window. It is
read-only — it never starts or fixes anything on its own.

If you are asking someone else for help, paste this output first.

### Day-2 basics: is it running, where are the logs, how do I restart it

Claudestra runs as three launchd user agents. Everything below works from any directory.

```bash
# Are they alive? (PID in column 1, "-" means loaded but not running)
launchctl list | grep claudestra

# Logs — stdout and stderr are separate files per daemon
tail -f ~/.claude-orchestrator/logs/bridge.out      # routing, registrations, deliveries
tail -f ~/.claude-orchestrator/logs/bridge.err      # stack traces
tail -f ~/.claude-orchestrator/logs/launcher.out    # master guardian, agent revival
tail -f ~/.claude-orchestrator/logs/cron.out        # scheduled jobs

# Restart one service (-k kills it first, then reloads)
launchctl kickstart -k "gui/$(id -u)/com.claudestra.bridge"

# Reinstall/repair all three plists + the `claudestra` CLI wrapper
bun src/manager.ts install-cli
```

The bridge takes ~15 s to come back after a restart: agents' channel-servers reconnect with exponential backoff, so give it a moment before concluding something is broken.

### Wizard can't find `master/CLAUDE.md.template`

Run it from inside the repo: `cd ~/repos/claudestra && bun run setup`.

### Bot is online but ignores messages

Check **Privileged Intents** — all three must be enabled on the Developer Portal. Discord silently drops events the bot isn't entitled to.

```bash
tail -n 50 ~/.claude-orchestrator/logs/bridge.out
```

If there are no "received message" lines, intents are the problem.

### Bot responds to buttons but not to text

Your user ID is probably missing from `ALLOWED_USER_IDS`. Re-run `bun run setup`, or edit `.env` directly and reload with `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge`.

### Master agent never comes online

```bash
tail -n 50 ~/.claude-orchestrator/logs/launcher.out
```

Common causes:

- Claude Code auth expired → run `claude` once in a terminal to re-auth.
- MCP server not registered → re-run `bun run setup` or do `claude mcp add` manually.
- `master/CLAUDE.md` missing → re-run `bun run setup`.

### Bridge keeps restarting

```bash
tail -n 100 ~/.claude-orchestrator/logs/bridge.err
```

Usually means the bot token is wrong or `.env` has a typo. Regenerate the token in the Developer Portal and re-run `bun run setup`.

### Slash commands missing or stale

Discord caches slash commands per client for up to an hour. If you've just installed a new Claude Code plugin or added a skill to `~/.claude/skills/` and the command isn't showing up in Discord autocomplete:

1. Wait up to 30 min (bridge rescans + re-registers automatically) **or** `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge` to force an immediate rescan.
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

- **Web client details** — [web/SETUP.md](./web/SETUP.md): building the static bundle, pairing devices, reaching it from your phone outside your home network (relay by default, Tailscale optional), HTTPS termination in front of the bridge (tailscale serve or Caddy + `tailscale cert`), certificate renewal, the port map, and retiring the pre-2026-09 `com.claudestra.web` service (`claudestra migrate-web-state` → `claudestra retire-web`).
- Read [CLAUDE.md](./CLAUDE.md) for an architecture overview (written for contributors and agents).
- Try `send_to_agent` MCP tool for agent-to-agent workflows.
- Set up a cron job that runs every morning and reports to your control channel.
