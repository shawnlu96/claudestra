# Claudestra Web Client — Setup & Run

The **Next.js web frontend** for Claudestra — a second front door beside Discord.
It is a standard **Node/npm** app that talks only to the Bridge's HTTP API
(`/api/v1` + `/api/v1/events`); it does **not** embed the Bun backend.

What you get:

- **Multi-session streaming chat** — one conversation per agent, tool calls render
  as live cards (running = blue / done = green / failed = red), Write/Edit show
  syntax-highlighted diffs, interrupts and permission/AskUserQuestion prompts are
  interactive cards.
- **Live remote terminal** — a real read-write mirror of the agent's tmux pane,
  with a mobile control bar (Esc / Tab / arrows / Ctrl-C / …).
- **Chat history search** — full-text search across every session (live + archived),
  globally from the sidebar or per-session from the top bar.
- **Skills panel** — browse and launch every discovered skill/slash command from a
  button next to the composer; pin favourites, the rest auto-sort by usage.
- **Background-task threads** — subagents and background shells stream into
  collapsible panels instead of flooding the main conversation.
- **PWA-installable** — add to your phone's home screen for a full-screen app feel;
  optional OneSignal web push.
- Profile customisation (your + Claude's avatar/nickname), session management
  (create / kill / restart / clear / multi-select delete), per-agent init messages.

> Architecture & internals live in [`web/CLAUDE.md`](./CLAUDE.md). The wire
> contract (auth, history pagination, SSE events) is in
> [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md). This file is just
> "how do I install and run it."

---

## Prerequisites

- **Node.js ≥ 20** + npm (Next 16 / React 19). The web app runs on Node, entirely
  separate from the Bun backend — two independent dependency trees.
- **The Claudestra Bridge must be running** and reachable at `BRIDGE_HTTP_URL`
  (default `http://127.0.0.1:3847`). Two ways to get there:
  - **A — you already run Claudestra with Discord** (see [`../SETUP.md`](../SETUP.md)):
    the Bridge, the `claudestra` MCP server, and the Stop hook are already wired by
    `bun run setup`. Skip to [Install the web app](#1-install-the-web-app).
  - **B — Web-only, no Discord bot**: see
    [Run the backend in Web-only mode](#web-only-backend-no-discord) first.
- **Bun** — only needed to run the backend and to issue the API token below.
- **SSH login enabled on the machine.** The web app authenticates against your OS
  account via local SSH/PAM (no separate account system). On macOS enable
  *System Settings → General → Sharing → Remote Login*; otherwise login fails.

---

## 1. Install the web app

```bash
cd web
npm install
```

No monorepo checkout is required: `@do-md/zenith` and `@do-md/common` are vendored
under `web/.packages/` (committed, resolved via `tsconfig.json` paths).
`@do-md/core-react` comes from npm like any other dependency.

---

## 2. Configure environment

```bash
cp .env.example .env.local
```

Fill `.env.local`:

| Variable | Required | Notes |
|---|---|---|
| `CLAUDESTRA_API_TOKEN` | **yes** | Bridge `/api/v1` Bearer token. Issue it (see below). The BFF sends it server-side; the browser never sees it. |
| `BRIDGE_HTTP_URL` | yes | Default `http://127.0.0.1:3847`. **Use `127.0.0.1`, not `localhost`** — the Bridge binds IPv4 only; the `::1` ambiguity causes intermittent 10s `fetch failed` timeouts. |
| `INTERNAL_API_KEY` | yes | Random secret (`openssl rand -hex 32`). Alternative auth (`x-api-key`) for scripts hitting protected API routes. |
| `NEXT_PUBLIC_ONESIGNAL_APPID` / `ONESIGNAL_APP_ID` / `ONESIGNAL_REST_API_KEY` | no | OneSignal Web Push. Leave blank to run without push. |
| `CLAUDESTRA_DATA_ROOT` | no | Overrides the data dir (default `~/.claude-orchestrator/web`), which holds the SQLite for auth sessions + per-agent settings. |

**Issue the API token** (from the repo root, replace `bun` path as needed):

```bash
bun src/manager.ts token-add web-ui --agents '*,master' --force --terminal
```

- `--agents '*,master'` — `*` covers all non-master agents; **`master` must be
  listed explicitly** (the wildcard excludes it).
- `--force` — acknowledges the shared-context guard for non-`--external` agents.
- `--terminal` — grants the **remote terminal** (the 🖥️ live-tmux feature). This is
  **host-shell-level access**: a terminal can Ctrl-C out of Claude Code into a raw
  shell, bypassing `--disallowedTools`. It is a separate capability from messaging,
  so it must be granted explicitly. Drop `--terminal` if you don't want the web
  terminal — chat/history/interrupt all work without it.

Copy the printed token into `CLAUDESTRA_API_TOKEN`.

---

## 3. Run (development)

```bash
npm run dev        # → http://localhost:33333
```

macOS gotchas (only if your shell exports these globally):

- Global `NODE_ENV=production` shadows dev mode → `NODE_ENV=development npm run dev`.
- Global `INTERNAL_API_KEY` shadows `.env.local` → `env -u INTERNAL_API_KEY npm run dev`.
- Turbopack cold start: the first few requests after a restart may 401/502 while
  env/compilation settles — just refresh.

## 4. Run (production)

```bash
npm run build
npm run start      # → http://localhost:3333
```

Ports are deliberately non-default (dev `33333` / prod `3333`) to avoid clashing
with sibling apps on the same machine.

## 5. Log in

Open the app → you're redirected to `/login`. Enter your **OS username + password**
— verified by a local SSH connection to `127.0.0.1:22` (PAM). On success a
7-day HttpOnly `cstra_session` cookie is set and you land on `/chat`.

New agents are created by talking to the master orchestrator (👑 大总管) in chat —
there is no separate "new session" button by design.

---

## 6. Access from your phone (remote access)

The whole point of Claudestra is driving your workstation from your phone. Three
tiers, in order of recommendation:

### Same Wi-Fi (zero setup)

`npm run start` listens on all interfaces, so any device on the same network can
open `http://<your-mac-lan-ip>:3333` (find the IP under *System Settings → Wi-Fi →
Details*, or `ipconfig getifaddr en0`). Log in with the same OS username/password.

Good for a quick test; useless once you leave the house.

### Tailscale (recommended)

[Tailscale](https://tailscale.com) gives every device a stable private IP over
WireGuard — no port forwarding, no public exposure, free for personal use:

1. Install Tailscale on the workstation and on your phone, log both into the same
   tailnet.
2. From your phone, open `http://<machine-name>:3333` (MagicDNS) or
   `http://100.x.y.z:3333`.

For **HTTPS** (required for PWA service workers and web push — plain-HTTP access
works for chat but installs as a degraded PWA), let Tailscale terminate TLS with a
real certificate:

```bash
tailscale serve --bg 3333
# → https://<machine-name>.<tailnet>.ts.net
```

That URL is reachable only from inside your tailnet, but carries a browser-trusted
certificate — the ideal endpoint to install the PWA from.

### Public reverse proxy (advanced, only if you know why you need it)

Put Caddy/nginx with TLS in front of port `3333` on a domain you own. Keep in mind:

- **Never** port-forward `3333` (or Bridge's `3847`) raw to the internet. The web
  login is your **OS account password** — brute-forcing it is brute-forcing your
  machine.
- Add your own rate limiting / IP allowlist / 2FA layer at the proxy.
- `BRIDGE_BIND` stays `127.0.0.1` — only the Next.js app needs to be reachable;
  the browser never talks to the Bridge directly.

### Install as a PWA

Once the app is reachable over HTTPS (or you accept degraded mode over HTTP):

- **iOS Safari** — open the URL → Share sheet → **Add to Home Screen**. Launches
  full-screen (standalone), with app icon and safe-area-aware layout.
- **Android Chrome** — open the URL → ⋮ menu → **Install app** (or accept the
  install banner).

> iOS caches the manifest at install time — after big upgrades, if icons or
> full-screen behaviour look stale, delete the home-screen icon and re-add it.

---

## Run it as a service (macOS launchd)

`npm run start` dies with your terminal. For an always-on deployment, register
the web app as a LaunchAgent — `~/Library/LaunchAgents/com.claudestra.web.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claudestra.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>exec ./node_modules/.bin/next start -p 3333</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/YOU/path/to/claude-orchestrator/web</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/claudestra-web.log</string>
  <key>StandardErrorPath</key><string>/tmp/claudestra-web.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudestra.web.plist

# after every web/ code update:
cd web && npm run build && launchctl kickstart -k gui/$(id -u)/com.claudestra.web
```

- ⚠ **`exec` straight into `next`, not `npm run start`** — an npm intermediary
  process can leave an orphaned `next-server` behind when launchd kills the job.
  The orphan keeps its push dispatcher alive with no listening port, and every
  web push then arrives **twice** (July 2026 incident: 5 days of duplicated
  notifications).
- The push dispatcher takes an exclusive lock on `127.0.0.1:3339`
  (`PUSH_LOCK_PORT`) so that even if two server processes coexist (prod + dev,
  or a leaked orphan), only one sends pushes. `lsof -iTCP:3339` shows the holder.

## HTTPS when `tailscale serve` won't cooperate (Caddy + `tailscale cert`)

`tailscale serve` (previous section) is the zero-config path — try it first. On
some macOS GUI-app installs it fails with `The Tailscale GUI failed to start
(CLIError error 3)` and cannot write serve config. Fallback: issue the tailnet
certificate yourself and let Caddy terminate TLS. Caddy also gives you HTTP/2 —
a naive TCP tunnel is HTTP/1.1-only, which serializes Safari's six
connections-per-host and crawls on mobile.

```bash
brew install caddy
mkdir -p ~/.claude-orchestrator/web/tls ~/.claude-orchestrator/web/caddy
tailscale cert \
  --cert-file ~/.claude-orchestrator/web/tls/mac.crt \
  --key-file  ~/.claude-orchestrator/web/tls/mac.key \
  <machine>.<tailnet>.ts.net
```

`~/.claude-orchestrator/web/caddy/Caddyfile`:

```
{
	auto_https off
	admin off
}

https://<machine>.<tailnet>.ts.net:443 {
	tls /Users/YOU/.claude-orchestrator/web/tls/mac.crt /Users/YOU/.claude-orchestrator/web/tls/mac.key
	# Response compression — not optional if clients come in over slow links.
	# Neither `next start` nor the bridge compresses; without this a large chat
	# history JSON (hundreds of kB) ships raw and can take 10s+ on a lossy
	# cross-border path (2026-07-24: 560 kB → 102 kB, 13.9s → 0.3s). SSE is
	# safe: caddy's encode flushes per event, verified no buffering.
	encode zstd gzip
	handle {
		reverse_proxy 127.0.0.1:3333
	}
}
```

(Other projects on the same machine may add their own routes to this
Caddyfile — that is between them and Caddy, out of scope here.)

Then a second LaunchAgent (same skeleton as `com.claudestra.web.plist` above)
whose `ProgramArguments` runs
`/opt/homebrew/bin/caddy run --config /Users/YOU/.claude-orchestrator/web/caddy/Caddyfile`,
with logs pointed at `~/.claude-orchestrator/web/caddy/`. Bootstrap it the same
way.

- Register **exactly one** caddy LaunchAgent. Caddy binds 443 with
  `SO_REUSEPORT`, so a duplicate registration silently starts a *second* copy
  load-balancing the same port instead of failing loudly.
- Non-root processes may bind 443 on modern macOS (wildcard address).
- **Certificate renewal** — `tailscale cert` certificates last ~90 days and do
  not auto-renew here. Check expiry with
  `openssl x509 -enddate -noout -in ~/.claude-orchestrator/web/tls/mac.crt`,
  re-run the `tailscale cert` command above, then
  `launchctl kickstart -k gui/$(id -u)/<your-caddy-label>`.

### Custom domain on the same tailnet (when `*.ts.net` won't resolve)

Some networks cannot resolve `*.ts.net` at all (e.g. mainland-China DNS
filtering) — the tailnet link itself works fine, but the browser never gets an
IP. Fix: point **your own domain** at the tailnet IP and terminate TLS for it in
the same Caddy. Traffic still flows only over Tailscale — a tailnet
`100.x.y.z` A record is unroutable from the public internet, so this adds an
entry point, not exposure.

1. **DNS**: add an A record `claude.your-domain.com → 100.x.y.z` (the machine's
   tailnet IP, `tailscale ip -4`). On Cloudflare use **DNS-only** (grey cloud) —
   proxying (orange cloud) would obviously fail to reach a tailnet IP.
2. **Certificate**: `tailscale cert` only signs `*.ts.net` names, so issue a
   Let's Encrypt cert via **DNS-01** (the host needn't be publicly reachable —
   perfect fit here). E.g. with [acme.sh](https://github.com/acmesh-official/acme.sh)
   and a Cloudflare API token:

   ```bash
   acme.sh --issue --dns dns_cf -d 'your-domain.com' -d '*.your-domain.com'
   acme.sh --install-cert -d 'your-domain.com' \
     --fullchain-file ~/.claude-orchestrator/web/tls/custom/fullchain.pem \
     --key-file       ~/.claude-orchestrator/web/tls/custom/key.pem \
     --reloadcmd "launchctl kickstart -k gui/$(id -u)/<your-caddy-label>"
   ```

3. **Caddy**: append a second site block to the same Caddyfile (do **not** start
   a second caddy — see the single-instance warning above):

   ```
   https://claude.your-domain.com:443 {
   	tls /Users/YOU/.claude-orchestrator/web/tls/custom/fullchain.pem /Users/YOU/.claude-orchestrator/web/tls/custom/key.pem
   	encode zstd gzip
   	handle {
   		reverse_proxy 127.0.0.1:3333
   	}
   }
   ```

   Validate + restart: `caddy validate --config <Caddyfile>` then
   `launchctl kickstart -k gui/$(id -u)/<your-caddy-label>`.
4. **Auto-renewal**: schedule `acme.sh --cron` daily (launchd/crontab). Unlike
   the `tailscale cert` path, DNS-01 renewals are fully unattended — the
   `--reloadcmd` above restarts Caddy with the fresh cert. The `ts.net` block
   can stay alongside as a second entry point.

## Port map (production)

| Port  | Bind         | What |
|-------|--------------|------|
| 443   | all (tailnet-reachable) | Caddy TLS/h2 → 3333 (only on the Caddy path) |
| 3333  | all interfaces | Next.js web app, production |
| 33333 | all interfaces | Next.js dev server |
| 3847  | 127.0.0.1    | Bridge HTTP + WebSocket (`BRIDGE_PORT`/`BRIDGE_BIND`) |
| 3339  | 127.0.0.1    | Web-push dispatcher lock (`PUSH_LOCK_PORT`) |

Request path: phone → Caddy `:443` (TLS, tailnet-only) → Next.js `:3333`
(BFF, session cookie) → Bridge `:3847` (Bearer token) → tmux / Claude Code.

---

## Web-only backend (no Discord)

If you don't want a Discord bot, run the Bridge in **Web-only mode** — it detects
the absence of `DISCORD_BOT_TOKEN` and skips all Discord init while still serving
the `/api/v1` + `/api/v1/events` the web app needs.

### One-time backend prerequisites

1. **tmux ≥ 3.2** (`brew install tmux`). Agents are tmux windows; the live remote
   terminal needs grouped sessions.
2. **Register the channel-server MCP** so Claude Code sessions can reach the Bridge:
   ```bash
   claude mcp add claudestra -s user -- ~/.bun/bin/bun run <repo>/src/channel-server.ts
   ```
3. **Register the Stop / Notification hook** (REQUIRED for the web UI) in
   `~/.claude/settings.json`, so turn-end (`done`) is emitted — without it the web
   composer never unlocks and streamed messages never finalize to rendered Markdown:
   ```jsonc
   "hooks": {
     "Stop":        [{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}],
     "StopFailure": [{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}],
     "Notification":[{ "matcher": "", "hooks": [{ "type": "command", "command": "<bunAbs> <repo>/src/hooks/typing-hook.ts" }]}]
   }
   ```
   `typing-hook.ts` exits silently when there's no channel context, so it's harmless
   for unrelated Claude Code sessions.

### Start the Bridge (foreground)

```bash
# from repo root
unset DISCORD_BOT_TOKEN
CONTROL_CHANNEL_ID=local-master-control bun run src/bridge.ts
```

### Create an agent

```bash
bun src/manager.ts create <name> <existing-dir> [purpose]
```

> The working dir **must already exist**. Avoid `/tmp` — its `/private` symlink
> misplaces Claude Code's session jsonl slug.

### Persistent (recommended, macOS launchd)

Wrapper scripts are provided:

- `scripts/web-only-bridge.sh` — idempotently ensures the `master` tmux session and
  execs the Bridge in Web-only mode.
- `scripts/web-only-launcher.sh` — optional; keeps a master orchestrator (大总管)
  Claude Code alive in window 0 and auto-dismisses its startup trust/bypass prompts.

Wire them into LaunchAgents (`com.claudestra.web-bridge` / `com.claudestra.web-launcher`)
with `RunAtLoad` + `KeepAlive`. **Both must share the same `CONTROL_CHANNEL_ID`.**
After changing bridge code, reload with:

```bash
launchctl kickstart -k gui/$(id -u)/com.claudestra.web-bridge
```

---

## Reference

- [`web/CLAUDE.md`](./CLAUDE.md) — internal architecture, data flow, PWA gotchas.
- [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md) — the `/api/v1` +
  `/events` contract (auth, history pagination, SSE event types).
- [`docs/design-multi-frontend.md`](../docs/design-multi-frontend.md) — multi-frontend
  design (chat_id keyspace, NeutralMessage, ChatAdapter).
- [`FORK.md`](../FORK.md) — what this fork adds on top of upstream (additive-only).
