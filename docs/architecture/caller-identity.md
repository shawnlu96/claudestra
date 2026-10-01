# MCP caller identity (T85)

The bridge has to know **which agent, which session and which model family** made an MCP tool call, without trusting anything the caller reports about itself. M2/M3 dispatch tools (`take_order`, `deliver`, `submit_verdict`, …) build on this. Tools built on it so far: the read-only probe `whoami` and the M2 executor tools `take_order` / `deliver` / `ask` (T96).

## Threat model (fixed, do not widen)

Every bypass agent is already an unrestricted shell on this machine, so **deliberate** forgery cannot be stopped. The design only defends against two accidents:

- **Misdelivery**: a Bash subprocess inherits `DISCORD_CHANNEL_ID`, happens to start a `channel-server`, and that process claims the agent's channel.
- **Crossed sessions**: one session submits results using another session's identity.

## How it works

1. **Issue** (`lib/caller-cred.ts`, `lib/caller-cred-launch.ts`): every launch through `manager` `launchInWindow` (create / resume / restart / fork) and every master launch in `launcher.ts` issues a fresh 32-byte random credential. `caller-creds.json` (state dir, mode 0600) stores only `sha256 → {agent, sessionId at launch, family, issuedAt}`. A new credential for an agent deletes that agent's previous record, so the old credential stops working immediately. A launch whose runtime issues no credential (Pi, Codex tmux — including a switch or fallback from ACP to tmux) still revokes the agent's previous records (`issueLaunchCred` with no kind).
2. **Hand-off**: the credential lives only in a one-shot file (0700 dir, 0600 file). Every argv and every environment carries just the file's **path**. Two reasons:
   - any same-user process can read argv with `ps`;
   - it can also read a process's **launch environment** with `ps -E`. Checked on macOS: this works for non-platform binaries such as bun, and still works after the process deletes the variable from `process.env`.

   Delivery per runtime:
   - **Claude Code**: `--mcp-config` carries an inline config with just the `claudestra` server, and that server's `env` holds `CLAUDESTRA_CALLER_CRED_FILE=<path>`. A same-name `--mcp-config` overrides the user-scope registration, and Claude Code merges the entry's `env` into the server's environment only. Claude Code and its Bash tool never see even the path (both verified by hand with a probe server). The Bash test is in `tests/caller-cred.test.ts`.
   - **Codex ACP**: `CLAUDESTRA_CALLER_CRED_FILE=<path>` goes to the `acp-host` command only. The host reads the file, deletes it and drops the variable before it spawns anything. The credential never goes into `CODEX_CONFIG`, because codex-acp logs that value verbatim at startup and passes it on to app-server.
