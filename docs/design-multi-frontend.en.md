# Design Doc: Multi-Frontend Architecture (Decoupling from Discord → Web / Telegram / API)

> **English** · [简体中文](./design-multi-frontend.md)

> Status: **implemented** (A + B + C1, finished in an all-nighter on 2026-07-09, batched for release in v2.6.0)
> Deviations between the implementation and the design are recorded in §11. C2 (full absorption of Discord) proceeds incrementally per D8 and is not a scheduled project.
> Goal: demote Discord from "the face of the system" to "the first adapter". Decouple the core from any chat platform so that a web frontend, a Telegram bot, and a plain HTTP integration are all **consumers of the same interface**, and adding a new frontend requires no change to the core.

## 0. TL;DR

- Core insight: v2.0.0's `Envelope{from,to,intent}` + `deliver()` is already a platform-agnostic routing kernel. Only three things are missing:
  1. **A neutral message format** (NeutralMessage) and a **ChatAdapter interface** — the platform abstraction at the ingress/egress;
  2. **A unified, prefixed chat_id keyspace** (`discord:<id>` / `telegram:<id>` / `api:<token>`) — so all pending/thread/registry logic needs zero changes for a new frontend;
  3. **A structured event stream** (event-bus + SSE) — the data source for read-only frontends (web dashboards, monitoring).
- The agent side is **completely unaffected**: the `chat_id` of the MCP tools (`reply` / `send_to_agent`) was always an opaque string, so after prefixing it is simply echoed back as-is.
- Four phases, each independently shippable: A event stream → B inbound API + tokens → C1 outbound dispatch by transport → C2 fully absorbing Discord into an adapter (pure refactor, can wait). Telegram can be plugged in right after C1; the Web frontend only needs A+B.

## 1. Background and motivation

Three requests from the owner (2026-07-08/09):

1. **Open one specific agent up to an outside person** — Discord's permission model makes this awkward;
2. **A web prototype** — the interfaces in this design are the entire backend for that web version;
3. **Multi-frontend evolution** — being able to "easily plug in something like Telegram" in the future.

The principle is unchanged: **Keep it simple**. Every abstraction is cut at the point where "you only pay for it when a second implementation shows up"; no generalization we don't need.

## 2. Layered architecture overview

```
                          ┌──────────────────────────────────────┐
 Frontends (one adapter   │        Core (platform-agnostic)      │
 each)                    │                                      │
 Discord ────────────────►│  Envelope / deliver() routing kernel  │
 Telegram (future) ──────►│  registry / pending / thread tracking │◄──── channel-server (ws)
 Web / HTTP API ─────────►│  agent lifecycle (manager)            │◄──── jsonl-watcher
                          │  event-bus (structured events)        │◄──── hooks (Stop/Notification)
                          │  identity & authorization             │
                          │  (transport-scoped)                   │
                          └──────────────────────────────────────┘
        Inbound:   adapter receives a platform message → InboundMessage → Envelope → deliver()
        Outbound:  deliver() → NeutralMessage → adapterFor(dest).send()
        Read-only: event-bus → SSE (/events) → any subscriber
```

Three data channels; each frontend takes what it needs:

| Channel | Protocol | Who uses it |
|------|------|------|
| Conversation (send/receive messages) | adapter (Discord ws / Telegram long-poll / HTTP POST) | Frontends with human-to-agent conversation |
| Event stream (read-only, live) | SSE `GET /events` | Web dashboards, monitoring, anything that wants to watch the tool stream |
| Snapshot (read-only, pull) | `GET /stats` (already exists), `GET /api/v1/agents` | Dashboard initialization, health checks |

## 3. Core abstractions (the contract of this design; the frozen parts)

### 3.1 Unified chat_id keyspace (decision D7, generalizing D2)

Every "conversation address" is a string with a transport prefix:

```
discord:<channelId>       Discord channel
telegram:<chatId>         Telegram conversation (future)
api:<tokenId>             HTTP API user (Phase B)
web:<sessionId>           Web-side session (future, if web uses ws rather than the plain API)
<bare snowflake>          Compatibility form = discord:<id>, supported forever
```

