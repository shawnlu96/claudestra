# Dev sandbox: an isolated bridge for live testing

A second Claudestra on the same machine that cannot touch the production one: its own state, tmux server, port and identity, no Discord, no relay, no push, no peers, no launchd. Built for executors who need to verify a change against a real bridge + real Claude Code agents while production keeps running. It is a developer tool, not a user feature. Code: `src/lib/sandbox.ts`, `src/bridge/sandbox-routes.ts`, `scripts/sandbox.ts`; proof: `tests/sandbox-isolation.test.ts`.

## Use it

```bash
bun run sandbox up                                   # port 23900, root /tmp/claudestra-sandbox-23900
bun run sandbox manager create sbx-a /tmp/claudestra-sandbox-23900/work "test agent"
bun run sandbox manager token-add dev --agents '*' --force  # Bearer for /api/v1 (curl, or a web client via --static)
bun run sandbox status
bun run sandbox down                                 # stop the bridge and the sandbox tmux server (agents exit)
bun run sandbox clean                                # down + delete the sandbox root
```

Options (any command): `--port N` (never the production default), `--root DIR` (keep it short: tmux socket paths are capped at 104 bytes), `--static DIR` (serve an already-built `web/out` read-only — this checkout's, or a scratch copy; the sandbox never builds web and refuses anything inside the production state dir, i.e. the live `web-releases/`, which flips on every production deploy / rollback).

Watch an agent: `tmux -S /tmp/claudestra-sandbox-23900/run/master.sock attach`, or `bun run sandbox manager tmux-capture <name>`. Bridge log: `<root>/bridge.log`. `bun run sandbox env` prints the sandbox environment as `export` lines for one-off manual commands.

Only a whitelist of manager subcommands is exposed (`create kill remove list restart archive token-* project-* cron-list tmux-capture`); Claude Code runtime only (Pi / Codex launch chains do not go through these gates).

## How isolation works

Everything keys off `CLAUDESTRA_SANDBOX=1`. Without it every check below is a no-op and production paths, launch commands and routes are byte-identical (pinned in `tests/sandbox.test.ts`).

1. **Clean environment.** `scripts/sandbox.ts` never inherits the caller's environment: it builds one from a short allowlist (`PATH HOME USER LANG TERM TMPDIR` + proxy settings) and sets the sandbox keys. This matters because an executor's own shell carries `BRIDGE_URL=<production>`, `DISCORD_CHANNEL_ID`, `MCP_NAME` — inherited, they would wire sandbox agents to the production bridge. Every sandbox process runs with `bun --no-env-file` and `cwd` = sandbox root, and in sandbox mode `repoEnvVar` ignores the repo `.env`, so starting from the main tree cannot pick up its relay / push / port config.
2. **Fail-closed on load.** `lib/paths.ts` refuses to load unless `CLAUDESTRA_STATE_DIR` and `CLAUDESTRA_RUNTIME_DIR` are set and overlap neither production default (symlinks resolved, so `/private/tmp/claude-orchestrator` counts). `lib/bridge-url.ts` refuses a non-loopback or default-port bridge address — so a hook or channel-server that lost its `BRIDGE_URL` errors out instead of reaching production. `bridge/config.ts` refuses to start with `DISCORD_BOT_TOKEN`, `RELAY_URL`, peer-ingress / legacy-web ports, `APNS_*`, `BRIDGE_CONTROL_TOKEN` or a non-loopback `BRIDGE_BIND`.
3. **Outbound gate.** Every sandbox process wraps `fetch` and `WebSocket`: only its own bridge port on loopback is allowed; anything else is rejected and logged with `🧱 sandbox-outbound-blocked`. Features are also switched off at the source (below), so the gate is a backstop, not the mechanism.
4. **Agents.** The launch prefix carries the sandbox keys, so each agent's hooks and channel-server talk to the sandbox bridge and use sandbox paths. Agents get `--mcp-config` pointing at **this checkout's** `channel-server.ts` (the global `claude mcp add` registration points at the main tree, which would not test your branch) plus `--strict-mcp-config`, so the user's other MCP servers (mem0 etc.) are not loaded. The sandbox tmux server's shells use a `ZDOTDIR` shim that loads the user's own zsh rc files and then pins `HISTFILE` inside the sandbox, so launch commands never land in `~/.zsh_history`.

## What is off in the sandbox

| Feature | Where it is switched off |
|---|---|
| Discord (login, channels, admin buttons) | no token allowed → Web-only mode |
| Relay link and instance identity on the relay | `startRelayLink` (+ `RELAY_URL` refused) |
| Push (APNs, Web Push; `/api/v1/push/*` not mounted) | `initPush` |
| Peer presence probes, `/api/v1/peers*`, peer ingress port | `startPeerPresence`, route gate, env check |
| Update / update check / restart-all / `pi update` | route gate; manager whitelist |
| Writing `~/.claude/settings.json` (claude-defaults, in-session `/model` `/effort`) | route gate; `runSwitchCommand` |
| Archiving / deleting / cleaning / adopting sessions, resuming by session id, bg-job kill | route gate; `cleanupBgJob` / `tryRosterCleanup` |
| launchd, cron scheduler, launcher, master agent | never started; `install-cli` / `update` not in the whitelist |

Still on: channel-server registration, `deliver()` routing, `/hook`, held queue and `check_inbox`, `send_to_agent` between sandbox agents, `/api/v1` messaging and history, SSE, archive into the sandbox root.

## Known boundaries

- **`~/.claude` is shared.** Sandbox agents are real Claude Code sessions logged in as the user, so Claude Code itself writes their transcripts to `~/.claude/projects/` and runs the user's global hooks. Isolating that would need a separate `CLAUDE_CONFIG_DIR` and a fresh login. The sandbox bridge only reads `~/.claude`; every Claudestra path that would write or delete there is off (table above).
- **Production can see sandbox sessions.** The production bridge's session inventory lists every Claude Code session on the machine, so sandbox transcripts show up there as unmanaged. Don't archive or delete them from the production UI while the sandbox is running.
- **A zsh rc that force-sets `HISTFILE`** after our shim is sourced cannot be overridden; bash honours the `HISTFILE` env.
- **One sandbox at a time per port.** Run several by giving each its own `--port`; there is no port allocator.
- Create sandbox agents in the sandbox `work/` dir (or another scratch dir), not in the main checkout: Bun loads `.env` from the working directory for anything started there without `--no-env-file`.

## Proof

`tests/sandbox-isolation.test.ts` starts the sandbox through the script with a fake production home (seeded `~/.claude-orchestrator` and `~/.claude`), a caller environment full of production addresses and credentials, logging shims for `launchctl` / `tmux` / `claude` / `npm` …, a counting HTTP proxy and a decoy relay. It runs up → use (hook, ws register, manager) → restart → down and asserts: no file under the fake home created, changed or removed; `launchctl` never called; every `tmux` call on the sandbox socket; zero requests at the proxy and the decoy, no outbound-gate hits in the bridge log; the bridge listens only on the sandbox port; writes did land in the sandbox state dir. A second case starts `bridge.ts` directly with a Discord token, a relay URL, a missing state override or the production port and asserts it refuses to start with zero writes. A third runs the real global Stop hook (`src/hooks/typing-hook.ts`) with a sandbox agent's environment: it posts to the sandbox port, and with the production address (or none) it exits with an error and sends nothing.
