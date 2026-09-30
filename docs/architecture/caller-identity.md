# MCP caller identity (T85)

The bridge has to know **which agent, which session and which model family** made an MCP tool call, without trusting anything the caller reports about itself. M2/M3 dispatch tools (`take_order`, `deliver`, `submit_verdict`, …) build on this. The only tool added so far is the read-only probe `whoami`.

## Threat model (fixed, do not widen)

Every bypass agent is already an unrestricted shell on this machine, so **deliberate** forgery cannot be stopped. The design only defends against two accidents:

- **Misdelivery**: a Bash subprocess inherits `DISCORD_CHANNEL_ID`, happens to start a `channel-server`, and that process claims the agent's channel.
- **Crossed sessions**: one session submits results using another session's identity.

## How it works

1. **Issue** (`lib/caller-cred.ts`, `lib/caller-cred-launch.ts`): every launch through `manager` `launchInWindow` (create / resume / restart / fork) and every master launch in `launcher.ts` issues a fresh 32-byte random credential. `caller-creds.json` (state dir, mode 0600) stores only `sha256 → {agent, sessionId at launch, family, issuedAt}`. A new credential for an agent deletes that agent's previous record, so the old credential stops working immediately.
2. **Hand-off** without touching the main process environment:
   - **Claude Code**: a one-shot file (0700 dir, 0600 file) holds an MCP config with just the `claudestra` server, and the credential sits in that server's `env`. The launch command passes `--mcp-config "$(cat <file>; rm -f <file>)"`. A same-name `--mcp-config` overrides the user-scope registration, and Claude Code merges the entry's `env` into the server's environment only. Claude Code and its Bash tool never see it (both verified by hand with a probe server). The Bash test is in `tests/caller-cred.test.ts`.
   - **Codex ACP**: the same one-shot file becomes `CLAUDESTRA_CALLER_CRED=…` for the `acp-host` command only. `acp-host` removes it from `process.env` before it spawns anything. `adapterEnv` copies `process.env`, so without that removal the credential would reach Codex's shell commands. It also never goes into `CODEX_CONFIG`, because codex-acp logs that value verbatim at startup and passes it on to app-server.
   - The command line, zsh history and the tmux screen contain only the file path. The shell reads and deletes the file when it expands the command. `manager` deletes it again after the ready check, and `launcher` a minute after sending. Unread files older than 10 minutes are swept at the next issue.
3. **Register**: `channel-server` reads the credential into memory and deletes the env var, so its own children such as `codex queue` don't inherit it. After the MCP handshake it sends the credential in the `register` frame as `callerCred`, and `acp-host` does the same in its own register frame. The bridge (`bridge/caller-identity.ts`) keeps only the hash, attached to that ws.
4. **Resolve** (`lib/caller-identity.ts`, pure): `CallerIdentity {agent, sessionId, family, verified}`. `verified` requires:
   - the hash is still in the store;
   - the credential was issued to the agent that owns the registered channel (master = control channel);
   - the frame was not downgraded by the ACP proxy.

   `agent`, `sessionId` and `family` come from the registry's current values, because `/clear` and ACP thread rotation change the session id after launch. Nothing the caller reports about itself counts. The check runs again on every call, so an old connection drops to `verified=false` as soon as the agent restarts.
5. **Tools**: `callerIdentity(ws, frame)` gives the identity. `requireVerified()` → `identity_unverified` is the gate for M2/M3 tools. `whoami` returns the structure.

## Misdelivery guard

If a channel is held by a connection whose credential is still valid, a registration **without** a valid credential is refused (`rejected` + close 4002). The newcomer backs off and retries as usual. It does not treat this as being replaced, and it does not exit. Situations this does not affect:

- `/mcp` reconnect: the new instance carries the same credential;
- restart: the old credential is gone, so the old holder is unverified;
- the upgrade window: nobody has a credential yet.

## ACP loopback proxy

Under ACP the host is the only bridge registrant. Codex's `channel-server` instances talk to the host's loopback tool proxy, and their calls reach the bridge on the host's verified connection. The proxy token is in `BRIDGE_URL`, which Codex shell commands also inherit. For that reason `channel-server` reports `outsideMcpLauncher` when its environment contains adapter-only variables (`APP_SERVER_LOGS`, `INITIAL_AGENT_MODE`, `CODEX_CONFIG`). Codex's MCP env whitelist never passes those on, so their presence means the process was started from a shell. The proxy then marks every frame from that connection `callerDowngraded`, and does the same for connections that never registered. It also strips any `callerCred` / `callerDowngraded` a client sends itself.

## Known limits (accepted, not P1)

- Deliberately reading the credential is out of scope. That covers the Claude Code / acp-host argv (`ps`), process memory, the one-shot file in its sub-second window, and `/mcp` details.
- Runtimes not covered, always `verified=false`: Pi, Codex tmux transport, HTTP peers / remote agents.
- If the one-shot file is gone before the shell expands the command, the session starts with the same config minus the credential (`verified=false`).
- The ACP `outsideMcpLauncher` signal is self-reported. It catches accidents, not intent.