- The keys of registry / clients / pendingReplies / thread all keep using this keyspace — they treat the key as an opaque string, so **zero changes**.
- The agent's MCP `reply(chat_id)` echoes it back as-is, so **the agent and channel-server need zero changes**.
- Parsing lives in exactly one place: `parseChatId(s) → { transport, id }` (`router.ts`). Inside the core, no new code may assume a bare id is a Discord id.

### 3.2 NeutralMessage (neutral message format, additive-only)

The parameters of the existing `reply` tool are already essentially neutral; here they are formally defined and frozen:

```ts
interface NeutralMessage {
  text: string;
  /** Neutral UI components. The existing {type:"buttons"|"select"} JSON is adopted as-is */
  components?: NeutralComponent[];
  /** Absolute local file paths (outbound attachments) */
  files?: string[];
  /** A message reference in the same keyspace (which message this replies to) */
  replyTo?: string;
}
// NeutralComponent = the raw JSON schema of the existing buttons/select, the one and only standard form.
// Interaction callback semantics (frozen): user clicks a button → an inbound message whose text is "[button:<id>]";
// selecting from a menu → "[select:<id>:<value>]". Identical across all transports; the agent notices nothing.
```

Compatibility promise: the three schemas NeutralMessage / NeutralComponent / BridgeEvent are **additive-only — fields may be added, never removed, and their semantics never change**.

### 3.3 The ChatAdapter interface (introduced in Phase C1; Discord is an implicit implementation first)

```ts
interface ChatAdapter {
  transport: string;                 // "discord" | "telegram" | ...
  caps: {
    maxTextLen: number;              // Discord 2000 / Telegram 4096
    buttons: boolean;                // unsupported → degrade to a numbered text list
    edit: boolean;                   // can edit an already-sent message (used for the merged edits of the tool stream)
    files: boolean;
    typing: boolean;
  };
  /** Outbound. Chunking, component rendering, and platform rate limits are the adapter's own business */
  send(destId: string, msg: NeutralMessage): Promise<{ messageIds: string[] }>;
  edit?(destId: string, messageId: string, msg: NeutralMessage): Promise<void>;
  typing?(destId: string, on: boolean): void;
  /** Inbound. The adapter calls back into the core when it receives a platform message; the core builds the Envelope and calls deliver */
  onInbound(cb: (m: InboundMessage) => void): void;
}

interface InboundMessage {
  chatId: string;                    // prefixed, e.g. "telegram:12345"
  userId: string;                    // user id within the transport
  username?: string;
  text: string;
  attachments?: string[];            // absolute paths, already downloaded into the local inbox
  messageId: string;
  replyToMessageId?: string;
}
```

