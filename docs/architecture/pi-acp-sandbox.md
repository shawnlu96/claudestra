# Pi agents over ACP in the dev sandbox

The [dev sandbox](./sandbox.md) runs Claude Code agents, the Codex ACP stub, and — with the rules below — Pi agents over ACP (`transport=acp`: `acp-host.ts` → `lib/acp/pi-adapter/` → `pi --mode rpc`). Background: the evaluation report `docs/design/pi-acp-eval.md` §5 on the `spike/pi-acp-eval` branch. Code: `lib/sandbox.ts` (`sandboxPiAgentDir`, `sandboxPiAgentDirProblem`, `assertSandboxRuntime`), `lib/acp/pi-adapter/sandbox-policy.ts` (adapter args + env), `scripts/sandbox-pi-auth.ts` (credential opt-in). Proof: `tests/pi-acp-sandbox.test.ts`.

```bash
bun run sandbox up
bun run sandbox pi-auth deepseek                      # from a normal shell: copy ONE provider's API key into the sandbox
bun run sandbox manager create sbx-pi /tmp/claudestra-sandbox-23900/work "test" --runtime pi   # acp is the only transport here
```

## What is allowed, what is refused

| Case | Result | Where |
|---|---|---|
| `runtime=pi`, `transport=acp`, `PI_CODING_AGENT_DIR` byte-equal to `<sandbox root>/pi-agent` | allowed (in the sandbox `create --runtime pi` picks acp) | `assertSandboxRuntime` (manager create / restart / transport, `buildPiAcpHostCommand`); the host re-checks before spawning the adapter |
| Pi over tmux (`--transport tmux`, `transport <agent> tmux`, an old tmux record on restart) | refused | manager whitelist, `assertSandboxRuntime`, `buildPiCommand` |
| `PI_CODING_AGENT_DIR` unset, elsewhere (`~/.pi/agent`, another dir under the root), or another spelling of the same path (`…/pi-agent/`, `…/x/../pi-agent`) | refused | same two places |
| Sandbox root unset or relative | refused (the dir can't be derived) | same |
| pi args without `--no-extensions --no-skills --no-prompt-templates`, or with `-e` / `--extension` / `--skill` / `--prompt-template` / `--theme` / `--mcp-config` / `--session-dir` (also `--x=…`) | refused | host, `sandboxPiProblem` |
| The agent's registry `piEnv` profile | ignored: the sandbox always uses the minimal set | `piAcpArgs` |
| `pi-auth` from a shell carrying the sandbox env, into a dir without a sandbox marker, OAuth credentials, `!command` keys, several providers at once | refused | `cmdPiAuth`, `pickPiCredential` |

Outside the sandbox (`CLAUDESTRA_SANDBOX` unset) none of this runs: production launch commands, adapter env and `piAgentDir()` are unchanged (pinned in `tests/pi-acp-sandbox.test.ts` and `tests/pi-acp-runtime.test.ts`).

## Decision 1 — the Pi dir is derived from the sandbox root, never caller-supplied

**Threat.** Without `PI_CODING_AGENT_DIR`, pi uses `~/.pi/agent`: the owner's sessions (and the bridge would discover, archive and set-session onto them), `settings.json` packages (pi installs missing ones from npm), extensions, `mcp.json` servers (mem0 and friends write real data), `auth.json`, and it would write `trust.json` and new sessions there.

**Rule.** The only accepted value is `join(<root>, "pi-agent")`, compared as a string. It is enforced in five places, so each process that touches Pi state gets it without trusting the one before:

1. `sandboxEnv` sets it, so manager and bridge see it.
2. `assertSandboxRuntime("pi", env, "acp")` refuses anything else at create / restart / transport time (a mismatched value is refused, not silently replaced, so nobody believes a custom dir is in effect).
3. The launch command carries the checked value explicitly (tmux windows inherit the tmux server's env, not manager's).
4. The host checks again before spawning the adapter; the adapter env overwrites `PI_CODING_AGENT_DIR` with the derived value and drops `PI_CODING_AGENT_SESSION_DIR` (pi's session-dir override).
5. In every sandbox process `piAgentDir()` returns the derived dir regardless of the environment, so session discovery, usage, AI inventory, archive and `set-session` (which now also accepts Pi sessions — needed for `/clear`) only ever look under the sandbox root.

## Decision 2 — HOME is isolated, global discovery is off

**Threat.** Even with the agent dir pinned, pi 0.99.2 reads from `$HOME`: user skills in `~/.agents/skills`, extension configs (`~/.pi-lens/…`), `~/.cache/huggingface/token` (built-in llama extension), globally installed packages under `~/.bun/install/global`.

**Rule.**
- The adapter, pi and the channel-server pi spawns run with `HOME=<root>/acp-home` — the same isolated home the Codex ACP chain uses (`sandboxAcpHome`).
- pi always gets `--no-extensions --no-skills --no-prompt-templates` (pi's help: *disable extension discovery and built-in extensions; explicit -e paths still work*). The adapter's own `-e builtin:mcp -e <mcp-mount>` come after and still load — that is what gives the model `reply`. Flags that load code or config from elsewhere are refused (table above); `npm:` / `git:` sources would download and execute packages.
- `PI_OFFLINE=1` (no version check, catalog refresh or package install at startup; the bundled model catalog still works — checked with 0.99.2) and `PI_TELEMETRY=0`.
- Kept on: project trust (`--approve`) and context files (`AGENTS.md` / `CLAUDE.md`). Both are discovered from the agent's cwd, which must be under the sandbox root, so they are the tester's own files.

## Decision 3 — model-provider network and credentials

**Network.** The outbound gate (`lib/sandbox-outbound.ts`) wraps clients inside Claudestra's own Bun processes. On the Pi chain that covers the host, the adapter (it loads `lib/paths.ts`, so the gate is installed and only its bridge port is allowed — it needs no network at all) and the channel-server (only the host's loopback proxy). **The `pi` process is a Node child process and is not gated**: its provider HTTPS calls, and whatever its bash tool runs, go out directly. That is acceptable for the same reason the `claude` binary is an ungated child in the sandbox: the gate exists to keep Claudestra's own code off the production bridge, relay, peers and push, and calling the model is the agent's job. Pi learns no production address from us — its MCP config names only the host's loopback proxy, and its environment comes from the sandbox allowlist (it does carry the sandbox `BRIDGE_URL`, without `BRIDGE_PORT`: the adapter's load-time sandbox check needs a non-production bridge address and refuses to load otherwise, and `BRIDGE_PORT` would make the channel-server's own check reject its proxy URL).

**Credentials.** By default the sandbox's pi has none: its dir and HOME are under the sandbox root and provider key variables (`DEEPSEEK_API_KEY` …) are not in the sandbox env allowlist — a fresh sandbox pi answers *No models available*. The only way in is explicit and per provider:

`bun run sandbox pi-auth <provider>` (from a normal shell, after `up`) copies that provider's `auth.json` entry and/or `models.json` provider block from the owner's Pi dir (`PI_CODING_AGENT_DIR` or `~/.pi/agent`, read only) into `<root>/pi-agent/`, merged with providers copied earlier. The target dir must be a real directory under the real sandbox root (a symlink is refused) and is forced to `0700` even if it already existed; each file is written through a uniquely named temp file (`O_EXCL|O_NOFOLLOW`, `fchmod 0600`) and renamed into place, and an existing target that is a symlink is refused (`src/lib/sandbox-pi-fs.ts`). It refuses:
- OAuth entries — pi refreshes OAuth tokens and rotates the refresh token; doing that in the sandbox would log the owner out;
- any value starting with `!` — pi runs it as a command to fetch the key (keychain reads etc.), which would happen inside the sandbox;
- running with the sandbox env (a sandbox agent's own Bash must not make this choice for the owner), and roots without a matching sandbox marker.

It prints the provider name and file paths only; parse errors of the owner's files are reported by path, never with the parser's message (which can quote file contents). `sandbox clean` deletes the copy with the root.

Session lookup / scan in the sandbox likewise ignores session dirs or files whose real path leaves the sandbox root. Before starting pi (manager, host, and every adapter open including `/clear`) the same real-path rule is applied to `<pi-agent>/{auth,models,settings,mcp,trust}.json` and `<pi-agent>/sessions`: an entry that exists must resolve inside the real sandbox root, a missing one is fine.

## Residual risks

- **No OS isolation.** pi's bash tool can read and write anything the user can, including `~/.pi`, `~/.claude-orchestrator` and the copied key, and reach the production bridge on loopback — exactly like a Claude Code sandbox agent's Bash. The rules above stop accidental crossover, not hostile model output (same threat model as [sandbox.md](./sandbox.md#known-boundaries)). Copy a scoped, cheap key.
- **Check-to-use windows on links.** The read side has a window between the real-path check and the open in which a link could be swapped, and the write side has a window in which a parent directory could be replaced by a link. Neither is defended against an adversarial process on the same machine, because without OS-level isolation such a process can already read the owner's files directly.
- **Project resources under the root.** pi reads a project's `.pi/settings.json` `sessionDir` before resolving trust, and a trusted project's `.pi/mcp.json` adds MCP servers. Both live in dirs the tester creates under the sandbox root; we don't police their content.
- **Future pi versions** may add discovery. HOME-relative paths stay inside the isolated home; a new absolute path or environment variable would not be covered until added here.
- **Read-only leftovers.** The bridge's skill library still lists skill path names from the owner's `~/.pi/agent/settings.json` (`readPiGlobalEnv` default), names only. The host and channel-server start without `--no-env-file`, as on the Codex ACP chain: Bun may load a `.env` from the agent's cwd (under the sandbox root), and explicit variables always win.

## Proof

`tests/pi-acp-sandbox.test.ts`: allowed case; every refusal (tmux Pi, unset / foreign / non-canonical dir, missing or relative root, other runtimes, manager whitelist, create's transport choice); `piAgentDir()` ignoring a hand-set dir in the sandbox; `set-session` accepting a sandbox Pi session and refusing one outside the root or only in the owner's dir; host-side arg checks (each refused flag) and production left alone; adapter env in the sandbox vs. byte-identical production env; the adapter actually loading under the sandbox env and failing to load without `BRIDGE_URL`; the launch command carrying the pinned dir and dropping the registry profile, and agreeing with the host check; credential copy (modes, merge), every refused credential kind, no secret in any message or output. End-to-end runs in a live sandbox are the next step (PR3).
