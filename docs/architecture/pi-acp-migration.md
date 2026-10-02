# Pi over ACP: the default for new agents, migration for old ones

`transport=acp` runs a Pi agent through the ACP host and the repository's Pi adapter (`acp-host.ts` → `lib/acp/pi-adapter/` → `pi --mode rpc`) instead of the TUI over tmux.

## New and adopted agents (create / resume / adopt)

Like Codex, a Pi agent gets ACP by default when the checks pass (`src/manager/acp-lifecycle.ts`, tests: `tests/pi-default-acp.test.ts`):

- `--transport tmux|acp` is used as given (`create`, `resume`, and `adopt` for Pi agents). An explicit `tmux` is recorded in the registry, so a later resume / adopt of the same name keeps it. `adopt --transport acp` still runs the checks below first and refuses (non-zero exit, registry untouched, old agent not stopped) when they fail.
- Without it, the same checks as `migrate --pi` decide: pi ≥ 0.99.0 and no `claudestra` server in pi's `mcp.json` / no capability profile that filters out `reply`. Pass → acp; fail → tmux, with the reason in the output (`transportNote`; adopt prints it to stderr) and `acpPending` in the registry so the next resume / adopt tries again. `migrate --pi <agent>` moves it once the checks pass.
- If the ACP host does not come up (not ready, or building the launch command throws — e.g. a profile that excludes `reply`, a clashing project `mcp.json`), create / resume stop the host and start the TUI version in the same window; adopt goes through `restart`, which now falls back the same way for every ACP Pi agent as it does for Codex, including the launch-command throw (`acpPending` is set). The output says `transport: "tmux"` with the reason, and no dead window is left behind.
- `resume --fork` is refused for ACP Pi (non-zero exit, before any channel / window / registry write): Pi has no real session fork — its `--session-id` is open-or-create, and the tmux version's `--fork` just reopens the same session. Drop `--fork`, or pass `--transport tmux` for the old behaviour.
- `adopt` changes the transport only when the choice differs from the record; a record whose `transport` is explicitly `tmux` (a manual choice or a rollback) stays on tmux.
- The sandbox is unchanged: it only has the ACP Pi, never probes the production pi, and never falls back (`docs/architecture/pi-acp-sandbox.md`).

## Migrating an existing agent

Existing Pi agents are not moved by `update` or `restart`: they stay on tmux until someone migrates (or adopts) them by name. Code: `src/manager/pi-acp-migration.ts`; tests: `tests/pi-acp-migration.test.ts`.

```bash
bun src/manager.ts migrate --pi <agent>            # tmux → acp
bun src/manager.ts migrate --pi <agent> --to tmux  # back to the TUI (same as: transport <agent> tmux)
```

What `migrate --pi` does:

1. Refuses agents that don't exist or aren't Pi (Codex has its own `migrate --acp`); an agent already on acp is left alone.
2. Switches through the same path as `transport <agent> acp`: pi ≥ 0.99.0, no `claudestra` server in pi's own `mcp.json` (it would silently replace the mounted channel-server), then registry + restart. A refusal at this stage changes nothing.
3. If the acp restart fails, the agent goes back to tmux and is started again, so a working agent is not left as a dead window (`fellBack: true`): `restart` itself stops the host and starts the TUI (as for Codex); only when the registry still says `acp` does `migrate --pi` switch back and restart once more. The result re-reads the registry afterwards: `transport` / `sessionId` are what the registry actually holds and `ready` says whether the tmux restart came up (if it did not, the registry is already `tmux` and `fallbackError` carries the reason). The sandbox never falls back: it has no TUI Pi.
4. Reports the session id before and after (`sameSession`). Both transports start pi with the registry's `--session-id` (open-or-create), so the conversation continues.

Differences after the move:

- `reply` and the other Claudestra tools come from the channel-server over MCP (`mcp__claudestra__reply`) instead of the TUI extension's native `reply`. Old turns in the session still show the old tool names.
- A capability profile's `--tools` allowlist filters MCP tools too (pi 0.99.2); `reply` is appended to it automatically (`keepReplyTool` in `lib/runtimes/pi-acp.ts`).
- Extension dialogs are always cancelled (owner decision): an extension that asks for confirmation, such as a safety-net package, now blocks the action instead of asking.
- The web command list shows extension / package commands and `/compact` only; the TUI built-ins (`/reload`, `/session`, `/copy` …) and the TUI extension's `/claudestra-*` commands are gone. `/compact [instructions]` is mapped to pi's rpc `compact`; `/clear` rotates the session through the host.