Degradation rules (hardcoded in each adapter; no runtime negotiation):
- No `buttons` capability → render components as `1) label  2) label` text, the user replies with a number, and the adapter sends back `[button:<the matching id>]`;
- Too long → chunk by `caps.maxTextLen` (reusing `discordReply`'s line-based splitting algorithm, extracted into `lib`);
- No `edit` → the tool stream sends a new message every time (or that transport simply doesn't subscribe to the tool stream at all, see §6).

### 3.4 Identity and authorization (transport-scoped identity)

```
principal =  discord:<userId>   ← currently ALLOWED_USER_IDS, to be migrated into this form
          |  telegram:<userId>  ← future
          |  token:<tokenId>    ← Phase B
```

The authorization table is unified as a per-principal agent whitelist (`"*"` = everything; `master` must be listed explicitly):

```json
// ~/.claude-orchestrator/principals.json  (landed in Phase B, 0600)
{
  "principals": [
    { "id": "discord:535144625355096076", "role": "owner", "agents": ["*", "master"] },
    { "id": "token:tok_a1b2c3", "name": "contractor-Zhang", "agents": ["worker-alpha"],
      "secret": "<hex>", "disabled": false, "createdAt": "..." }
  ]
}
```

- The owner's Discord id migrates out of `.env` (reading `.env` is kept as a fallback so existing installs don't break).
- **Management capabilities follow `role`**: only `role: "owner"` can create/kill/cron; a token has conversation rights only by default. Turning the management surface into an API is future work (D6 unchanged), but the authorization model gets its `role` field now to avoid a later refactor.
- Rate limit of 30 req/min per principal (HTTP ingress).

**⚠️ Shared-context risk (gap R1, the most important item)**: token scope controls "whether you can talk to a given agent"; it has no control over "what is already in that agent's context". A Claude Code session has one context — if you open an agent the owner uses daily to an external token, an outsider's question may cause the agent to recite confidential content from the owner's earlier conversation; conversely, external input also pollutes the owner's working context. This matches the philosophy of peer collaboration: **exposure must be explicit and directed at a dedicated agent**. Three concrete measures:
1. Both the docs and the `token-add` CLI output print a warning: "only expose an agent created specifically for this purpose";
2. During `token-add`, if the target agent is not marked `external: true` (a registry field set by `--external` at create time), require `--force` to confirm;
3. When an agent receives an API message, the header states it explicitly: `[🌐 来自 API 用户 张三]` ("from API user Zhang San", §5.2), so the agent's system prompt can refuse sensitive content on that basis — but this is defense in depth, not the boundary itself.

## 4. Phase A — the event stream (the read-only foundation for multiple frontends)

### 4.1 event-bus (`src/bridge/event-bus.ts`)

An in-process bus plus a 500-entry ring buffer per agent, with a monotonically increasing seq and no persistence (the authoritative history is the jsonl, and a pure library to query it already exists).

```ts
interface BridgeEvent {
  seq: number; ts: string;
  agent: string;                     // registry name; master = "master"
  chatId: string;                    // that agent's primary conversation address (prefixed)
  type: "tool_start" | "tool_done" | "assistant_text" | "turn_duration"
      | "agent_status" | "auto_deny" | "question" | "chat_message";
  data: Record<string, unknown>;
}
```

Payload details (additive-only):
- `tool_start` `{toolId, name, summary}` / `tool_done` `{toolId, error}`
- `assistant_text` `{text, rateLimited?}`
- `turn_duration` `{durationMs}`
- `agent_status` `{status: "thinking"|"done"}`
- `auto_deny` `{reason}` / `question` `{questions}` (the raw AskUserQuestion structure)
- `chat_message` `{direction:"in"|"out", from, text, threadId}` — a mirror of real conversation messages

### 4.2 Instrumentation: mirror on the side, don't split the watcher (decision D1; rationale in the git history)

Add **one emit line each** in `processNewData` / `drainChannelWatcher` / the Stop hook / the success path of `deliver`, leaving the Discord rendering pipeline untouched. The event stream is a mirror, not something upstream of the pipeline — zero regressions, and new frontends (Telegram/Web) subscribe to the bus and render the "tool stream" themselves rather than reusing Discord's debounce/edit logic (that logic is an artifact of Discord's rate limits; Telegram has its own rate-limit rhythm).

### 4.3 SSE endpoint

```
GET /events?agent=<name>&since=<seq>     # Last-Event-ID works too
```

Standard SSE: `id:` = seq, `data:` = the BridgeEvent JSON, a 30s heartbeat comment. Unauthenticated on the local machine; after Phase B the same logic is mounted at `/api/v1/events` with token auth plus filtering by the principal's agent whitelist.

### 4.4 Tightening the bind

`Bun.serve` currently binds 0.0.0.0 by default (`/hook` and `/stats` are already exposed to the LAN). Change it to `hostname: "127.0.0.1"` and add a new env var `BRIDGE_BIND` to open it up. Exposing to the public internet = the user brings their own reverse proxy (Caddy / Tailscale Funnel); TLS and network boundaries are not the bridge's job. The release notes should warn users who run a custom `BRIDGE_URL` across machines.

## 5. Phase B — the inbound HTTP API (the backend for the web prototype)

### 5.1 Endpoints (mounted under `/api/v1/`; path versioning done once, up front)

