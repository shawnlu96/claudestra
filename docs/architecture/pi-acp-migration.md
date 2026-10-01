# Moving a Pi agent from tmux to ACP

Pi agents default to the TUI over tmux. `transport=acp` runs them through the ACP host and the repository's Pi adapter instead (`acp-host.ts` → `lib/acp/pi-adapter/` → `pi --mode rpc`). Nothing moves on its own: production Pi agents stay on tmux until someone migrates them by name. Code: `src/manager/pi-acp-migration.ts`; tests: `tests/pi-acp-migration.test.ts`.

```bash
bun src/manager.ts migrate --pi <agent>            # tmux → acp
bun src/manager.ts migrate --pi <agent> --to tmux  # back to the TUI (same as: transport <agent> tmux)
```

What `migrate --pi` does:

1. Refuses agents that don't exist or aren't Pi (Codex has its own `migrate --acp`); an agent already on acp is left alone.
2. Switches through the same path as `transport <agent> acp`: pi ≥ 0.99.0, no `claudestra` server in pi's own `mcp.json` (it would silently replace the mounted channel-server), then registry + restart. A refusal at this stage changes nothing.
3. If the acp restart fails, switches back to tmux and restarts again, so a working agent is not left as a dead window (`fellBack: true`). The sandbox never falls back: it has no TUI Pi.
4. Reports the session id before and after (`sameSession`). Both transports start pi with the registry's `--session-id` (open-or-create), so the conversation continues.

Differences after the move:

- `reply` and the other Claudestra tools come from the channel-server over MCP (`mcp__claudestra__reply`) instead of the TUI extension's native `reply`. Old turns in the session still show the old tool names.
- A capability profile's `--tools` allowlist filters MCP tools too (pi 0.99.2); `reply` is appended to it automatically (`keepReplyTool` in `lib/runtimes/pi-acp.ts`).
- Extension dialogs are always cancelled (owner decision): an extension that asks for confirmation, such as a safety-net package, now blocks the action instead of asking.
- The web command list shows extension / package commands and `/compact` only; the TUI built-ins (`/reload`, `/session`, `/copy` …) and the TUI extension's `/claudestra-*` commands are gone. `/compact [instructions]` is mapped to pi's rpc `compact`; `/clear` rotates the session through the host.
