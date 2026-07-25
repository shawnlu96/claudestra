# Claudestra Web Frontend Integration Guide

> **English** · [简体中文](./web-frontend-guide.md)

> Written for whoever picks up the Web UI. Goal: get a web console running without reading the entire codebase.
> If you have questions, ask the owner to invite you to his Claudestra Discord server and ask directly in the `#agent-claudestra` channel (that channel is a resident Claude development agent — it wrote this document and knows the bridge-side code inside out).

## 0. Background in one sentence

Claudestra is a multi-session Claude Code orchestrator: one Bridge process manages N Claude Code sessions running inside tmux, and today the only frontend is Discord. Since v2.6 the core has been decoupled from Discord, and v2.8–v2.9 laid down the entire data plane (live event stream, conversation history, usage stats) — **the Web UI is where all that groundwork pays off**. You don't need to touch any tmux / Discord / MCP details; you only talk to the Bridge's HTTP API.

## 1. Required reading (in order, about 1 hour)

1. **`CLAUDE.md`** (repo root, English; `CLAUDE.zh-CN.md` is the Chinese version) — architecture overview. Focus on: System overview, and the three Features sections "Multi-frontend API", "Background-activity threads", "Read-only history API".
2. **`docs/design-multi-frontend.md`** — the design decisions behind the multi-frontend architecture (why SSE + a read-only history API instead of a database; the frozen NeutralMessage contract). [English version](./design-multi-frontend.en.md)
3. **GitHub Release notes**: [v2.7.0](https://github.com/shawnlu96/claudestra/releases/tag/v2.7.0) (first release of the multi-frontend API + agents-mode adaptation), [v2.9.0](https://github.com/shawnlu96/claudestra/releases/tag/v2.9.0) (history API + archiving), v2.9.1 (fix batch).
4. **git log** — when you want the backstory of a particular endpoint: `git log --oneline --grep="api\|history\|event" -20`; the commit messages spell out the motivation for each change (in Chinese).
5. Authoritative definitions in the code (read these three files directly when you need the data structures — they're all commented):
   - `src/bridge/event-bus.ts` — SSE event types and fields
   - `src/lib/session-history.ts` — history message structure and pagination semantics
   - `src/lib/agent-stats.ts` — usage/context statistics structures

## 2. Architecture in 30 seconds

```
Browser (what you're building)
   │  HTTP / SSE
   ▼
Bridge  (bun, 127.0.0.1:3847 by default)     ← your only backend
   │
   ├─ N Claude Code sessions inside tmux (each one = an "agent")
   ├─ ~/.claude/projects/**.jsonl       ← the authoritative source of conversations (written by Claude Code itself)
   └─ ~/.claude-orchestrator/archive/   ← archived snapshots of retired sessions (maintained by the bridge)
```

Storage design (owner's call — don't propose adding a database): **conversation content never goes into a database**; the jsonl files written by Claude Code are the authoritative source. Live data goes over SSE, history goes through a read-only API that parses those files on the fly.

## 3. Auth model

- Every `/api/v1/*` endpoint uses a Bearer token: `Authorization: Bearer <secret>`.
- Tokens are issued from the CLI (there is no management UI yet):
  ```bash
  bun src/manager.ts token-add web-ui --agents '*'        # all non-master agents
  bun src/manager.ts token-add limited --agents alpha,bravo
  bun src/manager.ts token-list / token-revoke <name>
  ```
- **Scope**: a token carries a per-agent whitelist, `*` = all. Any agent outside the scope gets a 403. Agent names are matched both ways (`worker` and `agent-worker` are equivalent).
- Rate limit: 120 req/min per token (a 60s sliding window, hardcoded with no env switch; a long-lived SSE connection only counts once, when it is established).
- **Mirror**: a message sent to an agent through the API is by default mirrored into that agent's Discord channel (for auditing). `token-add --no-mirror` turns it off.
- The top-level `/stats` and `/events` (without the `/api/v1` prefix) are the **unauthenticated local-machine versions** — the bridge only binds `127.0.0.1` by default and trusts the local machine. See §7 for deployment shapes.

## 4. API overview

Base URL: `http://127.0.0.1:3847` (changeable via `BRIDGE_PORT`).

### 4.1 Reads

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /stats` | none (local) | Global snapshot: account 5h/week gauges + per-agent context/today/this-week usage |
| `GET /api/v1/agents` | Bearer | List of agents within scope (name/status/idle/purpose) |
| `GET /api/v1/agents/:name/history` | Bearer | That agent's session list (live + archive merged) |
| `GET /api/v1/agents/:name/history/:sessionId` | Bearer | Paginated conversation messages (see §6) |
| `GET /api/v1/sessions` | Bearer | Machine-wide Claude session list (includes doppelganger detection, `kind: interactive/background`) |
| `GET /api/v1/threads/:threadId` | Bearer | Fallback endpoint for polling a reply after sending a message |
| `GET /api/v1/files/:id` | Bearer | Download an attachment from an agent's reply (ownership checked against the token) |

### 4.2 Writes

| Endpoint | Notes |
|---|---|
| `POST /api/v1/agents/:name/messages` | Send a message to an agent. JSON `{text, wait}` (wait ≤ 300s waits synchronously for a reply) or multipart (`text` + `files`, ≤ 5 files, ≤ 10MB each). Agent offline → 409; not waiting or timed out → 202 + `threadId`, poll via the threads endpoint |
| `POST /api/v1/sessions/:id/cleanup` | Clean up a bg doppelganger (202, runs in the background, result arrives via the SSE `session_anomaly` event). Full-scope token only |
| `POST /api/v1/sessions/:id/adopt` | Promote a doppelganger to the official session. Full-scope token only |

### 4.3 Live (SSE)

| Endpoint | Auth | Difference |
|---|---|---|
| `GET /events` | none (local) | All events |
| `GET /api/v1/events` | Bearer | Agents filtered by token scope |

- Standard SSE: `id:` = a monotonically increasing seq; reconnecting with `Last-Event-ID` replays missed events (in-process ring buffer — after a bridge restart the seq resets to zero and the buffer is empty, so the frontend must tolerate the seq going backwards).
- Event JSON: `{seq, ts, agent, chatId, type, data}`.
- The full set of `type` values (authoritative definition in `src/bridge/event-bus.ts`):
  - `tool_start` / `tool_done` — tool calls (`data` contains the pre-rendered summary text)
  - `assistant_text` — text streamed out by the agent
  - `turn_duration` — how long one conversational turn took
  - `agent_status` — status changes (thinking/done, etc.; use it for a "typing" indicator)
  - `question` / `auto_deny` / `chat_message` — permission dialogs, automatic denials, chat messages
  - `session_anomaly` — a doppelganger appeared / the link dropped / the result of a cleanup or adoption
  - `bg_task_started` / `bg_task_update` / `bg_task_completed` — background-activity (subagent / bg shell) lifecycle, `data`: `{kind: "subagent"|"shell", id, threadId, title?, lines?, durationMs?}`. `id` is a stable identifier (subagent id / shell taskId); use it as the key for a task row in the frontend

**EventSource authentication (solved in v2.10+)**: the browser's native `EventSource` cannot send an Authorization header — use the query-parameter form `GET /api/v1/events?token=<secret>` instead (every `/api/v1` endpoint accepts `?token=`, with the header taking precedence; non-SSE calls should still prefer the header).

## 5. Key points of the /stats data structure

```jsonc
{
  "global": {
    "sessionPct": 41, "sessionResets": "5pm (Asia/Tokyo)",   // account 5h window
    "weekPct": 22,    "weekResets": "Jul 15 at 6am (...)",   // weekly window
    "scrapedAt": 1783660000000,   // when the gauge was scraped — show its age when rendering, don't let users think it's real-time
    "raw": "...(verbatim text of the /status panel)..."
  },
  "agents": [{
    "name": "agent-x", "contextTokens": 239000, "contextEstimated": false,
    "model": "claude-fable-5",
    "today": {"tokens": 85000000, "requests": 12}, "week": {...}
  }]
}
```

- `contextEstimated: true` = this agent just finished a compact and hasn't had a new turn yet, so the context number is an estimate (render it as `~239K (just compacted)`).
- `sessionResets` is verbatim text from the upstream `/status` panel, and **we have observed upstream printing 5pm as 5am**. The constraint for spotting a suspicious value: a 5h window's reset must fall within `scrapedAt + 5h`. What the Discord dashboard does is display it as-is and add a ⚠️ when the constraint is violated (do not try to be clever and correct it — see commit `7c45f38` for that lesson).

## 6. History API in detail (the main data source for the conversation view)

```
GET /api/v1/agents/:name/history
→ { ok, agent, sessions: [{ sessionId, source: "live"|"archive",
     sizeBytes, mtime, createdAt, subagents: ["agent-xxx", ...] }] }

GET /api/v1/agents/:name/history/:sessionId?limit=100&before=<seq>&subagent=agent-xxx
→ { ok, agent, sessionId, source, messages: [...], total, hasMore }
```

- **Pagination semantics** (the usual chat-view convention): by default it returns the last `limit` messages; to page upwards pass `before=<seq of the first message on the current page>`; `hasMore` says whether anything exists before this page. `seq` is the line number within the file and is stable within a session.
- Message structure: `{seq, ts, role: "user"|"assistant"|"system", text, tools?: [{name, summary}], compactSummary?, model?}`.
  - `role: "system"` is currently only the compact separator ("context was compacted") — render it as a divider on the timeline.
  - `compactSummary: true` = a long summary generated by compaction, not real user input — collapse it by default.
  - `tools[].summary` is a pre-rendered one-line summary (e.g. `Read src/foo.ts`); display it directly.
- A session with `source: "archive"` belongs to a retired/killed session — **it is still readable, which is exactly the point of archiving**. When a live session and an archive share the same id, whichever has more content is returned.
- Pass an id from the `subagents` array as `?subagent=` to read that subagent's full conversation (same format as the main session).
- Stitching live and history together: when entering the conversation view, first fetch the last page of history, then subscribe to SSE for the increments (`assistant_text` / `tool_*` / `chat_message`, filtered by the `agent` field). The two sides have no shared message id — the simple approach is to treat history as authoritative and use SSE only as an "activity indicator", or de-duplicate by `ts`.

## 7. Deployment switches and known boundaries

The original "three walls" (CORS / EventSource auth / static hosting) have all been torn down as of v2.10; each is an environment-variable switch, off by default:

1. **CORS** — set `BRIDGE_CORS_ORIGIN` to a comma-separated origin whitelist (e.g. `http://localhost:5173`) or `*`; unset = no CORS headers are sent. During development just point it at your dev server's origin to connect cross-origin.
2. **EventSource auth** — the `?token=` query parameter (see §4.3).
3. **Static hosting** — point `BRIDGE_STATIC_DIR` at your frontend build output and the bridge serves it directly (a missing extensionless path falls back to `index.html`, so SPA routing works; missing asset files still 404 normally). Same-origin deployment = neither CORS nor the token query parameter is needed anymore.

Boundaries that still exist:

4. **No UI for token management** — issuing/revoking is CLI-only.
5. **`BRIDGE_BIND` defaults to 127.0.0.1** — to reach it from another device, set `BRIDGE_BIND=0.0.0.0` and bring your own reverse proxy + TLS + authentication (the unauthenticated top-level endpoints get exposed along with everything else, so only open this up behind a reverse proxy).
6. SSE does not persist across restarts — `Last-Event-ID` is only valid for the lifetime of the bridge process; after a bridge restart the seq resets to zero and the frontend must tolerate that.

## 8. Suggested MVP scope (a direction the owner has already approved)

1. **Agent list page** — `/api/v1/agents` + `/stats` combined: name, status, idle, a context-usage bar, today's usage.
2. **Conversation view** — paginated history (§6) + live SSE stream + a message box at the bottom (the `messages` endpoint with `wait=60` to wait synchronously for a reply).
3. **Background task progress lines** — aggregate `bg_task_*` events by `id` and render an activity row per subagent / bg shell (start / rolling updates / completion + duration).
4. **Usage panel** — a web version of `/stats` (see how the Discord dashboard presents it: `renderEmbed` in `src/bridge/stats-dashboard.ts`).

Pick whatever tech stack you like (the bridge doesn't care). The simplest deployment path: point `BRIDGE_STATIC_DIR` at the build output and let the bridge serve it same-origin (no reverse proxy, no CORS); during development set something like `BRIDGE_CORS_ORIGIN=http://localhost:5173` to connect cross-origin to a live bridge.

## 9. Local development environment (running a full stack yourself)

Prerequisites:

| Dependency | Notes |
|---|---|
| macOS / Linux | tmux is required, so Windows needs WSL |
| bun, tmux, launchd | The runtime trio (process supervision uses launchd, not pm2) |
| Claude Code CLI | **Log in with your own Claude subscription account** — local agents' conversations burn your own quota, so watch your usage while testing (visible in `/stats`) |
| Your own Discord bot + a private test server | **A hard prerequisite, unavoidable**: `manager create` creates the agent's Discord channel through the bot. Creating a bot and adding it to your own test server takes about 5 minutes; [SETUP.md](../SETUP.md) has a step-by-step walkthrough with screenshots |

```bash
git clone https://github.com/shawnlu96/claudestra && cd claudestra
bun install
bun run setup        # interactive wizard: bot token / guild id / your Discord user id
bun src/manager.ts install-cli   # writes and loads the three launchd daemons: bridge / launcher / cron

# Generate test data: create 1-2 agents (any directory will do), chat a bit and you'll have history/events
bun src/manager.ts create web-test ~/tmp/web-test "for web UI testing"
bun src/manager.ts token-add web-dev --agents '*'
```

Note: the bridge's HTTP server starts without waiting for the Discord connection (`/stats` and the history API are available immediately), but the bot token must be valid — the whole agent lifecycle depends on it.

Smoke test (against a live bridge):

```bash
TOKEN=<secret>
curl -s localhost:3847/stats | jq .global
curl -s -H "Authorization: Bearer $TOKEN" localhost:3847/api/v1/agents | jq
curl -s -H "Authorization: Bearer $TOKEN" "localhost:3847/api/v1/agents/<name>/history" | jq
curl -N localhost:3847/events                     # raw SSE stream
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"ping","wait":60}' localhost:3847/api/v1/agents/<name>/messages | jq
```

## 10. Collaboration conventions

- **Don't make bridge-side changes yourself** (new endpoints, CORS, query tokens, static hosting) — describe what you need in the `#agent-claudestra` channel of the owner's Discord server; the resident agent implements it bridge-side and ships a release (which you pull locally via upstream `bun src/manager.ts update`), usually the same day.
- The API's **frozen contract**: response fields of existing `/api/v1` endpoints are additive-only — never changed, never removed. If a field's meaning is unclear, ask first, don't guess.
- The frontend should live in its own repository (the bridge does not need to share a repo with it; if the bridge later hosts the static files, we'll agree on the build output path then).
