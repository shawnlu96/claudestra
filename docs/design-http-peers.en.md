# HTTP Peer Collaboration (v2.11) — Design Doc

> **English** · [简体中文](./design-http-peers.md)

Owner, 2026-07-19: "Pull the Discord-dependent parts out of peer collaboration … it makes permission management, chat-history control, and the collaboration workflow much easier."

## 1. Core idea

**A peer = another Claudestra instance, talking to us as an API client.**

The v2.6 multi-frontend API already solved every hard problem peer collaboration has: Bearer-token auth, per-agent scope, synchronous `wait` / thread polling, audit mirroring, history API. HTTP peers invent no new protocol — the remote instance holds a token I issued and calls my `/api/v1/agents/:name/messages`, exactly the same path the web UI uses. The entire complexity of Discord peers (channel scoping, bot permission matrices, encoding PeerEvent in HTML comments, the shared `#agent-exchange` channel, `[EOT]` markers to prevent ack loops) simply **does not exist** in the HTTP model.

The table below records **why we replaced it** — the Discord peer column is the historical v1.9–v2.10 approach, removed entirely in v2.11, and is no longer an available path:

| Concern | Discord peer (v1.9–v2.10, **removed**) | HTTP peer (this design, the only remaining transport) |
|---|---|---|
| Transport | `#agent-exchange` in a shared guild | HTTPS/Tailscale direct to the other bridge |
| Permissions | Channel permissions + exposures, two layers | Token scope, one layer (`agents` whitelist) |
| Revocation | `peer-revoke` + channel permission cleanup | `token-revoke` cuts it instantly |
| History | Mixed into the shared channel | Inbound goes through mirror + history API; outbound lives in the caller's jsonl |
| Event encoding | PeerEvent in HTML comments | No encoding needed — it's just an HTTP request/response |
| Dependencies | Both bots in the same guild | Network reachability + a one-time token exchange |

## 2. Data model (peers.json delta)

```ts
interface HttpPeer {
  name: string;      // unique human-readable name ("ahh")
  baseUrl: string;   // the other bridge, e.g. http://100.x.y.z:3847 (Tailscale IP)
  outToken: string;  // Bearer I use to call their API (issued to me by them)
  inTokenId?: string; // short id (tok_xxx) of the token I issued to them — identifies inbound + anchors revocation
  addedAt: string;
  disabled?: boolean;
}
// PeersData gains httpPeers?: HttpPeer[].
// (The design kept the existing Discord fields alongside; they were removed together with
//  the Discord peer mechanism when v2.11 shipped.)
```

Principal delta: `peer?: string` (the peer name). Tokens issued to a peer carry this marker, and the inbound injected header renders as a "peer request" instead of a "web user" based on it.

## 3. Handshake (three steps, each idempotent, strings sent over any private channel)

```
A: bun src/manager.ts peer-http-invite ahh --agents fable-expert
   → prints the invite string (base64 JSON {v,name,url,token}; the token is freshly signed by A with scope already limited)
B: bun src/manager.ts peer-http-join shawn '<invite string>' --agents data-analyst
   → stores A in httpPeers (outToken = the one from the invite string); signs B's own token; prints the receipt string
A: bun src/manager.ts peer-http-accept ahh '<receipt string>'
   → fills in A's httpPeers[ahh].outToken. Done.
B: bun src/manager.ts peer-http-test shawn   # each side tests connectivity once
```

- No automatic negotiation protocol: one extra CLI round-trip buys a minimal implementation where every step is re-runnable and inspectable.
- `peer-http-test` = `GET` the other side's `/api/v1/agents`, printing the list of agents within scope.
- Revocation: `peer-http-remove <name>` (deletes the `httpPeers` entry + revokes the `inTokenId` I issued).
- The url in the invite string is given explicitly via `--url` (the bridge does not guess its own public address).

## 4. Outbound (transparent to the agent using `send_to_agent`)

