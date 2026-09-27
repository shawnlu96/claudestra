# Claudestra Web Client — Setup & Run

**English** · [简体中文](./SETUP.zh-CN.md)

The **Next.js web frontend** for Claudestra — a second front door beside Discord.
It is a **static export** (`out/`) that the relay or the Bridge itself serves; the
browser talks straight to the Bridge's HTTP API (`/api/v1` + `/api/v1/events`).
There is no web server process, no BFF and no account system: signing in means
**pairing this browser with your Mac** (`claudestra pair`).

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
- **PWA-installable** — add to your phone's home screen for a full-screen app feel,
  with self-hosted Web Push (VAPID keys are generated on first use — no third-party
  account, no signup).
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
- **The Claudestra Bridge must be running** (default `http://127.0.0.1:3847`). Two ways to get there:
  - **A — you already run Claudestra with Discord** (see [`../SETUP.md`](../SETUP.md)):
    the Bridge, the `claudestra` MCP server, and the Stop hook are already wired by
    `bun run setup`. Skip to [Install the web app](#1-install-the-web-app).
  - **B — Web-only, no Discord bot**: see
    [Run the backend in Web-only mode](#web-only-backend-no-discord) first.
- **Bun** — only needed to run the backend.

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

Nothing is required for a build. The only optional variable is for the **dev server**:

| Variable | Notes |
|---|---|
| `WEB_DEV_ORIGINS` | Comma-separated extra origins allowed to reach the dev server's `_next` assets — your tailnet IP / LAN IP / `*.ts.net` hostname. Without it, HMR websocket handshakes fail from those addresses and the dev page reloads in a loop. |

Everything that used to live in `.env.local` (API token, internal key, SQLite,
VAPID keys, Groq key) is gone with the BFF: the Bridge holds that state now
(`~/.claude-orchestrator/web-state.sqlite`, `config.json`), and the voice key is
set in the in-app Settings.

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

## 4. Build (static export)

```bash
npm run build      # → web/out/
```

`out/` is a plain static site. Who serves it:

- **Relay (default)** — the relay hosts one copy for everyone (`RELAY_STATIC_DIR`), at `https://relay.<domain>/`.
- **Bridge directly** — set `BRIDGE_STATIC_DIR=/path/to/web/out` on the bridge (`https://<mac>:3847/` via Tailscale or your own certificate).

Both serve `/chat` as `chat.html`, unknown paths as `404.html`, `/_next/static/*` with long caching and HTML with `no-cache` (`src/lib/static-site.ts`). The
export reads `/app-config.json` from its host to learn whether it runs in relay or direct mode.

## 5. Pair (this replaces logging in)

Open the app → you land on `/pair`. On the Mac run `claudestra pair`: it prints a QR
code, a link and an 8-character code, all valid for 10 minutes and single use.

- **Scan the QR / open the link** — the browser proves it holds the secret (HMAC over
  a challenge; the secret never leaves the browser) and gets a device credential
  right away.
- **Type the code** — the Mac shows "device X wants to pair, grant Y"; confirm there
  and the page continues on its own.
- **On the Mac itself** (`localhost`) — one-tap pairing.

The credential is an HttpOnly cookie signed and checked by your own Bridge; the
relay only routes. One browser can pair several machines and switch between them
from the top bar; *Settings → Devices* lists every paired device, revokes them,
and "Sign out" revokes this browser's own credential.

New agents are created by talking to the master orchestrator (👑 大总管) in chat —
there is no separate "new session" button by design.

---

## 6. Access from your phone (remote access)

The whole point of Claudestra is driving your workstation from your phone. Four
tiers, in order of recommendation:

### Relay (default — nothing to install on the phone)

`bun run setup`'s *Phone access* step configures this by default: the bridge keeps
one outbound WebSocket to the relay, and `https://<your-name>.<relay-domain>` is
this machine's web client from any network — HTTPS included, so the PWA, push and
passkeys all work. `claudestra pair` prints a QR code that signs the phone in.
Details, self-hosting and the trust boundary: [../docs/relay/README.md](../docs/relay/README.md).
The tiers below are for when you'd rather not route through a relay at all.

### Same Wi-Fi (zero setup)

`npm run start` listens on all interfaces, so any device on the same network can
open `http://<your-mac-lan-ip>:3333` (find the IP under *System Settings → Wi-Fi →
Details*, or `ipconfig getifaddr en0`). Log in with the same OS username/password.

Good for a quick test; useless once you leave the house.

### Tailscale (alternative: your own private network, no third party)

[Tailscale](https://tailscale.com) gives every device a stable private IP over
WireGuard — no port forwarding, no public exposure, free for personal use. Pick
option 2 in the wizard's *Phone access* step and it walks you through this:

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

## Run it as a service

There is nothing to run: the web app is static files served by the Bridge or the
relay, and `install-cli` no longer installs a `com.claudestra.web` daemon. After
every web update just rebuild (`npm run build`) and point the host at the new `out/`.

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
  not auto-renew here. `bun scripts/renew-ts-cert.ts` checks expiry and is a
  dry run by default; `--apply --reload-label <your-caddy-label> --notify`
  renews once fewer than 30 days remain, restarts Caddy, and posts failures
  to #control. To automate it, schedule that command daily from a LaunchAgent
  (`StartCalendarInterval`, `WorkingDirectory` = the repo root so `.env` loads);
  on days with nothing to renew it exits without changing anything.

### Peers over the same HTTPS entry

Claudestra peers (other instances that call your agents) can use this HTTPS entry instead of the bridge port, so the bridge never has to listen beyond loopback and new peers don't need firewall allowlist entries — only a route to this machine (e.g. share it with them in Tailscale).

1. Pick a free loopback port for the peer entrance and add it to the repo's `.env`, e.g. `PEER_INGRESS_PORT=3848`, then restart the bridge. It serves only `/api/v1` with peer tokens — no control routes, no websocket, and the full-scope web token is refused there.
2. Route `/api/v1/*` to it inside the `ts.net` site block, **before** the web `handle`:

   ```caddyfile
   handle /api/v1/* {
       reverse_proxy 127.0.0.1:3848
   }
   ```

   Never point this at the bridge port itself: requests through Caddy arrive from `127.0.0.1`, and the bridge trusts loopback for its control routes.
3. `peer-invite-new` then writes the `https://` address into invites automatically (it probes `/api/v1` through the entry first and falls back to the bridge address if the probe fails). Set `PEER_PUBLIC_URL` in `.env` to force a specific base URL.

With `tailscale serve`, `bun run setup` adds the equivalent `--set-path /api/v1` handler and writes `PEER_INGRESS_PORT` when you let it configure HTTPS.

No HTTPS entry and the bridge still bound to loopback (the default)? You don't need to open the bridge port either: `peer-invite-new` then opens the same peer-only entrance on all interfaces (`PEER_INGRESS_PUBLIC=1` in `.env`, only while peer tokens exist) and writes `http://<tailnet IP>:<that port>` into the invite. The bridge port keeps listening on loopback only.

### Protocol choice on lossy links (h2/h3 vs plain h1)

Caddy speaks h2 + h3 by default, and on a clean network that is what you want.
On a **high-RTT, lossy path** (e.g. cross-border ~200 ms with visible packet
loss) the defaults can *lose* to plain HTTP/1.1: h2 multiplexes everything over
one TCP connection, so a single lost packet head-of-line-blocks every stream;
h3/QUIC avoids that but rides UDP, which intermediate carriers on such routes
often throttle or blackhole. Telltale: browsing through Caddy feels much slower
than hitting `:3333` directly (the direct hit uses the browser's six parallel
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
| 33333 | all interfaces | Next.js dev server (development only) |
| 3847  | 127.0.0.1    | Bridge HTTP + WebSocket + static `out/` (`BRIDGE_PORT`/`BRIDGE_BIND`/`BRIDGE_STATIC_DIR`) |

Request path: phone → relay (or Caddy `:443` → Bridge `:3847`) → Bridge (device cookie) → tmux / Claude Code.

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
- [`docs/web-frontend-guide.md`](../docs/web-frontend-guide.md) — the `/api/v1` +
  `/events` contract (auth, history pagination, SSE event types).
- [`docs/design-multi-frontend.md`](../docs/design-multi-frontend.md) — multi-frontend
  design (chat_id keyspace, NeutralMessage, ChatAdapter).
