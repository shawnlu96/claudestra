# Claudestra — Architecture

**English** · [简体中文](./CLAUDE.zh-CN.md)

Architecture map, invariants and rules for contributors and agents working in this repo. New users start with [SETUP.md](./SETUP.md). Feature-level detail lives in [`docs/architecture/`](./docs/architecture/) — this file keeps only what every session needs, and it is itself size-ratcheted.

## Anti-rot rules (防腐规则 — `bun run check` enforces these, don't route around them)

1. **Run `bun run check` before every commit** (= `tsc --noEmit` + `bun test` + `bun run guard`). When the guard is red, **fix the code, not `scripts/guard/baseline.json`**. The only automatic baseline change allowed is `bun run guard:update`, which can only tighten. There is no inline ignore comment.
2. **Loosening needs a paper trail.** Edit the baseline by hand *and* add `{key, from, to, why}` to its `raised[]` (why ≥ 10 characters); say it again in the commit message. Changing the gate itself (anything under `scripts/guard/` except `baseline.json` — caps, `PUBLIC_ROUTES`, twins, `knip.json`) needs a **new** `{key: "guard:<path>", from: 0, to: 0, why}` entry too, and the `check`/`guard` scripts in `package.json` plus the CI Guard step are verified. The guard diffs against the base version (CI: `GUARD_BASE` = PR base / push `before`; locally: the fork point with `origin/main`), so an unrecorded change fails CI even if it passed locally. CI runs strict (`GUARD_STRICT=1`): a rule skipped for a missing dependency (knip, oxc-parser) is a failure there. `--init` rebuilds the baseline and is reserved for the main session / owner after merges — agents never run it.
3. **Size limits.** New files ≤ 400 lines (tests ≤ 600), new functions ≤ 100 lines, lines ≤ 200 chars. Files already in the baseline may only shrink: adding a feature to `manager.ts` / `bridge.ts` / `api-routes.ts` / `chat-store.ts` means a new module holds the logic and the big file gets a one-line call. Moving an oversized function or duplicated block out verbatim is fine (those are counted repo-wide).
4. **Search before you write a helper** — `grep -rn "export function" src/lib | grep -i <keyword>`. Canonical places:
   - tmux → `src/lib/tmux-helper.ts` (`windowTarget()`, `tmuxRaw`, `tmuxFire`, `tmuxInterrupt`); never hand-write `master:${x}` or `Bun.spawn(["tmux", …])`. Known exceptions: `bridge/web-terminal.ts` PTY argv, `lib/doctor.ts` `tmux -V` probe, the Pi extension's `execFile`, `setup.ts`.
   - launch flags → `src/lib/claude-launch.ts`, `src/lib/launch-command.ts`, `src/lib/runtimes/`, `src/lib/pi-launch.ts`.
   - paths → registry `src/lib/registry.ts` (`REGISTRY_PATH`), logs `src/lib/log-paths.ts`, bun/npm binaries `src/lib/bun-path.ts` / `src/lib/npm-path.ts`, session files `src/lib/session-source.ts`.
   - file locks / atomic JSON writes → `src/lib/file-lock.ts`; reuse the tmp+rename writer of the module that owns the file (e.g. `src/lib/peers.ts`) — a third copy gets extracted to `src/lib` first.
   - calling `manager.ts` from the bridge/cron → `runManager` (`src/lib/manager-client.ts` once it exists, otherwise `src/bridge/management.ts`); never spawn `bun src/manager.ts` by hand. Bridge ws requests → `src/lib/bridge-client.ts`.
