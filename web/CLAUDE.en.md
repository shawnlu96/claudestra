# Claudestra Web Client

**English** · [简体中文](./CLAUDE.md)

Claudestra's Next.js web front door (the second entry point beside Discord). PWA-installable, self-hosted VAPID Web Push (zero third-party accounts), multi-session streaming chat.

**Since 2026-07-10 the whole data plane runs on the multi-frontend API** (`docs/web-frontend-guide.md` +
`docs/design-multi-frontend.md`): the BFF consumes the Bridge's `/api/v1/*` (Bearer token) and
`/api/v1/events` (SSE); the early `/web/*` gateway and web-hub have been deleted. The handful of
web-only endpoints (interrupt / AUQ answer-back / lifecycle / Web-only mode) are all additive
extensions on top of that same API.

## Stack & ports

- Next.js 16 + React 19 + TypeScript + Tailwind 4 + daisyUI; state management via zenith (`@do-md/zenith`, vendored into `.packages/`).
- Ports: **dev 33333 / production 3333** (staying clear of claude-os's 22222/2222).
- The runtime is plain Node/npm (`npm run dev`), **independent of the Bun backend at the repo root** (bridge/manager and friends). The two dependency trees never interfere.

## Directory layout

```
app/
  page.tsx              → redirect /chat
  chat/page.tsx         chat page (<Chat/>)
  login/page.tsx        SSH account login
  api/
    auth/{login,logout,me}/  auth (public, self-handled)
    agents/             GET list (proxies /api/v1/agents?include=stopped, master pinned on top);
                        POST create (proxies /api/v1/agents, project-specific endpoint)
    agents/kill/        POST (proxies /api/v1/agents/:name/kill, project-specific endpoint)
    agents/restart/     POST (proxies /api/v1/agents/:name/restart, project-specific endpoint)
    chat/send/          POST (proxies /api/v1/agents/:name/messages, wait=0)
    chat/stream/        GET SSE (subscribes /api/v1/events → filter by agent → translate to WebStreamEvent)
    chat/history/       GET ?agent= (proxies /api/v1/agents/:name/history[/:sid], live+archive)
    chat/clear/         POST (proxies /api/v1/agents/:name/clear, project-specific endpoint)
    chat/interrupt/     POST (proxies /api/v1/agents/:name/interrupt, project-specific endpoint)
    agents/settings/    GET/PUT per-agent frontend config (init_message boot instruction, web SQLite)
    peers/              GET list / POST {action} dispatch (proxies /api/v1/peers*, BFF for the peer admin UI)
    chat/permission/    POST (proxies /api/v1/agents/:name/answer kind=permission)
    chat/auq/           POST (proxies /api/v1/agents/:name/answer kind=auq)
    terminal/stream/    GET SSE, pure passthrough (proxies /api/v1/agents/:name/terminal?cols=&rows=,
                        project-specific endpoint; browser disconnects → upstream abort → Bridge
                        destroys the PTY + viewer session)
    terminal/input/     POST {id,d:base64} (proxies /api/v1/terminal/:id/input, per-keystroke /
                        micro-batched, the Bridge does not rate-limit)
    terminal/resize/    POST {id,cols,rows} (proxies /api/v1/terminal/:id/resize)
features/terminal/      remote terminal (🖥️ button in the session detail → live tmux mirror, writable)
  terminal-button.tsx   TopBar entry (present for active sessions + master; hidden when stopped).
                        Form splits by width: narrow (<sm) → #terminal hash pseudo-route full-screen
                        page (swipe-left / back key exits, same nav stack as #chat); wide → large
                        modal. ⚠ Never use a modal on mobile — the soft keyboard and daisyUI's
                        centred modal are structurally incompatible (collapse / backdrop bleed-through
                        / the page behind stays scrollable; confirmed over two rounds of real-device
                        testing)
  terminal-page.tsx     mobile full-screen page (createPortal + fixed inset-0 with an opaque
                        background; while the soft keyboard is up, the content layer is pinned to
                        visualViewport (top=offsetTop, h=height) and --term-safe-bottom is zeroed)
  terminal-modal.tsx    desktop modal (no keyboard logic)
  terminal-view.tsx     @xterm/xterm v6 + fit + webgl (best-effort); SSE downstream base64 frames →
                        term.write; onData 8ms micro-batching + a serialized chain → input POST
                        (byte order preserved); ResizeObserver debounced 150ms → resize POST.
                        50ms connect delay (dev's double-effect cancel-propagation race, see prin-645ac3).
                        ?noWebgl=1 forces the DOM renderer (for automated checks in a background tab —
                        WebGL does not paint while hidden); window.__claudestraTerm debug handle
                        (read the buffer to verify the data plane)
  control-bar.tsx       control-key bar (Esc/Tab/⇧Tab/arrows/⏎/^C/^O + ⌨️ focus to raise the soft
                        keyboard; onPointerDown preventDefault so focus isn't stolen and the keyboard
                        doesn't collapse)
                        ⚠ Scrolling semantics: the CC TUI runs on the alternate screen (no terminal
                        scrollback, and the tmux pane history is empty too) — use ^O to read
                        transcript history (CC transcript mode, scrollable); the viewer session has
                        tmux mouse enabled (so wheel-into-copy-mode works in shell scenarios)
features/chat/
  type.ts               ChatMessage / AgentSession / ToolCallView / PendingPermission / PendingAsk
  stream.ts             consumeSSEStream + processStreamEvent + StreamSink (protocol v1, untouched by
                        the migration)
  chat-store.ts         zenith hub (agents/messages/streaming + pendingPermission/pendingAsk;
                        openGen gates history loading, streamGen gates the stream;
                        createAgent/killAgent/restartAgent;
                        interrupt/resolvePermission/submitAsk/cancelAsk)
  components/           sidebar / new-agent-modal / message-list (permission-card + ask-question-card)
                        / composer (shows 「停止」 while streaming) / chat(Provider)
lib/
  db/                   getDb + auth migration (data root ~/.claude-orchestrator/web/db)
  services/auth.service.ts  verifySSH(ssh2) + session CRUD
  api-auth.ts           isAuthed (dual auth: cookie or x-api-key)
  chat/
    bridge-api.ts       /api/v1 client hub: BRIDGE, Bearer header, bridgeGet/bridgePost,
                        apiAgentName (__master__ ↔ master mapping)
    agents.ts           loadAgents (GET /api/v1/agents?include=stopped → AgentSession[])
    events.ts           WebStreamEvent frontend protocol v1 (tool/text/status/done/permission/ask…)
proxy.ts                Next16 proxy: intercepts page cookies only; API routes guard themselves
```

## Auth model (reuses claude-os SSH/PAM + Bearer)

- Login: `verifySSH` opens a local SSH connection to verify the username/password → writes a SQLite session → HttpOnly cookie `cstra_session` (7 days).
- Dual auth `isAuthed()`: a browser cookie session, or `x-api-key === INTERNAL_API_KEY` for external scripts.
- **Layering**: `proxy.ts` only intercepts *pages* (no cookie → /login); API routes each call `isAuthed()` inside their own handler (per prin-475132; and the proxy runs on the edge runtime, where `.env.local` is unreadable).
- The cookie is named `cstra_session` (not claude-os's `cos_session`) — on localhost, cookies are isolated by host, not by port, so the name has to avoid collisions.
- **BFF → Bridge auth**: `CLAUDESTRA_API_TOKEN` (`.env.local`). Issue it with:
  `bun src/manager.ts token-add web-ui --agents '*,master' --force --terminal` (`master` must be listed
  explicitly — `"*"` does not cover it; `--terminal` explicitly grants the remote terminal = host-shell-level
  access, a capability separate from the messaging scope — without it the 🖥️ terminal returns 403 while
  chat / history / interrupt keep working).
  The BFF attaches `Authorization: Bearer` server-side, the browser never talks to 3847 directly, and this
  also sidesteps the fact that EventSource cannot send headers (guide §4.3).

## Data flow (/api/v1 + /events)

A conversation = one claudestra agent. Every time the frontend opens an agent it first pulls history
(`GET /api/chat/history`), then opens one persistent SSE stream (`GET /api/chat/stream`); `send` is
fire-and-forget (wait=0) and the output comes back over the stream.

- **List**: `loadAgents` → Bridge `GET /api/v1/agents?include=stopped`. The Bridge injects master
  (the token scope must list master explicitly); the frontend maps it to `__master__` and pins it to the
  top (👑 大总管, with no kill/restart shown); stopped agents keep their entry (their history remains
  readable through the archive API — that is exactly what session archiving is for).
- **Send**: `POST /api/v1/agents/:name/messages {text, wait:0}` → 202. Offline agent → 409.
- **Streaming**: the BFF subscribes to `GET /api/v1/events` (fetch-based SSE, with Bearer), filters by
  `agent ∈ {name, agent-name}`, and translates BridgeEvent into the frontend's WebStreamEvent (protocol v1
  unchanged): `agent_status(thinking/done)→status/done`, `tool_start→tool(running)` (tool_done does not
  push a duplicate card), `assistant_text→text`, `chat_message(out)→text` (the final reply from `reply()`),
  `question→ask`, `question_cleared→ask-cleared` (project-specific event), `auto_deny→text(🚫)`. Once the
  stream is connected it back-fills `GET /api/v1/agents/:name/pending` to replay pending AUQ cards
  (the counterpart of the old web-hub's pendingInteraction).
- **History**: `GET /api/v1/agents/:name/history` fetches the session list (mtime descending, live+archive
  merged, still works for killed agents) → the last 300 entries of the newest session → mapped to
  ChatMessage[] (compactSummary skipped; the system compact boundary renders as a light hint).
  **The BFF no longer reads jsonl / registry directly.**
- **Master (大总管)**: special-cased on the Bridge side in `findApiAgent("master")` (project-specific) —
  messages/history/interrupt/answer are all transparently available for master. Master has no
  jsonl-watcher, so in real time you only get `chat_message(out)` from `reply()` plus done;
  history is read from the jsonl, so it does carry tool cards.

## Rich interactions (interrupt / permission card / AskUserQuestion card)

All three follow the same path — "Bridge event downstream → frontend renders a card → BFF posts back to a
project-specific endpoint → tmux keystrokes" — reusing the same keystroke logic as the Discord side
(buildAuqKeystrokes / the permission keySeqMap + a tmuxCapture re-verification before keys are sent):

- **AUQ**: a `question` event (detected by jsonl-watcher, data.questions) → ask card →
  `POST /api/v1/agents/:name/answer {kind:"auq", action, selections[][]}`. Once answered, both sides
  (API / Discord buttons) emit `question_cleared` to dismiss the card; late subscribers back-fill via `/pending`.
- **Interrupt**: while streaming, the composer shows 「■ 停止」 → `POST .../interrupt` → C-c (master → master:0).
- **Clear conversation (🧹)**: sidebar list-item button → confirmation dialog (the 「开机指令」 boot
  instruction is editable and persisted per agent in the settings table) → `POST .../clear` (the Bridge
  fires the native /clear plus a background sessionId rotation / archiving / watcher rebind) → the local
  view resets → if the boot instruction is non-empty it is automatically sent as the first message
  (visible and auditable; knowledge injection hides inside the instruction text, so the product layer
  knows nothing about the graph). Master can be cleared but needs no boot instruction (CLAUDE.md reloads
  automatically). ⚠ CC's native auto-memory survives /clear (native behaviour).
- **Permission card ⚠ known gap**: after the migration the permission prompt has **no downstream event**
  (permission-watcher targets Discord only, and Web-only mode never starts it) — the card will not pop up
  on its own; the upstream `answer {kind:"permission"}` path is retained (the Bridge re-verifies that the
  prompt is on screen before sending keys). Agents default to bypassPermissions, so this card is rare to
  begin with. The session-idle answer path was removed as part of the migration.

## PWA container recipe (invariants converged from real-device debugging — do not change any single piece in isolation)

> The full, general write-up is filed in the owner's knowledge base as `iOS-PWA-standalone-全屏容器与安全区避坑.md`. What follows is how it lands in this project.

On iOS standalone, "fills to the bottom of the screen + never budges + seamless safe areas" is the joint product of the following (converged over six rounds of real-device iteration on 2026-07-10):

0. **[The real culprit, and the best-hidden one] Never pin a fixed height on `html` in globals.css** —
   `html,body{height:100%}` makes iOS standalone clamp `position:fixed` to the *short viewport inset by
   the safe area*, so `bottom:0` of a `fixed inset-0` element **never reaches the actual bottom of the
   screen** (both the list and the bottom of the conversation float a strip above the safe area). What
   makes it confusing: `env()` still reports correct values, and every container level's `height` does
   fill 844 — it is the short viewport itself that stops short. Switch to **`body{min-height:100vh}` with
   no height lock on html** (matching claude-os) and it fills. Same rule for `overflow:hidden` on
   html/body — it clamps the short viewport too.
1. **The app-shell root container `fixed inset-0 overflow-hidden`** (chat.tsx) **is the entirety of the
   scroll lock**: out of flow → body has no in-flow content → the document simply cannot scroll; scrolling
   happens only in the inner `overflow-y-auto`. ⚠ Do not revert to an in-flow `h-dvh` — with 100dvh of
   in-flow content the body gets dragged into micro-scroll / rubber-banding and settles at an offset
   after load. Already disproven.
2. **Safe-area padding is each panel's own job, with its own bg**: TopBar / conversation-list header take
   `env(safe-area-inset-top)`; composer / list footer take the bottom. ⚠ Do not put it on the app-shell
   root — the root is base-100, and laying it over a base-200 list produces colour-mismatched bands at
   top and bottom (claude-os puts pt-safe-top on the root, which is exactly the blemish it never fixed).
3. **At the bottom always use `max(env(safe-area-inset-bottom), <normal spacing>)`, never add them** —
   the home-indicator strip is already tall enough; `env + 12px` stacks into an absurdly tall bottom gap.
4. **The canvas colour follows the current panel**: iOS paints the area outside the layout viewport /
   the safe-area bands with the "canvas colour" (body's bg if body sets one, otherwise html's) → so body
   never sets a bg (layout.tsx), and chat.tsx attaches/removes the `canvas-list` class on `<html>` per
   view (globals.css: list = base-200 / conversation = base-100), keeping the bands the same colour as
   the page they border.
5. After changing viewport/manifest, iOS only picks it up if you **delete the home-screen icon and re-add
   it** (it is cached at install time).
5b. **Modals — and any `position:fixed` overlay — must be `createPortal`ed into body** — on mobile the
   conversation page lives inside a transform-based horizontal-slide container (chat.tsx translate-x),
   and per the CSS spec a transformed ancestor becomes the containing block for `fixed`: a `.modal`
   rendered inside the container ends up positioned a full screen off-view (clicking it "does nothing",
   and it "suddenly appears" when you go back to the list and the container slides back). Desktop has
   translate=0 and cannot reproduce it — this must be verified at a narrow viewport.
6. **How to debug this**: don't eyeball screenshots and guess. Drop in a temporary diagnostic overlay that
   reads `navigator.standalone` / `innerHeight` / the measured `env()` probe values, and draw a line at
   `fixed bottom:0` to see whether it reaches the bottom of the screen — one screenshot localises it.
   Icon regeneration: `node scripts/make-icons.mjs` (sharp; the manifest lives in app/manifest.ts).

## Running & troubleshooting

- **The launchd services that actually run** (`launchctl list | grep claudestra` tells you at a glance —
  don't copy labels from memory: this document long carried `com.claudestra.web-bridge` / `.web-launcher`,
  and those two labels do not exist at all; kickstarting them gets you exit 113):
  - `com.claudestra.bridge` — the backend Bridge (Web-only mode is this same service, just without DISCORD_BOT_TOKEN)
  - `com.claudestra.web` — the Next.js production server (its plist must `exec ./node_modules/.bin/next start`, see the next bullet)
  - `com.claudestra.launcher` / `com.claudestra.cron` — backend daemons, unrelated to web
  - `com.claudestra.tls-proxy` — Caddy doing h2 TLS termination

  After changing backend code → `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge` (wait 15–20s);
  after changing web code → `cd web && npm run build && launchctl kickstart -k gui/$(id -u)/com.claudestra.web`.
- **⚠ The production service `com.claudestra.web`'s plist must `exec ./node_modules/.bin/next start`,
  not `npm run start`**: when kickstart kills the npm intermediary, the child next-server can be orphaned —
  it holds no listening port, but its push dispatcher (outbound SSE + outbound push) is still alive, so
  every push necessarily arrives twice (2026-07-16: one leaked and the user received duplicated pushes
  for 5 days before noticing). Backstop: the dispatcher takes a cross-process port lock (127.0.0.1:3339,
  tunable via `PUSH_LOCK_PORT`), so under any combination of processes only one of them pushes; when
  debugging, `lsof -iTCP:3339` shows who holds the lock.
- Start dev: `npm run dev` (don't start a second one if it's already running; probe with `curl localhost:33333`).
- **⚠ This machine's shell exports `NODE_ENV=production` globally**: force it with `NODE_ENV=development npm run dev`.
- **⚠ A globally exported `INTERNAL_API_KEY` shadows `.env.local`**: start dev with `env -u INTERNAL_API_KEY`.
- **⚠ BRIDGE_HTTP_URL must use `127.0.0.1`, not `localhost`**: the Bridge binds IPv4 only, and localhost's
  `::1` ambiguity makes Node's fetch intermittently hit a 10s connect timeout ("fetch failed").
- **⚠ /events SSE idle disconnects (fixed)**: Bun.serve's default HTTP idleTimeout is ≈10s, and the original
  30s ping never survived to its first round — subscribers with >10s gaps between events were silently cut
  off. This project now sends `: connected` on connect + a 5s ping (bridge.ts handleEventsRequest). When the
  stream "sometimes doesn't arrive", check here first that it hasn't been reverted.
- **⚠ Turbopack cold start**: the first few API requests after a dev restart may return 401/502 (env /
  compilation not ready yet); refresh and it's fine.
- **⚠ Verifying CSS with curl shows a stale chunk**: turbopack dev does not recompile static CSS chunks for
  a curl request; new styles only take effect once HMR pushes them to a real browser or after a full page
  reload — "curl can't grep the new rule" ≠ "it wasn't compiled in". Confirm in the browser first.
- Once the 7-day cookie expires, pages redirect to /login automatically; just log in again.
- Next 16 trivia: directories starting with `_` are not routed; macOS has no `timeout`, so test SSE with `curl --max-time N`.