3. **Register**: the MCP server (`channel-server`, or `acp-host` under ACP) reads the file into memory and deletes it (`takeCallerCred`). It only deletes files that match the one-shot naming pattern. After the MCP handshake it sends the credential in the `register` frame as `callerCred`. The bridge (`bridge/caller-identity.ts`) keeps only the hash, attached to that ws.

   Backstop deletion (`withOneShot`, `tests/caller-cred-cleanup.test.ts`):
   - The whole launch — build the command, send it, wait for ready — runs inside `withOneShot`. Whatever the outcome (ready, not ready, a sync throw such as `CreateAborted`, a rejection), the file is deleted when it returns.
   - On ready, `manager` (`launchWithCallerCred`) and `launcher` first wait up to 20 s for the MCP server to consume the file. Claude Code's ready signal is its TUI prompt, which can appear before the MCP server starts.
   - While a file is pending, the process also deletes it on `exit` and on SIGINT / SIGTERM / SIGHUP. The signal hook does not change exit semantics: if another listener exists (create's signal cleanup) it decides; otherwise the process re-raises the original signal.
   - `kill -9` can't be hooked: unread files older than 10 minutes are swept at every issue and on every launcher tick (15 s), so a leftover is gone within about 10 minutes even if nothing launches again.
4. **Resolve** (`lib/caller-identity.ts`, pure): `CallerIdentity {agent, sessionId, family, verified}`. `verified` requires:
   - the hash is still in the store;
   - the credential was issued to the agent that owns the registered channel (master = control channel);
   - the frame was not downgraded by the ACP proxy.

   `agent`, `sessionId` and `family` come from the registry's current values (master: latest session in `MASTER_DIR`), because `/clear` and ACP thread rotation change the session id after launch. Nothing the caller reports about itself counts. The check runs again on every call, so an old connection drops to `verified=false` as soon as the agent restarts.
5. **Tools**: `callerOf(ws, frame)` gives the identity and the connection's channel. `requireVerified()` → `identity_unverified` is the gate for M2/M3 tools. `whoami` returns the structure.

### Dispatch tools (M2, T96)

Every dispatch tool travels as one frame type, `order_tool {tool, args}` (`lib/order-tools.ts` defines the tools on the `channel-server` side). The ACP loopback proxy forwards only that type, and `bridge.ts` hands it to `bridge/order-tools.ts` in one line. To add a tool (M3 `take_review` / `submit_verdict`), add one entry to `ORDER_TOOLS` and one to `HANDLERS`.

- **Gate first** (`lib/order-tool-route.ts`). An unverified caller gets `identity_unverified` before any handler runs. That covers: no credential, a credential replaced by a newer launch, and an ACP frame marked `callerDowngraded`. Handlers receive `agent` / `sessionId` / `family` / `channelId` from the identity only; the arguments cannot set them.
- **Arguments** go through the T87 parsers: `parseDeliverWire` / `parseAskWire` (`lib/order-wire.ts`). `take_order` output is checked with `parseOrderWire` before it is returned.
- **Ledger writes** (`lib/order-ledger-exit.ts`). The bridge runs `manager ledger <sub>` with `DISCORD_CHANNEL_ID` set to the caller's channel, so the CLI computes `actor` exactly as for a hand-typed command. Every write carries `--dedup`. Session and family flags come from the identity (`identityFlags`). The bridge writes no ledger rows itself; asks are the existing exception.
- **`take_order`** (`lib/order-take.ts`) returns the caller's current order: a card in `build` / `fix` whose active step is assigned to the caller. If the card has a non-retired author session binding, that binding's agent and session must also match the caller. The order id is the scheduler's dispatch intent id, or `<task>:<step>:r<round>` for a card a PM assigned by hand. If there is no order, `order` is `null`.
- **`deliver`** (`lib/order-deliver.ts`) has the same effect as `ledger deliver --from build|fix --head --evidence`. The checks run in this order:
  1. The wire must parse, and head must be a lowercase 40-hex SHA.
  2. A retry with the same `mcp-deliver:<orderId>:<head>` key returns the first receipt (order id, `review`, event seq), whatever stage the card is in now. It only does so if the first delivery was this caller's.
  3. The order id must be one of the caller's current orders.
  4. The bridge reads the card's branch head on origin itself (`git ls-remote` in the caller's registry cwd, 15 s). If it can't read it, or the head differs, the call is refused.
  5. The card's `rev` and branch, read before the origin check, go to the CLI as `--rev` / `--branch` preconditions. The CLI checks them, the stage and the executor inside the write transaction; if the card changed during the check (a new branch, a PM taking it back), it refuses and writes nothing.
- **`ask`** (`lib/order-ask.ts`) takes a question about the caller's current order. It opens an `asks` row assigned to the card's `pm`, or to the first name on the project PM list if the card has none. It then notifies that PM through the team-router delivery path (`sendLedgerNotice`: sent directly if the PM is online and idle, held otherwise). The question and options appear in the notice only as quotes. The ask stays `extra.notice = pending` until the notice is sent or held; a retry with the same arguments re-sends a still-pending notice under the same message id. Answers still come back as ordinary `send_to_agent` messages.
- **CLI stays**: `ledger deliver` and the rest keep working. Pi, Codex tmux, and anything else that is `verified=false` must use the CLI.

### Reviewer tools (M3, T97)

`bridge/review-tools.ts` adds two entries to the same `HANDLERS`.

- **`take_review`** is read-only (`lib/review-order.ts`). It returns the caller's review orders: on an auto card, the bound reviewer session; otherwise, the executor of the `currentReview` step.
- **`submit_verdict(VerdictWire)`** writes through `ledger submit-verdict`, which re-checks every rule on the write connection (`lib/review-verdict.ts`):
  - the order is the caller's current one, the head equals the order's head, and the reviewer is not the author;
  - p0 / p1 / p2 counts match the findings, and the report is a non-empty file under `ledger/reviews/`;
  - session and family must equal the registry's current values;
  - the call must carry a one-shot ticket the bridge issued after the identity gate (`lib/verdict-ticket.ts`), bound to the actor and the whole wire. An agent that runs the subcommand from its shell out of habit is refused; a deliberate forgery is not stopped (see Known limits).

  It never moves the stage. The same verdict retried is a no-op; a different second verdict is refused.