Target syntax is unchanged (`x@peer` / `peer:peer.x`). Resolution: **a name hit in `httpPeers` → go over HTTP; a miss fails and is reported back to the caller** — as of v2.11 there is no fallback path (the old Discord capabilities route was removed along with the Discord peer mechanism).

New module `src/bridge/http-peer.ts`:

1. `POST {baseUrl}/api/v1/agents/{x}/messages`, body `{text, wait: 120}`, `AbortSignal.timeout(135_000)`. `text` is the caller's raw text — **the injected header is rendered by the receiving bridge** (it knows the principal is a peer); we do not prepend a header ourselves.
2. Reply received synchronously → synthesize a pushback injected into the caller's ws: `[🤖 peer ahh/x 回复] ...` (same format as the Discord peer pushback, so the caller sees no difference).
3. `wait` times out (remote returned 202 / network timeout) → record it in `pendingHttpPeerCalls`, poll `GET /threads/:threadId` every 30s in the background, give up after 10 minutes; on arrival push back, on giving up notify the caller.
4. Any error (403 scope / 409 offline / network unreachable) → immediately tell the caller with a synthesized `[⚠️ peer 调用失败] ...` message, never silently.
5. **No automatic retries** — message delivery is not idempotent, so a retry means a double send; report on the first failure.

## 5. Inbound (zero new code paths)

The remote POSTs to my messages endpoint with Bearer = the token I issued. Scope 403, offline 409, the `wait` resolver, mirror auditing, history recording are **all already in place**. The only change:

- `renderContentForLocal` branches the injected header on `principal.peer`:
  `[🤝 来自 peer 实例「ahh」的跨机请求（HTTP，非本机用户）。对方是另一个 Claudestra 的 agent/用户；用 reply() 回答，回复会自动转交对方调用方。]`
  (i.e. "cross-machine request from peer instance 'ahh' (HTTP, not a local user). The sender is an agent/user of another Claudestra; answer with `reply()` and the response is forwarded back to their caller automatically.")
- Rate limiting reuses the per-token 120/min.

## 6. Security

- Recommended transport: Tailscale / private network; public exposure must go behind an HTTPS reverse proxy (same stance as the `BRIDGE_BIND` docs).
- `peers.json` / `principals.json` are 0600 (principals already were; peers gets it in this change).
- The tokens are independent of each other: revoking A→B does not affect B→A.
- No ack-loop risk (HTTP is one request one response, there is no broadcast channel); pendings have a TTL cleanup.
- The R1 shared-context guard still applies: issuing a peer token for an agent not marked `--external` requires `--force`.

## 7. Test strategy (owner: "the flow is hard to test, come up with an approach")

1. **Pure logic unit tests** (`tests/http-peer.test.ts`): invite/receipt string encode/parse round-trip, target resolution priority (HTTP hit / name collision; the "fall back to Discord" case is void since v2.11 removed that mechanism), the pending polling state machine (inject a fake `fetch`), `HttpPeer` read/write compatibility (an old `peers.json` with no `httpPeers` field).
2. **Self-peer loopback (the killer trick)**: register this machine as its own HTTP peer (`baseUrl=127.0.0.1:3847`, token genuinely signed) → `agent-temp` calls `send_to_agent("router@self")` → outbound HTTP → inbound API → injected into `router` → `router` replies → `wait` returns → pushback to `temp`. **One machine verifies the whole chain with real networking, real auth, and bidirectional routing**, no second deployment needed.
3. **Fault injection**: wrong token (403), stopped agent (409), unreachable port (network error), `wait` timeout → thread polling delivers. All done with `agent-temp`/`router`, never touching real workers.

## 8. Compatibility and scope

- The Discord peer mechanism was removed entirely in v2.11 (the shared `#agent-exchange` channel, exposures, and bot-to-bot routing are all gone; it is no longer an available path); HTTP peers are the only cross-instance transport.
- v1 scope: the full CLI flow + bridge transport + injected header + tests. A web management page (visual exposure/history) comes in v2 — get the foundation right in the CLI first.
- Version: v2.11.0 (minor, new user-facing capability).