5. **Dependency direction.** `src/lib` imports only `src/lib`; `src/bridge/*` never imports entry files (`src/*.ts`) nor the hubs (`api-routes` / `management` / `web-terminal` / `web-gateway`); watchers don't import each other — push shared pure functions down to `src/lib`, inject runtime-state queries. `web/` and `src/` never import each other; logic that must exist on both sides is registered as a twin in `scripts/guard/config.ts`.
6. **No copy-paste of 6+ lines.** "Keep in sync with X" means extract a function and call it, not a comment saying so.
7. **No silent error swallowing.** Every `catch {}` / `.catch(() => {})` / `.catch(() => null)` carries a sentence on why losing the error is harmless (placeholders like `/* ignore it */`, `/* 同上 */`, `/* non-critical */` count as silent); log when you can.
8. **Comments say why it is this way *now* and what breaks if changed** — at most 6 lines, no `v2.x+:` prefixes. Version history, incident stories, who reported what and verbatim quotes go in the commit message; a comment may point at `tests/x.test.ts` or `git log -S <symbol>`.
9. **This file is a map, not a changelog.** Feature detail goes to `docs/<area>/<topic>.md` with a one-line pointer here (`CLAUDE.md` byte size is in the baseline).

## System overview

Claudestra is a multi-session orchestrator built on Claude Code's native **Channel protocol** (an MCP extension). One Bridge process fans a single Discord bot token (and the HTTP/web API) out to many Claude Code / Pi sessions, each registered as an independent channel listener.

```
 Discord (one bot, one token)
        │
        ▼
 Bridge  ── bridge.ts, launchd-managed, ws://localhost:3847
        │
        ├── deliver(envelope)  ←── v2.0.0 unified routing
        │      ├─ to=local  (ws.send  → channel-server → Claude Code)
        │      ├─ to=user   (discordReply → user's channel)
        │      └─ to=api    (resolve HTTP waiter + SSE event)
        │
        ├── JSONL watcher                ├── HTTP hooks
        │                                │
        │   tool call → Discord          │   Stop     → drain watcher + complete ping
        │   claude text → Discord        │   Notification → stop typing only
        │   merged + debounced           │   30min safety timeout
```

- Every message-semantic operation builds an `Envelope{from, to, intent, content, meta}` and calls `deliver()` (`src/bridge/router.ts` defines `Endpoint` = local / user / api). Inbound, outbound `reply`, agent↔agent `send_to_agent` and HTTP-peer pushback all take this path.
- Each Claude Code session has its own `channel-server` (stdio MCP ↔ Bridge WebSocket); Pi sessions use `src/pi/claudestra-extension.ts` speaking the same ws protocol.
- `jsonl-watcher` tails session JSONL and streams tool calls / assistant text (1.5s debounce), drained synchronously on the Stop hook.
- Full description (message flow, envelope model): [docs/architecture/overview.md](./docs/architecture/overview.md).

## Project layout

One line per area; per-file notes (history, incidents, rationale) are in [docs/architecture/project-layout.md](./docs/architecture/project-layout.md).

```
src/
  bridge.ts            entry: Discord client, ws server, deliver() dispatch, slash commands, Stop hooks
  bridge/              bridge modules — router (Envelope/Endpoint/chat_id), adapters (ChatAdapter registry),
                       event-bus (SSE), api-routes (/api/v1), management (LLM-free buttons), discord-api,
                       watchers (jsonl / bg-activity / permission / wedge / session-reconciler / model-drift),
                       sessions-inventory, archive-sweeper, screenshot, web-terminal, web-gateway, config
  channel-server.ts    per-session MCP proxy (stdio MCP ↔ Bridge ws)
  pi/                  Pi agent extension (same ws protocol, Pi custom tools)
  manager.ts           agent lifecycle / projects / cron / tokens / peers / update CLI (JSON output)
  cron.ts launcher.ts  launchd daemons: cron scheduler, master-session guardian + auto-update
  setup.ts cli/        install wizard, `claudestra` CLI
  hooks/               Claude Code hooks: Stop/Notification → bridge, SessionStart recall
  lib/                 pure / shared logic — the canonical helpers (see Anti-rot rule 4)
  runtimes (lib/)      per-runtime launch + session adapters (claude-code / pi / codex)
web/                   Next.js PWA client (own CLAUDE.md, own npm dependency tree)
tests/                 pure-logic bun tests (`bun test`); bridge.ts itself is verified live in a sandbox
scripts/guard/         anti-rot ratchet: rules, config, baseline.json (see Anti-rot rules)
docs/                  design docs + architecture/ (moved-out detail of this file)
master/                master agent instruction template (rendered by setup.ts)
```

