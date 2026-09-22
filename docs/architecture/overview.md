# System overview (full)

> Moved verbatim out of `CLAUDE.md` on 2026-09-23 so the file every session loads stays small (it is size-ratcheted by `scripts/guard`). Version tags and incident notes below are history; the code is the source of truth.

## System overview

Claudestra is a multi-session orchestrator built on top of Claude Code's native **Channel protocol** (an MCP extension). A single Bridge process fans out one Discord bot token across many Claude Code sessions by registering each one as an independent channel listener.

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

**Message flow (all via `deliver(envelope)` since v2.0.0):**

- **Inbound** — Discord → Bridge's `messageCreate` handler → builds `Envelope{from, to, intent, content, meta}` → `deliver()` → `deliverToLocal` → ws.send to the right Claude Code session.
- **Outbound reply** — Claude Code calls `reply` MCP tool → channel-server → Bridge's `reply` handler → builds response envelope → `deliver()` → `deliverToUser` / `deliverToApi` → `discordReply` (chunking / reply_to / files / components) or HTTP-waiter resolution.
- **Agent↔agent** — `send_to_agent` MCP tool → `route_to_agent` handler → builds local→local envelope → `deliver()` → receiver sees `[🤖 来自 X]` prefix (auto-rendered by `renderContentForLocal`).
- **Streaming tool calls** — Claude Code writes JSONL → `jsonl-watcher` tails + pushes tool summaries (`📖 Read ...`) and assistant text (`💬 ...`) to Discord with 1.5s debounce. On Stop hook, watcher is **drained synchronously** (`drainChannelWatcher`) before marking the status "✅ 完成", so quick one-liners don't get lost between debounce windows.

**Envelope / Endpoint model (`src/bridge/router.ts`):**

Every message is described as `{ from: Endpoint, to: Endpoint, intent, content, meta }`. `Endpoint` is a discriminated union:

- `LocalEndpoint{ kind: "local", channelId, ws, agentName?, cwd? }` — one of our Claude Code sessions
- `UserEndpoint{ kind: "user", userId, channelId, username? }` — Discord human
- `ApiUserEndpoint{ kind: "api", tokenId, name, peer? }` — HTTP API user (v2.6.0+; `peer` marks an HTTP peer instance, v2.11+)

`intent` is `"request" | "response" | "notification" | "broadcast"`. Request envelopes hang a `PendingReply` + `PendingThread` keyed by the reply-back channel / thread id; response envelopes auto-clear those pendings via `inReplyTo` / `threadId` matching. Stop hooks use thread bookkeeping to close residual pendings and log which `thr_*` just ended.

Each Claude Code session has its own `channel-server` subprocess running as a stdio MCP server. The channel-server speaks MCP to Claude Code on one side and a lightweight WebSocket protocol to the Bridge on the other.