```
POST /api/v1/agents/:name/messages    { text, wait?: seconds≤300 }
GET  /api/v1/agents                   agent list + status (scope-filtered)
GET  /api/v1/events?agent=&since=     the token-authenticated SSE
GET  /api/v1/threads/:threadId        polling fallback after a wait timeout (reads the ring buffer)
GET  /api/v1/files/:opaqueId          outbound attachment download (only paths the bridge registered are served)
```

Auth is `Authorization: Bearer <secret>`; the CLI provides `manager.ts token-add <name> --agents a,b` / `token-list` / `token-revoke`, and the secret is displayed only once, at add time.

### 5.2 Inbound flow

Authenticate → check scope (403) → look up `clients` (agent offline → 409) → `Envelope{ from: {kind:"api", tokenId, name}, to: local, intent:"request" }` → `deliver()`.
`resolveReplyBackChannel` returns `api:<tokenId>` → that is the agent's `chat_id`, and `reply` echoes it back as-is.
`renderContentForLocal` gains a `from.kind==="api"` branch with a header of the form `[🌐 来自 API 用户 张三]` ("from API user Zhang San"), so the agent knows its counterpart is not a Discord user (no @mention / push semantics).

### 5.3 Reply path

`deliver()` gains `case "api"` → `deliverToApi`:
1. Resolve the synchronous waiter (a `threadId → resolver` map) → the `POST`'s `wait` mode gets `{reply, components, files}` directly;
2. Emit a `chat_message(out)` event (SSE subscribers receive it);
3. Write to the ring buffer (the fallback for thread polling). **Discord is not touched.**

Buttons: components go into the response JSON as-is; the web page renders them as real buttons, and a click = a `POST` of `[button:<id>]`. This matches Discord's callback format (the frozen semantics of §3.2), and the agent notices nothing.

### 5.4 Audit mirroring (owner visibility, gap R2)

