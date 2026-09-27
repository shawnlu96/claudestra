# Claudestra Web Client — Setup & Run

**English** · [简体中文](./SETUP.zh-CN.md)

The **web frontend** for Claudestra — a second front door beside Discord. It is a
**static Next.js export** (`web/out`): no server of its own, no login database.
The bridge serves the files itself and answers every API call; browsers are
**paired** to a machine with a device credential instead of logging in.

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
- **Several machines in one browser** — pair each machine once, switch in the top bar.
- **PWA-installable** — add to your phone's home screen for a full-screen app feel,
  with Web Push (through the relay, or self-signed VAPID when served by the bridge).
- Profile customisation (your + Claude's avatar/nickname), session management
  (create / kill / restart / clear / multi-select delete), per-agent init messages.

> Architecture & internals live in [`web/CLAUDE.md`](./CLAUDE.md). The wire
> contract (auth, history pagination, SSE events) is in
> [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md); the hosted-frontend
> design (pairing, relay path mode, trust boundary) in
> [`docs/design-hosted-frontend.md`](../docs/design-hosted-frontend.md). This file is
> just "how do I build, serve and reach it."

---

## Prerequisites

- **Node.js ≥ 20** + npm — only to **build** the bundle (Next 16 / React 19). Nothing
  Node-based runs afterwards; the bridge (Bun) serves the output.
- **The Claudestra Bridge must be running** (`bun run setup` installs it as
  `com.claudestra.bridge`; Web-only without Discord: see
  [Web-only backend](#web-only-backend-no-discord)).
- Nothing else: no SSH / Remote Login, no `.env.local`, no API token to issue.

## 1. Build

```bash
cd web
npm install
npm run build          # → web/out (static export)
```

No monorepo checkout is required: `@do-md/zenith` and `@do-md/common` are vendored
under `web/.packages/` (committed, resolved via `tsconfig.json` paths).

`bun run setup` does exactly this in its *Build the web frontend* step, and
`claudestra update` / `bun src/manager.ts install-cli` rebuild `web/out` whenever the
last commit touching `web/` moved (`src/lib/web-build.ts`: the previous `.next` and
`out` are cloned first and restored if the build fails, so a broken build never
leaves the site 404). The bridge reads `out/` per request — no restart after a build.

## 2. Serve

The bridge serves the bundle when `.env` has

```
BRIDGE_STATIC_DIR=/absolute/path/to/claudestra/web/out
```

`bun run setup` writes that line when you pick the Web frontend; by hand, add it and
`launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge`. Then open
`http://127.0.0.1:3847/` (your `BRIDGE_PORT`). `GET /app-config.json` tells the page
it is in *direct* mode (`{ mode: "direct", fp, machineName }`); through the relay the
same bundle runs in *relay* mode against `/m/<fingerprint>/api/v1`.

`bun src/manager.ts doctor` has a *前端静态包* group: build freshness, whether
`BRIDGE_STATIC_DIR` points at an existing `index.html`, and — under *launchd daemon* —
a reminder if the pre-2026-09 `com.claudestra.web` plist is still around.

## 3. Pair a browser

There is no password. A browser becomes a **device** of your machine:

```bash
claudestra pair                      # you: all agents + master + terminal + manage
claudestra pair --guest ana --agents a,b --no-terminal   # someone else: a scoped guest
claudestra pair --url https://mac.tail0000.ts.net        # direct entry: QR/link for that address
```

It prints a QR code, a link (`<entry>/pair#<fp>.<secret>`) and an 8-character code
(10 minutes, single use). Scan or open the link and the browser is paired
immediately; typing the code on `/pair` puts the phone into *waiting* until you
confirm in the terminal (or the Devices panel) — a guessed code gets nobody in.
The credential is an HttpOnly cookie issued and verified by *your* bridge; revoke
any device from the Devices panel or `DELETE /api/v1/devices/:id`. A browser on the
machine itself (loopback) pairs automatically. `/login` redirects to `/pair`.

## 4. Development

```bash
npm run dev            # → http://localhost:33333, see web/CLAUDE.md for pointing it at a bridge
```

macOS gotcha: a global `NODE_ENV=production` shadows dev mode →
`NODE_ENV=development npm run dev`.

---

## 5. Access from your phone (remote access)

The whole point of Claudestra is driving your workstation from your phone. In order
of recommendation:

### Relay (default — one address, nothing to install)

`bun run setup`'s *Phone access* step configures this by default: the bridge keeps
one outbound WebSocket to the relay, and **`https://<relay-domain>/`** is the web
client for every machine you pair — HTTPS included, so PWA and push work. Pair with
`claudestra pair` (QR) or type the code on the relay's front page. Details,
self-hosting and the trust boundary: [../docs/relay/README.md](../docs/relay/README.md).
The tiers below are for when you'd rather not route through a relay at all.

### Same Wi-Fi (degraded)

With `BRIDGE_BIND=0.0.0.0` the bridge listens on all interfaces, so any device on
the same network can open `http://<your-mac-lan-ip>:3847/` (find the IP under
*System Settings → Wi-Fi → Details*, or `ipconfig getifaddr en0`). Pair with
`claudestra pair --url http://<lan-ip>:3847`. Plain HTTP: no service worker, no push,
no voice input — fine for a quick test, useless once you leave the house.

### Tailscale (your own private network, no third party)

[Tailscale](https://tailscale.com) gives every device a stable private IP over
WireGuard — no port forwarding, no public exposure, free for personal use. Pick
option 2 in the wizard's *Phone access* step and it walks you through this:

1. Install Tailscale on the workstation and on your phone, log both into the same
   tailnet.
2. Let Tailscale terminate TLS in front of the **bridge port** (the wizard runs this
   after asking):

   ```bash
   tailscale serve --bg http://127.0.0.1:3847
   # → https://<machine-name>.<tailnet>.ts.net
   ```

   That URL is reachable only from inside your tailnet, but carries a browser-trusted
   certificate — the ideal endpoint to install the PWA from. Requests through
   `tailscale serve` reach the bridge from 127.0.0.1 with an `X-Forwarded-For`
   header; the bridge treats those as **non-loopback**, so the proxy does not inherit
   the loopback exemption of the control routes.
3. Pair: `claudestra pair --url https://<machine-name>.<tailnet>.ts.net`.

### Public reverse proxy (advanced, only if you know why you need it)

Put Caddy/nginx with TLS in front of the bridge port on a domain you own. Keep in mind:

- **Never** port-forward `3847` raw to the internet; put rate limiting / an IP
  allowlist at the proxy. The pairing flow is brute-force-limited, but the surface
  is still your machine.
- Route `/api/v1/*` for **peers** to the peer-only ingress port (below), not to the
  bridge port.

### Install as a PWA

Once the app is reachable over HTTPS (or you accept degraded mode over HTTP):

- **iOS Safari** — open the URL → Share sheet → **Add to Home Screen**. Launches
  full-screen (standalone), with app icon and safe-area-aware layout.
- **Android Chrome** — open the URL → ⋮ menu → **Install app** (or accept the
  install banner).

> iOS caches the manifest at install time — after big upgrades, if icons or
> full-screen behaviour look stale, delete the home-screen icon and re-add it.

---

## Upgrading from the pre-2026-09 web service

Before the hosted frontend the web client ran as its own Next.js server
(`com.claudestra.web`, port 3333, SSH login, `~/.claude-orchestrator/web/`). After
updating to a bridge that serves `web/out`:

1. `claudestra migrate-web-state` — tars `~/.claude-orchestrator/web/` into
   `~/.claude-orchestrator/backups/web-<ts>.tgz`, then copies the 8 settings tables
   (profile, agent settings, skill prefs, push subscriptions, hidden ranges, unread
   marks, APNs devices) and `groqApiKey` into the bridge's `web-state.sqlite`.
   Idempotent; the old data is left in place.
2. Open the new entry (`http://127.0.0.1:3847/`, the relay, or your Tailscale URL),
   pair once and check chat + push.
3. `claudestra retire-web` — refuses until `BRIDGE_STATIC_DIR` is served
   (`/app-config.json` answers) **and** a backup from step 1 exists; then
   `launchctl bootout`s the old daemon and moves its plist to
   `~/.claude-orchestrator/backups/com.claudestra.web.plist.<ts>`, printing the
   rollback command. `~/.claude-orchestrator/web/` is never deleted.

`doctor` nags about the old plist until step 3 is done. Passkeys, TOTP and the SSH
login are gone; the browser session cookie `cstra_session` is replaced by the device
cookie `cstra_dev`.

---

## HTTPS when `tailscale serve` won't cooperate (Caddy + `tailscale cert`)

`tailscale serve` (previous section) is the zero-config path — try it first. On
some macOS GUI-app installs it fails with `The Tailscale GUI failed to start
(CLIError error 3)` and cannot write serve config. Fallback: issue the tailnet
certificate yourself and let Caddy terminate TLS. Caddy also gives you HTTP/2 —
a naive TCP tunnel is HTTP/1.1-only, which serializes Safari's six
connections-per-host and crawls on mobile.

```bash
brew install caddy
mkdir -p ~/.claude-orchestrator/tls ~/.claude-orchestrator/caddy
tailscale cert \
  --cert-file ~/.claude-orchestrator/tls/mac.crt \
  --key-file  ~/.claude-orchestrator/tls/mac.key \
  <machine>.<tailnet>.ts.net
```

`~/.claude-orchestrator/caddy/Caddyfile`:

```
{
	auto_https off
	admin off
}

https://<machine>.<tailnet>.ts.net:443 {
	tls /Users/YOU/.claude-orchestrator/tls/mac.crt /Users/YOU/.claude-orchestrator/tls/mac.key
	# Response compression — not optional if clients come in over slow links.
	# The bridge does not compress; without this a large chat history JSON
	# (hundreds of kB) ships raw and can take 10s+ on a lossy cross-border path
	# (2026-07-24: 560 kB → 102 kB, 13.9s → 0.3s). SSE is safe: caddy's encode
	# flushes per event, verified no buffering.
	encode zstd gzip
	handle {
		reverse_proxy 127.0.0.1:3847
	}
}
```

(Other projects on the same machine may add their own routes to this
Caddyfile — that is between them and Caddy, out of scope here.)

Then a LaunchAgent (label of your choice, `RunAtLoad` + `KeepAlive`) whose
`ProgramArguments` runs
`/opt/homebrew/bin/caddy run --config /Users/YOU/.claude-orchestrator/caddy/Caddyfile`,
with logs pointed at `~/.claude-orchestrator/caddy/`, bootstrapped with
`launchctl bootstrap gui/$(id -u) <plist>`.

- Register **exactly one** caddy LaunchAgent. Caddy binds 443 with
  `SO_REUSEPORT`, so a duplicate registration silently starts a *second* copy
  load-balancing the same port instead of failing loudly.
- Non-root processes may bind 443 on modern macOS (wildcard address).
- Caddy sets `X-Forwarded-For`, so the bridge treats proxied requests as
  non-loopback (see the Tailscale section) — that is what you want.
- **Certificate renewal** — `tailscale cert` certificates last ~90 days and do
  not auto-renew here. `bun scripts/renew-ts-cert.ts` checks expiry and is a
  dry run by default; `--apply --reload-label <your-caddy-label> --notify`
  renews once fewer than 30 days remain, restarts Caddy, and posts failures
  to #control. To automate it, schedule that command daily from a LaunchAgent
  (`StartCalendarInterval`, `WorkingDirectory` = the repo root so `.env` loads);
  on days with nothing to renew it exits without changing anything.

### Peers over the same HTTPS entry

Claudestra peers (other instances that call your agents) can use this HTTPS entry instead of the bridge port, so new peers don't need firewall allowlist entries — only a route to this machine (e.g. share it with them in Tailscale).

1. Pick a free loopback port for the peer entrance and add it to the repo's `.env`, e.g. `PEER_INGRESS_PORT=3848`, then restart the bridge. It serves only `/api/v1` with peer tokens — no control routes, no websocket, no device cookies.
2. Route `/api/v1/*` to it inside the `ts.net` site block, **before** the web `handle`:

   ```caddyfile
   handle /api/v1/* {
       reverse_proxy 127.0.0.1:3848
   }
   ```

   Keep peers on the dedicated port rather than the bridge port: the bridge port also carries device-cookie sessions and the control routes, and the peer entrance is the surface that is meant to be reachable by other machines.
3. `peer-invite-new` then writes the `https://` address into invites automatically (it probes `/api/v1` through the entry first and falls back to the bridge address if the probe fails). Set `PEER_PUBLIC_URL` in `.env` to force a specific base URL.

With `tailscale serve`, `bun run setup` adds the equivalent `--set-path /api/v1` handler and writes `PEER_INGRESS_PORT` when you let it configure HTTPS. On the relay none of this is needed — peer addresses are `relay://<fingerprint>`.

No HTTPS entry and the bridge still bound to loopback (the default)? You don't need to open the bridge port either: `peer-invite-new` then opens the same peer-only entrance on all interfaces (`PEER_INGRESS_PUBLIC=1` in `.env`, only while peer tokens exist) and writes `http://<tailnet IP>:<that port>` into the invite. The bridge port keeps listening on loopback only.

### Protocol choice on lossy links (h2/h3 vs plain h1)

Caddy speaks h2 + h3 by default, and on a clean network that is what you want.
On a **high-RTT, lossy path** (e.g. cross-border ~200 ms with visible packet
loss) the defaults can *lose* to plain HTTP/1.1: h2 multiplexes everything over
one TCP connection, so a single lost packet head-of-line-blocks every stream;
h3/QUIC avoids that but rides UDP, which intermediate carriers on such routes
often throttle or blackhole. Telltale: browsing through Caddy feels much slower
than hitting `:3847` directly (the direct hit uses the browser's six parallel
h1 connections). Fix — force h1 in the global options:

```
{
	servers {
		protocols h1
	}
}
```

Trade-off to know before you copy this: browsers cap h1 at **6 connections per
host**, and every open tab of the web app holds one SSE long-poll (plus one
more with the remote terminal open) — several simultaneous tabs can exhaust
the budget, showing up as requests stuck "pending" while the network is fine.
Keep h2/h3 defaults on clean links; reach for h1 only when the loss pattern
above actually applies.

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
     --fullchain-file ~/.claude-orchestrator/tls/custom/fullchain.pem \
     --key-file       ~/.claude-orchestrator/tls/custom/key.pem \
     --reloadcmd "launchctl kickstart -k gui/$(id -u)/<your-caddy-label>"
   ```

3. **Caddy**: append a second site block to the same Caddyfile (do **not** start
   a second caddy — see the single-instance warning above):

   ```
   https://claude.your-domain.com:443 {
   	tls /Users/YOU/.claude-orchestrator/tls/custom/fullchain.pem /Users/YOU/.claude-orchestrator/tls/custom/key.pem
   	encode zstd gzip
   	handle {
   		reverse_proxy 127.0.0.1:3847
   	}
   }
   ```

   Validate + restart: `caddy validate --config <Caddyfile>` then
   `launchctl kickstart -k gui/$(id -u)/<your-caddy-label>`.
4. **Auto-renewal**: schedule `acme.sh --cron` daily (launchd/crontab). Unlike
   the `tailscale cert` path, DNS-01 renewals are fully unattended — the
   `--reloadcmd` above restarts Caddy with the fresh cert. The `ts.net` block
   can stay alongside as a second entry point.

## Port map

| Port  | Bind         | What |
|-------|--------------|------|
| 443   | all (tailnet-reachable) | `tailscale serve` or Caddy TLS/h2 → 3847 |
| 3847  | 127.0.0.1 (default) | Bridge: HTTP API + WebSocket **+ the web client** (`BRIDGE_PORT` / `BRIDGE_BIND` / `BRIDGE_STATIC_DIR`) |
| 3848… | 127.0.0.1 | Peer-only `/api/v1` ingress (`PEER_INGRESS_PORT`, picked by setup) |
| 33333 | all interfaces | Next.js dev server (development only) |

Request path: phone → relay (or Caddy / tailscale serve `:443`) → Bridge `:3847`
(static files + `/api/v1`, device cookie) → tmux / Claude Code.

---

## Web-only backend (no Discord)

If you don't want a Discord bot, run the Bridge in **Web-only mode** — it detects
the absence of `DISCORD_BOT_TOKEN` and skips all Discord init while still serving
the static bundle and the `/api/v1` + `/api/v1/events` the web app needs.

### One-time backend prerequisites

1. **tmux ≥ 3.2** (`brew install tmux`). Agents are tmux windows; the live remote
   terminal needs grouped sessions.
2. **Register the channel-server MCP** so Claude Code sessions can reach the Bridge:
   ```bash
   claude mcp add "${MCP_NAME:-claudestra}" -s user -- ~/.bun/bin/bun run <repo>/src/channel-server.ts
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
CONTROL_CHANNEL_ID=local-master-control BRIDGE_STATIC_DIR=$(pwd)/web/out bun run src/bridge.ts
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

Wire them into the **same LaunchAgent labels the normal install uses** —
`com.claudestra.bridge` and `com.claudestra.launcher` — with `RunAtLoad` + `KeepAlive`.
Web-only is a different *launch command*, not a different service; giving it its own
labels leaves you with a machine whose daemon names don't match anything else in this
repo (and `launchctl kickstart` on a label that was never loaded just returns exit 113).
**Both must share the same `CONTROL_CHANNEL_ID`.** After changing bridge code, reload:

```bash
launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge
```

---

## Reference

- [`web/CLAUDE.md`](./CLAUDE.md) — internal architecture, data flow, PWA gotchas.
- [`docs/design-hosted-frontend.md`](../docs/design-hosted-frontend.md) — pairing,
  device credentials, relay path mode, trust boundary, migration order.
- [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md) — the `/api/v1` +
  `/events` contract (auth, history pagination, SSE event types).
- [`docs/design-multi-frontend.md`](../docs/design-multi-frontend.md) — multi-frontend
  design (chat_id keyspace, NeutralMessage, ChatAdapter).