## Features

One line each; full descriptions in [docs/architecture/features.md](./docs/architecture/features.md).

- **Multi-agent orchestration** — create / resume / kill / restart / list / history, each agent a tmux window.
- **Projects** — every agent belongs to exactly one project (`projects.json`, manager is the sole writer); master is exempt.
- **Agent-to-agent messaging** — `send_to_agent` injects into another agent's context via the Bridge.
- **Codex calls** — `ask_codex` runs the local Codex CLI per call (`lib/codex.ts`), read-only sandbox by default.
- **Cron scheduling** — cron expressions spin up a temporary agent, run a prompt, report, clean up.
- **Discord + web UI** — buttons / selects / multiselect in `reply()`, LLM-free admin buttons, streaming tool output, screenshots, one-click interrupt, slash autocomplete for skills.
- **Multi-frontend API** — `GET /events` SSE, Bearer-scoped `POST /api/v1/agents/:name/messages`, `ChatAdapter` registry; bridge binds `127.0.0.1` by default.
- **Claude Code agents-mode integration** — session inventory + doppelganger detection, fork self-heal on restart, adopt/cleanup (`lib/bg-jobs.ts`).
- **Background-activity threads + session archive** — subagents / bg shells get their own threads; retired sessions are snapshotted to `~/.claude-orchestrator/archive/` (daily sweep too).
- **Read-only history API + manual archive category** — `GET /api/v1/agents/:name/history`, archive/restore endpoints, retention prunes only the manual category.
- **Pi agent sessions** — `runtime: "pi"` agents via the Pi extension, capability profiles (`pi-env`), session records translated to Claude Code shape (`lib/session-source.ts`).
- **HTTP peers** — cross-instance collaboration over `/api/v1` with scoped tokens and one-click invites; master is never shareable.

## Security posture

- **Guard rails (not a security boundary)** — `--disallowedTools` carries a blocklist (`rm -rf`, `git push --force`, `git reset --hard`, `chmod 777`, fork bomb) for every spawned agent. The rules are **prefix matches on the command string**, so equivalent spellings (`/bin/rm -rf`, `rm -fr`, `find … -delete`, `python -c`, variable expansion) bypass them, and there is no `PreToolUse` hook backstop. Since `DEFAULT_PERMISSION_MODE` is `bypassPermissions` (`lib/claude-launch.ts`), every agent is effectively an unrestricted shell running as the user — the blocklist only prevents accidents, never a determined prompt. **Pi agents (v2.23+) have no `--disallowedTools` equivalent at all**: the blocklist is a Claude Code launch flag, so a Pi agent's only guard is its capability profile (`--pi-base minimal`).

## Runtime commands