Peer collaboration deliberately routed cross-instance conversations through `#agent-exchange` so they could be audited (Update v2.11: Discord peers have been removed; HTTP peer auditing relies precisely on the mirroring mechanism in this section — see `docs/design-http-peers.md`). If API conversations never touched Discord, the owner would lose all visibility into "what an outsider said to my agent". Therefore **`deliverToApi` mirrors both directions of the conversation into that agent's Discord channel by default** (inbound `[🌐 API←张三] ...`, outbound `[🌐 API→张三] ...`, sent through the UI-class channel of `deliver(bridge→user)` so it never enters the agent's context). A per-token `mirror: false` turns it off (so high-frequency local automation doesn't spam the channel).

### 5.5 The wait mode and the Stop-hook fallback (gap R3)

An agent may `end_turn` without calling `reply()` (on Discord, the watcher's 💬 stream covers this). If the API's synchronous waiter only waits for a `reply`, it will sit there until it times out. **When handling the Stop hook, check for an API waiter belonging to that agent's ws**: still pending → resolve it with the `assistant_text` captured by the drain, marking the response `{ viaFallback: true }`; no text at all → resolve as `{ done: true, reply: null }`. This hangs off the existing per-ws pending cleanup point in the Stop hook, structurally identical to the `pendingPeerInbound` fallback.

### 5.6 Inbound attachments (gap R5)

Sending a screenshot or a file to an agent is a frequent operation, so it ships in v1: `POST /api/v1/agents/:name/messages` accepts `multipart/form-data` (a `text` field + `files`, ≤ 5 files, ≤ 10MB each), lands them in the existing inbox directory, and then rides the Envelope's `meta.attachments` — the same path as Discord attachments.

### 5.7 How the web prototype uses this (proving the interface is sufficient)

```
init      GET /api/v1/agents            → sidebar agent list
select    GET /api/v1/events?agent=x    → attach SSE, render the tool stream + 💬 live
send      POST /api/v1/agents/x/messages {text, wait:120} → render the reply + buttons
click     POST {text: "[button:approve_xxx]"}
history   not done — the prototype is live-only; history replay is future work (D5, the authoritative data is in the jsonl)
```

The web page itself = a static page (it can simply be returned from the bridge's `GET /`, or deployed separately); it has **no backend of its own**.

## 6. Phase C — the outbound abstraction and absorbing Discord

### C1 (a small step, done first): deliverToUser dispatches by transport

```ts
async function deliverToUser(env, to) {
  const { transport } = parseChatId(to.channelId);
  const adapter = adapters.get(transport);      // currently only discord
  return adapter.send(...)
}
```

An `adapters` registry plus Discord's send/edit/typing wrapped as the first `ChatAdapter` (internally still today's `discordReply`, just moved into a shell). **After C1, plugging in Telegram is purely additive**: implement a ChatAdapter, add an identity to `principals.json`, configure the agent binding — zero changes to the core.

### C2 (owner scheduled it early on 2026-07-09; the first batch is done): full absorption

The original plan was incremental (D8), but after reviewing the "real leftovers" list the owner asked for it to be scheduled and cleaned up. The first five items have landed:
- **C2-1** master identity checks centralized (`isMasterChannel` / `isMasterWs` / `agentLabelForChannel`)
- **C2-2** `fetch_messages`/`react`/`edit_message` now raise a clear error for non-Discord conversations (they used to fail silently)
- **C2-3** Discord user authentication goes uniformly through `principals.json` (`.env` `ALLOWED_USER_IDS` is idempotently seeded at startup into `discord:<uid>` with `role:owner`, with the fallback retained; adding or disabling a user is just a `principals` edit)
- **C2-4** typing lifecycle / 💭 status message bookkeeping / uma completion quips / action buttons all moved into `bridge/discord-adapter.ts`, leaving only thin wrappers in `bridge.ts`
- **C2-5** ChatAdapter gained `provisionConversation`: channel creation during `create` goes through the adapter interface (the ws protocol names are unchanged), so an API-only agent is just one provisioner away

The Discord logic still living in `bridge.ts` (inbound `messageCreate`, slash commands, management button interactions) continues on a "move it when you're already in there" basis. One known unsolvable case: the tmux modal for AUQ/permission confirmation can only be answered by the owner.

### Telegram adapter blueprint (future, out of scope here; written to prove the interface suffices)

- Library: grammY (Bun-compatible), long-polling (no public callback URL needed);
- `caps: { maxTextLen: 4096, buttons: true(inline keyboard), edit: true, files: true, typing: true }`;
- The inline keyboard's `callback_data` = our button id; a click sends back `[button:<id>]`;
- Agent binding: the registry's agent entry gains an optional `bindings: ["telegram:<chatId>"]`; an inbound message that matches a binding → normal `deliver`; the agent's tool stream is rendered by the tg-adapter itself from its event-bus subscription (with its own throttling granularity, not reusing the Discord watcher);
- Identity: `telegram:<userId>` goes into `principals.json`, with the same role/agents whitelist scheme.

## 7. Decision record

- **D1 mirror on the side, don't split the watcher**: zero regressions; and since each frontend subscribes to the bus and renders it itself, Discord's rendering pipeline was never meant to be reused.
- **D2→D7 prefixed chat_id, one unified keyspace**: pending/thread/registry/agent all need zero changes; a bare id = discord, supported forever.
- **D3 don't change the registry's primary key**: an agent's primary conversation is still its Discord channel (Discord is the primary transport). An internal id will be introduced when a real need such as "an agent with no Discord channel" shows up.
- **D4 leave peer collaboration alone**: the trust model of `#agent-exchange` is Discord channel membership, which is a feature, not coupling.
  - **Update (v2.11)**: this item is void — the Discord peer mechanism (including `#agent-exchange`) has been removed entirely, and cross-instance collaboration now uses HTTP peers built on this API (mutually issued scoped tokens); see `docs/design-http-peers.md`.
- **D5 no persistent event storage**: live goes over the bus, history reads the jsonl (the pure library already exists). History replay in the web version is future work.
- **D6 the management surface stays out of the API (v1)**: but the principals authorization model carries a `role` field now, reserving room for a future management API.
- **D7 path versioning `/api/v1/`** plus **three additive-only schemas** (NeutralMessage / NeutralComponent / BridgeEvent): this is our compatibility promise to frontend authors.
- **D8 C2 absorption is not a scheduled project**: migrate gradually alongside day-to-day changes, avoiding a big bang.

## 8. Out-of-band interactions and known limitations (gaps R4 / R6)

**AskUserQuestion / auto-deny / permission confirmation (R4)**: these interactions really live in a TUI modal inside tmux, and only the owner can perform the selection. When an API/Telegram user triggers one:
- The existing watcher mechanism **is a natural fallback** — the AUQ menu and the auto-deny approval buttons still pop up in that agent's Discord channel, and the owner handles them on the user's behalf;
- The `question` / `auto_deny` events in the event stream let non-Discord frontends **see** the blockage (a web page can render a "waiting for owner confirmation" placeholder), but v1 offers no non-Discord answering channel;
- An API `wait` request will therefore run until it times out (202 + threadId, poll afterwards). The docs explain this semantic to token users. Turning the answering channel into an API is future work (it depends on the management API, D6).

**Concurrent conversations against the same agent**: when a Discord user and an API user talk at the same time, the messages queue into the same session in arrival order (master has long been attached to both `#control` and `#agent-exchange`; the mechanism is mature). The side effect is that the contexts see each other — which is another reason R1 demands a dedicated agent. We do not implement session isolation (that would amount to one agent per token, which `create` already gives you).

**Bridge restart semantics (R6, known limitation)**: both the event-bus ring buffer and the API waiters are in process memory — after a bridge restart the SSE connection drops (the client should auto-reconnect, and a `since` replay will have lost the pre-restart seq values) and in-flight `wait` requests have their connection cut. This matches the Discord frontend's experience across a bridge restart, and we do not compensate with persistence (D5). Documenting it is enough.

## 9. Testing and acceptance

- Unit tests: event-bus (emit/subscribe/replay/ring eviction), `parseChatId`, principals (scope/role/rate-limit pure logic), NeutralMessage degraded rendering (buttons → numbered text).
- Extend `router.test.ts`: `ApiUserEndpoint`, `resolveReplyTarget("api:...")`, prefix compatibility (bare id = discord).
- Live (per the sandbox convention):
  - `curl -N /events` while an agent runs a round of tools: events complete, seq contiguous, replay-after-disconnect correct;
  - The full token chain: POST→reply (both the `wait` path and the SSE path); out-of-scope 403; 401 after revocation;
  - Discord regression: tool stream, 💬, drain, buttons, peer routing, and the management surface all behave unchanged.

## 10. Effort and release

| Phase | Contents | Estimate | Risk |
|------|------|------|------|
| A | event-bus + instrumentation + SSE + tightened bind | ~400 lines | Low (pure side channel) |
| B | principals/token + five `/api/v1` endpoints + deliverToApi + CLI | ~700 lines | Medium (adds a branch to the reply path) |
| C1 | parseChatId + adapters registry + Discord send wrapper | ~150 lines | Low |
| C2 | Full Discord absorption | Incremental, not counted | — |

- Release: A could ship on its own; A+B+C1 are merged into a single **minor** (headline: "Claudestra now has an open HTTP API and a live event stream — web clients, Telegram, any frontend can plug in"). Follow the batching rule.
- The Telegram adapter and the web client itself are **out of scope here**; they get their own projects once the interfaces have landed.

## 11. Implementation notes (2026-07-09, deviations from the design)

- **The owner's Discord principal was not migrated into `principals.json`** (§3.4 planned migration + `.env` fallback): authentication on the main Discord path still goes through `ALLOWED_USER_IDS`, and `principals.json` currently only manages tokens. Rationale: not touching the main Discord path = zero regressions; unifying identity can happen together with the management API (future).
- **Rate limiting is implemented as "count after successful authentication"**: an invalid secret does not consume the rate-limit window (a 64-hex random secret has no practical brute-force surface).
- **A POST registers a `pendingApiRequest` whether or not it waits**: `deliverToApi` relies on it to correlate the reply back to the original request's `threadId` (the reply handler mints a new `threadId` for every reply, so it can't be used directly).
- **A turn triggered via the API does not send a Stop completion notification** (`lastMessageSource=agent`): the reply already goes back through the API path and is visible via the R2 mirror, so @-ing the owner is just noise (found and fixed during live verification).
- Live verification passed on every item: the full token chain (200 wait / 202 / 401 / 403 / revoke), R2 bidirectional mirroring, R3 `viaFallback` (an agent that silently ends its turn returns instantly), R5 multipart (the agent can read the uploaded file), SSE scope filtering and replay after disconnect, and the Discord regression (watcher stream / completion notification / buttons). Testing used a throwaway agent (`test-api`), destroyed after verification.

## 12. Adapting to Claude Code agents mode (added 2026-07-09, scheduled by the owner)

CC 2.1.x's bg-agent system (a daemon, respawn-on-kill, the ← key opening the agents view in every TUI) conflicts with Claudestra's tmux-foreground model: a mis-pressed ← can fork a foreground session into a bg doppelganger, turn the window into a read-only attach view, and silently break the Discord/MCP link (three chained incidents that day; see mem0). Upstream provides no way to disable it (keybindings don't cover the agents view and there is no relevant settings key).

The adaptation follows this design's transport-decoupling principle — management visibility is also a neutral service rendered on multiple frontends:

- **SessionsInventory** (`bridge/sessions-inventory.ts`): reconciles three sources — `claude agents --json` (the official scriptable interface) + `~/.claude/jobs/*/state.json` + the registry — into a neutral `NeutralSessionInfo[]`; a doppelganger is determined as an unregistered bg session sharing a name or cwd with an official agent. The reconciliation logic is pure and independently testable (`tests/sessions-inventory.test.ts`).
- **Three consumers share it**: the Discord `/agents` panel (`management.ts`, LLM-free buttons: detail / adopt / cleanup), `GET /api/v1/sessions` (scope-filtered: a restricted token only sees sessions and doppelgangers of agents within its scope), and `POST /api/v1/sessions/:id/cleanup|adopt` (full-scope token, 202 + a `session_anomaly` SSE event reporting the result).
- **Self-healing**: `startClaudeInWindow` recognizes the "currently running as a background agent" error → `cmdRestart` automatically retries with `--fork-session` → diffs the projects directory before and after startup to detect the newly forked session id → writes it back to the registry (the bridge's session tracking used to be unreliable across forks, and the registry drifted twice during the incident). `adopt <name> <sessionId>` = edit the registry + run a restart (reusing the whole self-heal chain); `resume --fork` adopts a wild session.
- **The three guards**: permission-watcher polls every 8s for the visual signature of the agents dispatch UI → auto-Esc + a channel notification; wedge-watcher's link sentinel (window alive + channel-server offline >5min → repair button, checked even when idle — idle plus offline means the user's messages can't get in); session-reconciler reconciles every 10 min → alerts on a new doppelganger with [cleanup][adopt] buttons + a `session_anomaly` event.
- **The cleanup recipe** (`lib/bg-jobs.ts`, proven during the incident): kill the bg processes → wait for the daemon to go quiet (`state.json` mtime stable + no processes) → `mv` the job directory into quarantine (don't delete it, so it can be rolled back) → detect respawns and retry. Two critical traps: the `pgrep` match must exclude the `--fork-session` originator (a fork referencer's command line contains the source session id, so a naive kill takes out the official agent); and a job referenced by an attach/fork gets respawned by the daemon forever → the stubborn-case detection stops playing whack-a-mole and defers to manual deletion in the official TUI.
- Live verification: inventory reconciliation (12 foreground sessions + 1 doppelganger detected precisely), `/agents` panel rendering, the reconciler's first-round alert, the sessions API (200/401/scope), and the `cleanupBgJob` stubborn path (`d170ecbc` was referenced by a foreground fork; it correctly refused to kill the originator and printed guidance).
