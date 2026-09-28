# Dev sandbox: an isolated bridge for live testing

A second Claudestra on the same machine that cannot touch the production one: its own state, tmux server, port and identity, no Discord, no relay, no push, no peers, no launchd. Built for executors who need to verify a change against a real bridge + real Claude Code agents while production keeps running. It is a developer tool, not a user feature. Code: `src/lib/sandbox.ts` (runtime gates), `src/lib/sandbox-env.ts` (launcher side), `src/bridge/sandbox-routes.ts`, `scripts/sandbox.ts`; proof: `tests/sandbox-isolation.test.ts`.

## Use it

```bash
bun run sandbox up                                   # port 23900, root /tmp/claudestra-sandbox-23900
bun run sandbox manager create sbx-a /tmp/claudestra-sandbox-23900/work "test agent"
bun run sandbox manager token-add dev --agents '*' --force  # Bearer for /api/v1 (curl, or a web client via --static)
bun run sandbox status
bun run sandbox down                                 # stop the bridge and the sandbox tmux server (agents exit)
bun run sandbox clean                                # down + delete the sandbox root
```

Options (any command): `--port N` (never a production port), `--root DIR` (keep it short: tmux socket paths are capped at 104 bytes; must be empty or an earlier sandbox), `--static DIR` (serve an already-built `web/out` read-only — this checkout's, or a scratch copy; the sandbox never builds web and refuses anything inside a production dir, e.g. the live `web-releases/`, which flips on every production deploy / rollback).

Watch an agent: `tmux -S /tmp/claudestra-sandbox-23900/run/master.sock attach`, or `bun run sandbox manager tmux-capture <name>`. Bridge log: `<root>/bridge.log`. `bun run sandbox env` prints the sandbox environment as `export` lines for one-off manual commands.

Sandbox agents must live under the sandbox root (the `work/` dir is created for that) and must be Claude Code agents. Only a whitelist of manager subcommands is exposed through the script (`create kill remove list restart archive token-* project-* cron-list tmux-capture`).

## How isolation works

Everything keys off `CLAUDESTRA_SANDBOX=1` (`0` or unset = off; any other value is an error, so a typo can't silently run against production). Without it every check below is a no-op and production paths, launch commands and routes are byte-identical (pinned in `tests/sandbox.test.ts`).

1. **Clean environment.** `scripts/sandbox.ts` never inherits the caller's environment: it builds one from a short allowlist (`PATH HOME USER LANG TERM TMPDIR` + proxy settings) and sets the sandbox keys. This matters because an executor's own shell carries `BRIDGE_URL=<production>`, `DISCORD_CHANNEL_ID`, `MCP_NAME` — inherited, they would wire sandbox agents to the production bridge. Every sandbox process runs with `bun --no-env-file` and `cwd` = sandbox root, and in sandbox mode `repoEnvVar` ignores the repo `.env`, so starting from the main tree cannot pick up its relay / push / port config.
2. **Production deny list.** Before creating anything, the script reads production's real config — the `com.claudestra.bridge` launchd plist (environment + working dir) and the `.env` of that repo and of this checkout's main worktree — and refuses ports and dirs that production uses, defaults included (e.g. a production bridge moved to `13847`, the peer-ingress port, a relocated state dir). The list is passed to every sandbox process (`CLAUDESTRA_SANDBOX_DENY_PORTS` / `_DENY_DIRS`), so the checks below use it too.
3. **Fail-closed on load.** `lib/paths.ts` refuses to load unless `CLAUDESTRA_STATE_DIR` and `CLAUDESTRA_RUNTIME_DIR` are set and overlap no production dir (symlinks resolved, so `/private/tmp/claude-orchestrator` counts), and unless `BRIDGE_PORT` agrees with `BRIDGE_URL`. `lib/bridge-url.ts` refuses a non-loopback or production-port bridge address — so a hook or channel-server that lost its `BRIDGE_URL` errors out instead of reaching production. `bridge/config.ts` refuses to start with `DISCORD_BOT_TOKEN`, `RELAY_URL`, peer-ingress / legacy-web ports, `APNS_*`, `BRIDGE_CONTROL_TOKEN` or a non-loopback `BRIDGE_BIND`.
4. **Outbound gate.** Every sandbox process wraps `fetch` and `WebSocket`: only its own bridge port on loopback is allowed; anything else is rejected and logged with `🧱 sandbox-outbound-blocked`. Features are also switched off at the source (below), so the gate is a backstop, not the mechanism.
5. **Agents.** The launch prefix carries the sandbox keys (flag, dirs, root, deny list), so each agent's hooks, statusLine and channel-server talk to the sandbox bridge and write sandbox paths — the statusLine usage cache (`scripts/usage-cache-write.sh`) honours `CLAUDESTRA_STATE_DIR` like `lib/paths.ts` does. Agents get `--mcp-config` pointing at **this checkout's** `channel-server.ts` (the global `claude mcp add` registration points at the main tree, which would not test your branch) plus `--strict-mcp-config`, so the user's other MCP servers (mem0 etc.) are not loaded. The sandbox tmux server's shells use a `ZDOTDIR` shim that loads the user's own zsh rc files and then pins `HISTFILE` inside the sandbox; Bun's transpiler cache and Python bytecode are kept out of `~` too.
6. **No session crossover.** Agents may only be created under the sandbox root, so the bridge's cwd-based session logic (clear rotation, Stop self-heal, session discovery) never sees a production agent's directory; matching Claude Code's session registry by tmux pane id is off in the sandbox (two tmux servers reuse the same `%N` ids), leaving match-by-pid.
7. **Script safety.** `up` runs every check before creating a single dir; the root carries a marker recording its own real path, and `down` / `clean` refuse any root whose marker doesn't match; the bridge pid is only signalled if its command line is this checkout's `bridge.ts` **and** its working dir is the sandbox root (pid reuse can't hit the production bridge).

## What is off in the sandbox

| Feature | Where it is switched off |
|---|---|
| Discord (login, channels, admin buttons) | no token allowed → Web-only mode |
| Relay link and instance identity on the relay | `startRelayLink` (+ `RELAY_URL` refused) |
| Push (APNs, Web Push; `/api/v1/push/*` not mounted) | `initPush` |
| Peer presence probes, `/api/v1/peers*`, peer ingress port | `startPeerPresence`, route gate, env check |
| Update / update check / restart-all / `pi update` | route gate; manager whitelist |
| Writing `~/.claude/settings.json` (claude-defaults, in-session `/model` `/effort`, manager's model re-pin) | route gate; `runSwitchCommand`; `enforceSessionModel` |
| Archiving / deleting / cleaning / adopting sessions, resuming by session id, bg-job kill | route gate; `cleanupBgJob` / `tryRosterCleanup` |
| Pi and Codex agents | `assertCreatable` (manager create, also via the API); `buildPiCommand` / `buildCodexCommand` throw |
| launchd, cron scheduler, launcher, master agent | never started; `install-cli` / `update` not in the whitelist |

Still on: channel-server registration, `deliver()` routing, `/hook`, held queue and `check_inbox`, `send_to_agent` between sandbox agents, `/api/v1` messaging and history, SSE, archive into the sandbox root.

## Known boundaries

- **`~/.claude` is shared.** Sandbox agents are real Claude Code sessions logged in as the user, so Claude Code itself writes their transcripts to `~/.claude/projects/` and runs the user's global hooks (Claudestra's own hooks and statusLine follow the sandbox env, see above; hooks the user added themselves are out of our hands). Isolating that would need a separate `CLAUDE_CONFIG_DIR` and a fresh login. Everything *Claudestra* would write or delete under `~/.claude` is off (table above), and nothing is written to the production state dir.
- **Production can see sandbox sessions.** The production bridge's session inventory lists every Claude Code session on the machine, so sandbox transcripts show up there as unmanaged. Don't archive or delete them from the production UI while the sandbox is running.
- **The outbound gate only wraps `fetch` / `WebSocket` in Claudestra's own processes.** HTTP/2 (APNs), `node:https` (web-push), git, DNS and child processes (claude, python) are not intercepted; they are covered by switching the features off and by the environment checks, not by the gate. Likewise the test's counting proxy only sees clients that honour `HTTP(S)_PROXY`.
- **`/tmp/claude-orchestrator` is not snapshotted** by the test (production writes there all the time); instead the test asserts every tmux call uses the sandbox socket and that the sandbox bridge holds no open file under any `claude-orchestrator` path.
- **A zsh rc that force-sets `HISTFILE`** after our shim is sourced cannot be overridden; bash honours the `HISTFILE` env.
- **One sandbox at a time per port.** Run several by giving each its own `--port`; there is no port allocator.

## Proof

`tests/sandbox-isolation.test.ts` starts the sandbox through the script with a fake production home (seeded `~/.claude-orchestrator`, and a `~/.claude/settings.json` wired like a real install: Claudestra's Stop / Notification / SessionStart hooks and statusLine), a caller environment full of production addresses and credentials, logging shims for `launchctl` / `tmux` / `npm` …, a counting HTTP proxy and a decoy relay. `claude` is a fake Claude Code (`tests/sandbox-fake-claude.ts`) that runs the configured hooks and statusLine with the environment it was given, starts the MCP server from `--mcp-config` and handshakes, writes a session jsonl, answers a channel message with `reply("pong")` and fires Stop.

It runs up → use (hook, ws register, manager, a real `manager create` → API message → `pong` → Stop hook) → restart → down and asserts: under the fake home only the fake Claude Code's own transcript appeared (nothing under the production state dir — the statusLine cache landed in the sandbox); `launchctl` never called; every `tmux` call on the sandbox socket; zero requests at the proxy and the decoy, no outbound-gate hits in the bridge or manager output; the bridge listens only on the sandbox port and holds no production file open; agents outside the sandbox root and Codex agents are refused. Reverting the statusLine fix makes it fail. Further cases: `bridge.ts` started directly with a Discord token, a relay URL, a missing state override or the production port refuses to start with zero writes; the real global Stop hook posts to the sandbox port and, given the production address (or none), exits with an error and sends nothing; inside a sandbox process `fetch` and `WebSocket` to another loopback port are blocked.