```bash
# First-time setup: collect Discord config, write .env, render master/CLAUDE.md
bun run setup

# Start everything (bridge + launcher + cron-scheduler)
bun src/manager.ts install-cli   # writes + loads the 3 launchd daemons

# Agent lifecycle
bun src/manager.ts create   <name> <dir> [purpose]
bun src/manager.ts resume   <name> <sessionId> [dir] [--fork]   # --fork: adopt a wild/bg-occupied session as a branched copy
bun src/manager.ts adopt    <name> <sessionId>   # promote a bg doppelganger to the agent's official session + restart
bun src/manager.ts archive  <name>               # snapshot the agent's current session jsonl to ~/.claude-orchestrator/archive/
bun src/manager.ts kill     <name>
bun src/manager.ts restart  [name]
bun src/manager.ts restart  --include-master   # v2.24+ restart every session, master included
bun src/manager.ts list
bun src/manager.ts sessions [search]

# Projects (v2.21+; every agent belongs to one project, create auto-resolves by dir)
bun src/manager.ts project-add    <id> --dirs <a,b> [--name <display>] [--emoji <e>] [--desc <text>]
bun src/manager.ts project-list
bun src/manager.ts project-edit   <id> [--name ..] [--emoji ..] [--dirs a,b] [--desc ..]
bun src/manager.ts project-remove <id>            # refuses while members remain
bun src/manager.ts project-assign <agent> <projectId>   # also moves the Discord channel category
bun src/manager.ts project-migrate                # backfill projectId for legacy agents (bridge runs it at startup)

# Cron jobs
bun src/manager.ts cron-add     <name> "<cron>" <dir> <prompt...> [--effort <level>]   # temp agent effort, default medium (v2.21.3+)
bun src/manager.ts cron-list
bun src/manager.ts cron-remove  <name|id>
bun src/manager.ts cron-toggle  <name|id>
bun src/manager.ts cron-history [name|id]

# Cross-Claudestra peer collaboration — HTTP peers (no Discord dependency;
# peers talk over the /api/v1 surface directly. Design: docs/design-http-peers.md)
# v2.15+ one-click invite (recommended): A generates, B pastes, B's bridge calls
# A's /api/v1/peers/redeem automatically — no receipt/accept. Single-use, 24h TTL,
# expiry/revoke also revokes the embedded token. Joining exposes nothing of B by
# default (one-way grant); symmetric access = B sends an invite of their own.
bun src/manager.ts peer-invite-new --agents <a,b|*> [--url <my-bridge-url>] [--force]  # A: print one-click invite (auto-URL: Tailscale first; warns if BRIDGE_BIND is loopback)
bun src/manager.ts peer-join-auto '<invite>' [--agents <x,y>] [--url <my-url>] [--force]  # B: paste invite, done (--agents = optional reverse exposure)
bun src/manager.ts peer-invite-list               # pending invites (sweeps expired + revokes their tokens)
bun src/manager.ts peer-invite-revoke <inv_id>    # void an unredeemed invite + its embedded token
# Legacy 3-step handshake (needed when the other side runs pre-v2.15):
bun src/manager.ts peer-http-invite <name> --agents <a,b> [--url <my-bridge-url>] [--force] [--rotate]  # A: print invite string (--url is auto-detected if omitted: Tailscale first, then LAN)
bun src/manager.ts peer-http-join <name> '<invite>' --agents <x,y> --url <my-url> [--force]           # B: store A, print receipt
bun src/manager.ts peer-http-accept <name> '<receipt>'                                                # A: complete handshake
bun src/manager.ts peer-http-test <name>          # GET peer /agents — verify reachability + scope
bun src/manager.ts peer-http-list                 # list HTTP peers + handshake state
bun src/manager.ts peer-http-scope <name> --agents <a,b|*> [--force]  # v2.11.1+: change inbound scope in place (token unchanged, effective immediately)
bun src/manager.ts peer-http-remove <name>        # delete peer + revoke the token we issued
# send_to_agent target syntax: "<agent>@<peer>" or "peer:<peer>.<agent>"
# master is NEVER shareable to peers (hard rule v2.15+, --force does not override;
# legacy peer tokens listing master are cut off in agentInScope)

# Versioning
# Health check (read-only; the first thing to run when something is broken)
bun src/manager.ts doctor [--json]

# Versioning
bun src/manager.ts version   # current version + whether an update is available
bun src/manager.ts update    # git pull + reload the 3 launchd daemons

# Auto-update toggles (both default on; launcher polls on a schedule and only upgrades when all agents are idle;
# after a Claude Code upgrade the launcher probes the binary agents actually run and auto-repairs a quarantine hang,
# alerting #control only if the repair fails — see lib/claude-binary.ts)
bun src/manager.ts auto-update status
bun src/manager.ts auto-update claudestra on|off   # Claudestra self-update (30 min poll)
bun src/manager.ts auto-update claude on|off       # Claude Code CLI (weekly poll)

# Multi-frontend API tokens (v2.6.0+; scope = per-agent whitelist, "*" = all non-master)
bun src/manager.ts token-add <name> --agents <a,b|*> [--force] [--no-mirror] [--terminal]  # --terminal = 远程终端(宿主 shell 级)独立授予
bun src/manager.ts token-list
bun src/manager.ts token-revoke <tokenId|name>
bun src/manager.ts create <name> <dir> --external   # mark agent as safe-to-expose (R1 guard)

# Token usage aggregation (parses ~/.claude/projects/<slug>/<sessionId>.jsonl)
bun src/manager.ts cost [--agent <name>] [--today|--week]

# Tests
bun test
```