### Scheduler wake-up dispatch (i28-M4b)

- **How an auto card is dispatched** is fixed before the claim (`deliveryFor` in `lib/worker-session.ts`) and written into the claim and the receipt as `delivery=wake` or `delivery=text（reason）`. Claude Code over the channel and Codex over ACP get one wake-up line naming the order id (`renderWakeLine` in `lib/worker-order.ts`); the order stays in the ledger and is pulled with `take_order` / `take_review`. A Codex tmux session and restate orders keep the full text, and so does any order the pickup tools could not build right now (`lib/order-pullable.ts` builds it the same way before the wake). Findings copied into a fix or review order are trimmed to fit the 32 KiB wire, with a pointer to the full report (`fitFindings` in `lib/order-findings.ts`). One intent is only ever sent one way, and a replay or reconcile never re-sends it.
- **Pickup record**: after `take_order` / `take_review` returns a scheduler order, the bridge runs `ledger order-taken <orderId> --session` as the caller (`lib/order-mark.ts`). The CLI accepts only the intent's recipient on the ledger-bound session, and only for a sent intent. A failed record is only logged.
- **Unclaimed alarm**: a wake-up with no pickup after 10 minutes gets one `scheduler-unclaimed` event, which holds the alarm text. `scheduler-unclaimed-sent` is written only after PM got the notice; until then the same text is resent at most once a minute, so a bridge outage delays the alarm instead of dropping it. Reconcile treats a pickup record as proof that a claimed order arrived.
- **ACP turn failures** that the adapter says cannot be retried (policy blocks such as `cyber_policy`, bad requests, exhausted context) open a "Codex 回合失败" card (`extra.failure = error`, `bridge/acp-link.ts`). When it is tied to an order claimed before it, the scheduler hands the card to PM (`codexFailure` in `lib/scheduler-auto-ports.ts`).

## Misdelivery guard

If a channel is held by a connection whose credential is still valid, a registration **without** a valid credential is refused (`rejected` + close 4002). The newcomer backs off 3s → 60s (`lib/link-policy.ts` `reconnectDelayMs`). Its counter resets only on `registered`, not on connect, so a rejected stray does not retry every 3 s. It does not treat this as being replaced, and it does not exit. `tests/caller-reject.test.ts` pins both sides. Situations this does not affect:

- `/mcp` reconnect: the old instance is gone, so there is no holder. The new instance finds the file already consumed and registers as `verified=false`. Restart the agent to get a fresh credential.
- restart: the old credential is gone, so the old holder is unverified;
- the upgrade window: nobody has a credential yet.

## ACP loopback proxy

Under ACP the host is the only bridge registrant. Codex's `channel-server` instances talk to the host's loopback tool proxy, and their calls reach the bridge on the host's verified connection. The proxy token is in `BRIDGE_URL`, which Codex shell commands also inherit. For that reason `channel-server` reports `outsideMcpLauncher` when its environment contains adapter-only variables (`APP_SERVER_LOGS`, `INITIAL_AGENT_MODE`, `CODEX_CONFIG`). Codex's MCP env whitelist never passes those on, so their presence means the process was started from a shell. The proxy then marks every frame from that connection `callerDowngraded`, and does the same for connections that never registered. It also strips any `callerCred` / `callerDowngraded` a client sends itself.

## Lend workers' lend profile (i28-W4)

A one-shot lend worker (`agent-lend-*`, Codex over ACP in a clean environment) on the lender B uses the same pickup tools as a local reviewer: `take_review`, then `submit_verdict`. Its calls land on its one order and are relayed to the borrower A. They never reach B's own ledger, PM, DAG or channel tools. Two layers block everything else, and the bridge checks the order again:

- **MCP profile** (`lib/lend-mcp-profile.ts`): the clean host mounts `channel-server` with `CLAUDESTRA_MCP_PROFILE=lend` (`lib/acp/adapter-proc.ts`; bun skips the clone's `.env*` / `bunfig.toml`). It lists only `take_order`, `deliver`, `ask`, `take_review`, `submit_verdict` and `whoami`, and refuses any other call. An `agent-lend-*` name turns the profile on even if the variable was dropped. An unknown profile value exposes no tools.
- **Proxy** (`lib/acp/tool-proxy.ts`): with `CLAUDESTRA_ACP_CLEAN_ENV=1` the loopback proxy forwards only `whoami` and `order_tool` frames for those five tools. `reply`, `route_to_agent`, `forward_to_agent`, `fleet_*`, `project_info`, `check_inbox` and the rest are logged and answered with an error, never forwarded.
- **Bridge** (`bridge/order-tools.ts` → `bridge/lend-tools.ts` → `lib/lend-tools.ts`): an `agent-lend-*` caller is routed away before `HANDLERS`. Unverified callers are refused there too; they never fall back to the local handlers. The fixed flow: verified and not downgraded; exactly one live journal row with `agent` = the caller, and with the caller's session; an `orderId` argument must match that row; the tool must fit the step (review: `take_review` / `submit_verdict`; build / fix: `take_order` / `deliver`; `ask` for both). Write orders are refused outright until hard isolation (i28-W8).
- **One order, one binding**: the agent name is `workerName(orderId)`, and W3 refuses the same order id from a second peer at claim, so a name maps to at most one live row. Everything sent to A (peer, `orderId`, `gen`, the verdict body) comes from that row (`commitLendResult` in `lib/lend-submit.ts` builds the body from it), never from the arguments. Outbound calls go only over E2E: the peer must pass `peerLendProblem`, the transport is `e2eOnly`, and an answer that did not come back over E2E is treated as not received.
- **Tools**: `take_review` returns the order and A's brief from the journal (sha256 checked at claim). `submit_verdict` reads `reportPath` inside the clone (`readReportIn`: no symlinks or hard links, regular file, ≤ 64 KiB, inode re-checked after open). It records `result_pending` through the same core as the CLI `lend submit` fallback, then forwards `lend/result` to A at once and hands the receipt back. The scheduler still resends the same bytes and verifies the receipt, so a failed synchronous forward loses nothing. The same body again is idempotent; a different body is refused. `ask` is relayed as `lend/ask` only when A speaks proto 2; otherwise the worker is told plainly that A does not support it.
- **Known limit**: the worker runs as B's OS user, and the proxy token sits in `BRIDGE_URL`, which its shell inherits. A shell that connects to the proxy gets the same five tools and nothing more, and anything it could do outside them (read B's keys, sign peer requests, write the journal) is open to the worker anyway. Hard isolation is W8. `tests/lend-tools.test.ts`, `tests/lend-mcp-profile.test.ts`, `tests/acp-tool-proxy.test.ts` pin the layers.

## Known limits (accepted, not P1)

- **Plaintext on disk, from launch to consumption**: the one-shot file exists from the moment `manager` / `launcher` writes it until the MCP server reads it. That is normally about a second; at most it lasts until the launch ends (ready + 20 s, failure, exception or signal). Only a `kill -9` of the launching process leaves it longer, until the 10-minute sweep. Reading the file inside that window is out of scope, and so is deliberately reading process memory. Everything else holds only the path or the hash.
- Master's `sessionId` is master's current session in `MASTER_DIR` as the bridge sees it (master is not in the registry); if none is found yet, the id recorded at launch.
- Runtimes not covered, always `verified=false`: Pi, Codex tmux transport, HTTP peers / remote agents.
- If the one-shot file is gone when the MCP server starts (`/mcp` reconnect, a swept file), the session still works, with `verified=false`.
- The ACP `outsideMcpLauncher` signal is self-reported. It catches accidents, not intent.
- The `submit_verdict` ticket is not a security boundary. A same-user process can write a one-shot file in the ticket format and compute the hash itself, because the manager has no independent secret to check against: a MAC key handed over by the caller, or a round trip to a bridge address taken from the environment, can be faked the same way. It can also write the ledger's sqlite file directly. The ticket only stops an agent that runs `ledger submit-verdict` from its shell out of habit. `tests/review-tools.test.ts` pins this.
