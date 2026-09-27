# Claudestra Web Client

**English** · [简体中文](./CLAUDE.md)

Claudestra's Next.js web front door (the second entry point beside Discord). It is a **pure static export** (`output: "export"`) hosted by the relay (`RELAY_STATIC_DIR`) or by the bridge itself (`BRIDGE_STATIC_DIR`); the browser talks straight to the bridge's `/api/v1/*`. There is no server, no BFF and no login system — signing in means pairing a device (`docs/design-hosted-frontend.md`).

## Stack

- Next.js 16 + React 19 + TypeScript + Tailwind 4 + daisyUI; state via zenith (`@do-md/zenith`, vendored into `.packages/`).
- Its dependency tree is independent of the Bun backend at the repo root. Dev: `npm run dev` → http://127.0.0.1:33333 (`scripts/dev-proxy.ts`: pages go to next dev, `/api/v1` to the local bridge). Artifact: `npm run build` → `out/` (inside a worktree with a symlinked `node_modules` Turbopack panics; use `npx next build --webpack`).

## Layout

Per-file notes live in [docs/web/layout.md](../docs/web/layout.md).

```
app/                  pages: / (dispatch) · /chat · /pair · /login → /pair · /join and /i (collaboration invites). All client components; no api/
features/chat/        chat: type / stream (protocol v1) / chat-store (zenith hub) / components
features/machines/    machine list: MachineGate (renders only once config + list are loaded, "pair again" banner), MachineSwitcher, version check
features/pair/        pairing page: QR challenge-response / typed code with approval polling / one-tap local pairing
features/terminal/    remote terminal; features/devtools/ developer panel (docs/web-dev-mode.en.md)
lib/app-config.ts     /app-config.json → relay | direct (missing file = direct single-machine fallback)
lib/machines.ts       IndexedDB machine list {fp,name,addedAt,lastUsedAt,principalId?} — never credentials; current machine mirrored for the SW / boot.js
lib/api/client.ts     the only fetch exit: base /m/<fp> or "", credentials include, x-cstra-device on non-GET, 401 → machine marked "repair"
lib/api/<domain>.ts   agents / chat / history / stream / settings / system / push / terminal / devices / version: the former BFF reshaping lives here
lib/chat/             history-shape / stream-shape (the BFF's pure transforms), events (protocol v1), attachments, inline-buttons (twin)
public/boot.js        the former layout inline scripts (theme / watchdog / probes) — a static file is what a script-src 'self' CSP allows
public/sw.js          Web Push: a notification click posts read to the machine that sent it
```

Anti-rot rules are the repo root's (root CLAUDE.md); `web/` and `src/` never import each other — shared logic only as a twin.

## Identity and requests

- One browser × one machine = one HttpOnly cookie `cstra_dev` (relay: Path=/m/<fp>/), issued and verified by the bridge. JS cannot read it; attachments go through `<AuthImg>` (fetch + blob, never a token in a URL).
- Every request goes through `lib/api/client.ts`: the **target machine is captured when the request is sent**; switching machines aborts the old machine's in-flight requests and SSE, and a late response is never applied to the new machine. `DeviceInvalidError` is surfaced once by the MachineGate banner — components do not handle 401 themselves.
- "Which messages are mine" = `chatId === "api:owner:self"` (guests: the principalId returned at pairing) plus whoami's ownerIds (`lib/chat/history-shape.ts`).
- Versions: `lib/version-check.ts` — compare webCommit exactly when present, else HEAD; a machine whose apiVersion is too low shows "this machine needs an upgrade".

## Data flow

Opening an agent: `fetchHistory` (bridge `/agents/:name/history[/:sid]`) → `openAgentEventStream` (subscribe to `/events`, filter by agent locally, translate, back-fill `/pending` and `/bg-tasks` on connect); `send` is fire-and-forget and the output comes back over the stream. Full description in [docs/web/data-flow.md](../docs/web/data-flow.md). Invariants:

- **Wake-up alignment = cursor delta**: cursor `{sessionId, lastSeq}`, delta first then stream (serial), the stream carries no `since`; rotation / more than a page / repeated failure fall back to a full reload.
- **Live ↔ history dedupe by seq** (`features/chat/live-merge.ts`) — never guess by timestamp.
- **Duplicate-send gate** (`send-dedupe.ts`): same agent + same payload within 1.5s is sent once.
- Interrupt / permission card / AskUserQuestion: event down → card → `POST /agents/:name/{interrupt,answer}` → tmux keystrokes. The permission card's downstream event is still missing (permission-watcher targets Discord only).

## PWA container (invariants converged on real devices — never change one piece in isolation)

0. **Never pin a height on `html`**: `html,body{height:100%}` makes iOS standalone clamp `fixed` to the safe-area-inset short viewport, so the bottom never reaches the screen edge. Use `body{min-height:100vh}`; no `overflow:hidden` on html/body.
1. The app-shell root `fixed inset-0 overflow-hidden` (chat.tsx) is the entire scroll lock; do not revert to an in-flow `h-dvh`.
2. Safe-area padding belongs to each panel with its own bg — not on the root (colour bands). Bottom: `max(env(safe-area-inset-bottom), normal spacing)`, never added.
3. Canvas colour follows the panel: body sets no bg; chat.tsx toggles `canvas-list` on `<html>`.
4. Modals and any `fixed` overlay must be `createPortal`ed into body (the mobile conversation page lives inside a transform slide container). After viewport/manifest changes iOS needs the home-screen icon removed and re-added.
5. Debug with `?dev=1` (measured viewport values); icons via `node scripts/make-icons.mjs`.

## Running & troubleshooting

- The backend is only `com.claudestra.bridge` (+ launcher / cron); **there is no web service any more**. Backend change → `launchctl kickstart -k gui/$(id -u)/com.claudestra.bridge`; web change → `npm run build`, the host serves `out/`.
- The dev proxy sets `NODE_ENV=development` for next dev (this machine's shell exports production); the bridge sees the proxy as a same-origin local page and answers `/app-config.json` too (direct mode).
- `/events` SSE: the bridge sends `: connected` on connect + a 5s ping; when the stream "sometimes doesn't arrive", check that first.
- Client logs land in the bridge's client.log (`POST /api/v1/client-log`, used by both boot.js and `lib/client-log.ts`).
- Next 16: directories starting with `_` are not routed; macOS has no `timeout`, test SSE with `curl --max-time N`.