## Environment variables

| Variable | Purpose |
|----------|---------|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord server (guild) ID |
| `ALLOWED_USER_IDS` | Comma-separated Discord user IDs allowed to talk to the bot |
| `CONTROL_CHANNEL_ID` | Control channel ID for the master orchestrator |
| `BRIDGE_PORT` | WebSocket port (default `3847`) |
| `MCP_NAME` | MCP server name used by `claude mcp add` (default `claudestra`) |
| `USER_NAME` | How the master agent addresses the operator in replies |
| `BRIDGE_URL` | Optional override for the channel-server's WebSocket target |
| `MASTER_DIR` | Optional override for the master tmux session's working directory |
| `BRIDGE_BIND` | HTTP/ws bind address (default `127.0.0.1`; set `0.0.0.0` to expose — bring your own reverse proxy/TLS) |
| `BRIDGE_CONTROL_TOKEN` | v2.21.1+ control-plane token for **non-loopback** access to the bare routes (`/hook` `/stats` `/skills/rescan` `/agent/cleanup` `/events`) and the ws upgrade (`route_to_agent` = host RCE). Loopback is always exempt; `/api/v1/*` keeps its own Bearer (peers unaffected). Unset = **fail-closed**: non-loopback control access is refused outright (current legal traffic is 100% loopback, so the default is zero-impact). Only set it if you deliberately need remote direct access to those routes. Supply it via `Authorization: Bearer` or `X-Bridge-Token` (preferred — `?control_token=` works for browser WS that can't set headers, but leaks into access logs). |
| `BRIDGE_CORS_ORIGIN` | v2.10+ CORS allowlist: comma-separated origins or `*` (default unset = no CORS headers) |
| `BRIDGE_STATIC_DIR` | v2.10+ static dir served by the bridge (SPA fallback included; default unset = off) |

## tmux topology

Every agent is a **window** inside the single `master` session. This lets `tmux -CC attach` present each agent as an iTerm2 native tab.

```
master (session, private socket at /tmp/claude-orchestrator/master.sock)
  ├── window 0: master orchestrator (the "大总管")
  ├── worker-alpha
  ├── worker-bravo
  └── worker-...
```

Attach locally:

```bash
tmux -S /tmp/claude-orchestrator/master.sock -CC attach
```

## Key invariants

- The master orchestrator is window 0 of the `master` tmux session. the `com.claudestra.launcher` launchd agent guarantees it exists and is running Claude Code.
- Every agent's Discord channel ID is recorded in `~/.claude-orchestrator/registry.json`. The Bridge uses this registry to route incoming Discord messages to the correct channel-server.
- The MCP server name (`MCP_NAME`) must match between `claude mcp add`, the channel-server's registration, and the JSONL watcher's tool-filter prefix. It is centralised in `src/bridge/config.ts` and `src/lib/claude-launch.ts`.
- Agent names are validated against a shell-metacharacter blocklist on create/resume but loosely normalised on kill/restart to keep historical CJK names working.
- Tool call display is debounced through `WATCHER_CONFIG.debounceMs` (default 1500 ms) to avoid Discord rate limits during bursty tool sequences.
- **Message routing (v2.0.0+)**: every message-semantic bridge operation (inbound to agent / outbound reply / agent→agent forward / pushback from HTTP-peer calls) constructs an `Envelope` and calls `deliver(env)`. The only direct `ws.send({type:"message"...})` / `channel.send({content})` calls outside `deliver` are **UI-class** side effects: the "💭 Thinking" status message with the Interrupt button, LLM-free admin button replies, `notifyMaster` broadcasts, and hook-event text notifications. Everything that an agent ends up seeing in its MCP `<channel>` tag goes through `deliver` → `renderContentForLocal`.
- **`channel-server` lifecycle (v2.14+)**: the governing constraint is that **channel-server has no supervisor** — Claude Code neither respawns a dead stdio MCP server nor reconnects to it, so any exit is a permanent disconnect for that agent. Two rules follow. (1) **Register only after the MCP handshake.** `mcp.oninitialized` gates the bridge connection, so a stray process that merely runs `channel-server.ts` can never claim the channel — which matters because `DISCORD_CHANNEL_ID` is injected by Claude Code and inherited by every Bash subprocess, making an accidental run inside the agent's own repo trivially easy. A 30s fallback registers anyway if the SDK never fires the callback. (2) **Being displaced is not a reason to die.** On `replaced` / `close(4001)` the process checks whether its stdio is still open: if Claude Code is still using it, it backs off and re-registers to take the channel back (3s→60s, and the counter only resets after holding the channel for 30s, so two live instances degrade to a slow alternation instead of a 3-second thrash); only `mcp.onclose` is a legitimate exit. Decision logic is isolated in `lib/link-policy.ts` and unit-tested. Plain `code 1000` (bridge restart) is still a transient disconnect → exponential-backoff reconnect.

## Contributing tips

- **Release process**: commits and `git push` to `main` are fine to do autonomously. Creating a `git tag v*` and a GitHub Release (`gh release create`) requires **explicit owner approval** every time — never tag-and-release on your own initiative.
- **Batch releases, don't spray them** (owner-mandated 2026-07-08 after reviewing 59 releases in 2.5 months): non-urgent changes accumulate in `main` and ship as **one release at the end of a work session/day**, bundling everything since the last release (v2.5.4 is the reference example: five features/fixes, one release). Only production-down hotfixes justify an immediate solo release. Same-day multi-release chains (e.g. 4 releases on 2026-04-25) usually mean the release was cut before verification — verify first, then cut. And keep version semantics honest: new user-facing capability = minor, even if small; patch is for fixes/refactors/polish only.
- **Version bump rules** (owner-mandated, refined 2026-04-20 starting v1.7.0):
  - **Patch** (`x.y.Z`) — bug fixes, small enhancements, extra CLI subcommands, refactors, tests, docs, UI polish. Most changes land here. If the bump is specifically a bug fix, also **delete the buggy release** via `gh release delete <tag> --yes --cleanup-tag` so the Releases list contains no broken versions. Polish/small-feature patches don't delete the previous version.
  - **Minor** (`x.Y.0`) — genuinely new user-facing capability that deserves a one-line "现在你可以 ..." headline. Examples: v1.3.0 Claude Code auto-update, v1.5.0 Discord slash autocomplete. Older minors are kept as history.
  - **Major** (`X.0.0`) — breaking change or system-level rearchitecture. Owner bumps these manually; never bump major on your own initiative.
  - Heuristic: if you're writing release notes and catch yourself opening with "修了..." / "加了个..." / "补了测试" / "重构了..." — that's a **patch**. Only headline-worthy new capability = minor.
- `tmux-helper.ts` and `claude-launch.ts` are the canonical places for tmux commands and Claude Code launch flags. Don't inline these in new files.
- Admin buttons that should skip the LLM go in `bridge/management.ts`. Add the `id` to both `handleMgmtButton` and the relevant panel builder.
- Before shipping, run `bun run check` (= `tsc --noEmit` + `bun test` + `scripts/guard`). **`bun build` does not typecheck** — it happily compiles `const x: number = "str"`, so the old advice to rely on it for type errors was wrong. Still build each entry point (`bridge`, `channel-server`, `manager`, `launcher`, `cron`, `setup`) to catch module-resolution errors that typechecking misses. CI runs all three on every push and PR.
- Test suite (`bun test`) currently exercises pure logic (cron parser, JSONL cost rollup, tmux modal parser, peers.ts encode/parse, router.ts envelope helpers, skills discovery, slash-registry). `bridge.ts` itself has no isolated unit tests because of its Discord-client + ws + peers.json coupling — live verification through a second Claude Code session in a sandbox Discord server is the coverage there.
- New outbound Discord messages (reply, notification, forward) should build an `Envelope` and call `deliver()` rather than calling `discordReply` / `channel.send` directly. `renderContentForLocal` centralises header rendering; don't hand-inject headers in call sites.
