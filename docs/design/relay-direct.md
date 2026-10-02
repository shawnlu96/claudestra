# Direct first, relay fallback

Status: design proposal. Order needs owner approval (§6). Names: 本机 / peer A / peer B / 中继. Results are local lab observations; no code or deployment changes.

## 1. Measurements and diagnosis

### 1.1 Isolation and reproducible procedure

Source checkout: `1ddfa15657d0180e79a02ca416f012b99784a64c`. Measurement date: 2026-10-02, UTC.
Use [sandbox lab mode](../architecture/sandbox.md), independent HOME, no provider credentials, Codex ACP stubs and generated lab identities.
The lab's own pairing connects its two instances only. It does not contact a production relay or start real model sessions.
No production bridge requests, production tmux commands, system service changes or production credential inspection are part of this procedure.

```sh
LAB_HOME=$(mktemp -d /tmp/rd0-home.XXXXXX)
mkdir -p "$LAB_HOME"
lsof -nP -iTCP:24900-24906 -sTCP:LISTEN
# Continue only if the ports have no listeners.
env -i PATH="$PATH" HOME="$LAB_HOME" USER=lab \
  bun --no-env-file run sandbox up --lab --pair --port 24900
```

The control script only reads production configuration to build its forbidden-port/directory list;
`sandboxEnv` constructs child environments from scratch, and child Bun processes use `--no-env-file`.
Production dotenv variables are not inherited by the sandbox bridge. Isolated HOME does not suppress that control-script discovery.
Do not inspect any state credential files. Obtain generated lab authentication via `manager token-add`, capture its JSON privately,
and turn `secret` into a mode-600 curl config containing an Authorization header. Never log the secret or pass production tokens in argv.
Use `manager peer-http-list` for the generated peer label; publish only peer A / peer B.
Obtain the generated lab fingerprint from the lab relay registration log, and its synthetic virtual Host from the lab relay startup log.
Set these variables locally, without copying their values into this document:

- `DIRECT_BASE`: lab instance A HTTP origin, port 24900; `RELAY_BASE`: lab relay HTTP origin, port 24904.
- `FP`: lab A fingerprint; `LAB_HOST`: lab relay virtual Host; `AUTH_CFG`: protected curl config.
- A/B bridge ports: 24900/24901; ingress: 24902/24903; relay: 24904; fake push/APNs: 24905/24906.

The browser-equivalent authenticated HTTP baseline uses the same instance, endpoint, principal, response shape and uncompressed bytes:

```sh
TIMING='%{http_code} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{size_download} %{speed_download}\n'
for n in $(seq 1 20); do
  curl -sS --max-time 15 --config "$AUTH_CFG" \
    -o "$OUT" -w "$TIMING" "$DIRECT_BASE/api/v1/agents"
done
for n in $(seq 1 20); do
  curl -sS --max-time 15 --config "$AUTH_CFG" \
    -H "Host: $LAB_HOST" -o "$OUT" -w "$TIMING" \
    "$RELAY_BASE/m/$FP/api/v1/agents"
done
```

Validate status 200 and a JSON `agents` array on every sample. For each timing field, sort the samples;
p50 is the median and p95 is sorted index `floor(.95*(n-1))`. Timings are cumulative seconds from curl start.
The actual scratch runner used `curl -w '%{json}'` and Python subprocesses under the clean environment,
checked the JSON shape and computed those statistics. All requests opened a fresh HTTP connection; the bridge→relay WS was already warm.
These are HTTP measurements corresponding to browser API calls, not browser render, cookie, CORS, TLS or iOS tests.
For warm HTTP keepalive comparison use a single long-lived client; do not call repeated curl launches a warm connection test.
For peer probes, run the following ten times on each lab side under the same clean environment and measure with a monotonic clock:

```sh
bun --no-env-file run sandbox --lab --port 24900 \
  --as a manager peer-http-test "$PEER_A"
bun --no-env-file run sandbox --lab --port 24900 \
  --as b manager peer-http-test "$PEER_B"
```

Here A→B uses direct HTTP and B→A uses the lab relay. Check `reachable:true` each time.
The timer surrounds the entire CLI subprocess, including startup, E2E handshake and body validation.
This comparison is directional and includes different responders; it cannot establish a causal relay penalty.
For a matched hot peer comparison, the PM must use the same signed/E2E read request against one responder with two candidate transports.
Do not replay captured signed requests; create a fresh valid request for each sample.

Send one stub message per side via authenticated `POST /api/v1/agents/lab-a/messages` or `lab-b/messages`,
with JSON `{text:"[stub:send:<target>@<lab-peer>] rd0 probe",wait:10}`.
Read the initial response, then correlate the cross-instance request, target receipt and reply using the lab logs/history.
The stub replies to its caller *before* calling `send_to_agent`; that first HTTP response is not the cross-peer completion time.
A successful probe or send does not prove a lend order was accepted or completed.

### 1.2 Results, with provenance

All rows below are **measured**, using §1.1's scratch runner between 2026-10-02 03:04:00 and 03:04:21 UTC.
They are from one sequential run, not WAN or capacity benchmarks. Rounded values retain the measured units.

| Measured quantity | Direct A API | Lab relay to A API |
|---|---:|---:|
| Samples | 20 | 20 |
| DNS p50 / p95, ms | 0.071 / 0.204 | 0.071 / 0.105 |
| Connect p50 / p95, ms | 0.352 / 0.473 | 0.355 / 0.383 |
| TLS time, ms | 0 (HTTP) | 0 (HTTP) |
| TTFB p50 / p95, ms | 196.087 / 241.100 | 187.306 / 247.159 |
| Total p50 / p95, ms | 196.184 / 241.295 | 187.400 / 247.283 |
| Response bytes, every sample | 432 | 432 |
| curl effective download rate p50, B/s | 2201.5 | 2305.0 |

**Measured**, same runner/time interval: A→B CLI peer probe, n=10, total p50/p95 458.309/511.791 ms;
B→A relay CLI peer probe, n=10, 448.849/488.746 ms. These include startup and fresh E2E sessions.
**Measured**, same runner/time interval: local stub HTTP responses were 316.578 ms (A) and 313.966 ms (B), one sample each.
Both had `ok`, `reply`, `threadId`, `agent`. Logs show the subsequent relay peer request;
no cross-peer completion RTT is claimed because the runner ended before receiving its final reply.
**Measured**, lab relay log at 03:04:19 UTC: one fresh peer E2E hello took 3 ms and its subsequent read took 194 ms,
using relay log `req`/`res` timestamps. This is one sample, not a distribution or production handshake cost.

The small-response rates include about 0.2 seconds of endpoint work: they are **not link bandwidth**.
No production numbers have been supplied for this card. Bulk throughput, true browser/iOS startup, WAN RTT,
network changes, NAT success rates and end-to-end lend dispatch/accept/result timing remain **unmeasured**.
A complete lend trial additionally requires isolated ledger nodes, borrow/grant policy and a worker completion fixture;
the paired messaging lab does not provide those automatically. Keep those missing measurements explicit rather than inventing order latency.

### 1.3 What can take seconds?

**Measured conclusion:** this local API sample has sub-millisecond connection setup and roughly 0.2-second TTFB;
relay total is comparable to direct. It does not demonstrate a seconds-long relay delay or a bandwidth bottleneck.
**Code fact, not timing measurement:** `src/lib/lend-dispatch.ts` defines `PUSH_TICK_MS = 5_000`.
**Inference:** a newly pooled order waiting for that loop could spend up to roughly one tick before its offer;
this is an application scheduling hypothesis, not a measured production root cause and not browser latency.
**Hypotheses:** sequential API dependencies, backend inventory work, E2E/WS reconnect, outstanding-request queues,
body parse/render work, polling and background suspension can dominate perceived startup. Production traces must distinguish them.
Log-window average traffic is neither bandwidth nor transfer speed. Model execution must be excluded from transport RTT.

### 1.4 PM production measurements (not executed here)

The PM supplies origins, pinned identities and protected auth locally. Share only anonymized aggregates and trace phase durations.
Use a non-mutating representative endpoint, the same response/version and matched compression (also record Content-Encoding).
A large existing read response can measure API goodput; synthetic bulk capacity needs a dedicated approved direct-only fixture.
Do not create a large relay upload/download just for this benchmark.

```sh
# AUTH_CFG is a protected file; OUT is a private scratch file.
# READ_PATH is a read-only API path without a leading slash.
for base in "$DIRECT_BASE" "$RELAY_BASE/m/$FP"; do
  for n in $(seq 1 20); do
    curl -sS --compressed --max-time 30 \
      --config "$AUTH_CFG" -D "$HEADERS" \
      -o "$OUT" -w "$TIMING" "$base/$READ_PATH"
  done
done
bun --no-env-file src/manager.ts peer-http-test "$PEER"
tailscale ping "$PEER_TARGET"
tailscale status
```

The last two commands determine whether Tailscale itself uses direct UDP or another relay; redact their address/name output.
Run `peer-http-test` ten times per configured route, with a monotonic CLI timer, documenting its startup overhead.
For matched peer RTT, instrument the existing peerFetch/E2E call in an approved harness:
request start→hello finish→request sent→res headers→body verified, same responder and payload, direct vs relay,
first request vs session reuse. No raw curl to peer ingress with a device cookie: that would exercise the wrong auth path.
For browser startup record navigation→API start→headers→body validated→first usable render, cold and warm;
record redirects, request count, SSE event lag and background/resume separately on desktop and iOS.
For a controlled lend trial, with PM-approved test project/order only:

```sh
bun --no-env-file src/manager.ts borrow status
bun --no-env-file src/manager.ts lend status
bun --no-env-file src/manager.ts ledger show "$TEST_NODE"
```

Use the existing lend trial procedure in [trial evidence](../team/lend-trial-evidence.md) to create the authorized fixture;
trace pooled→offer sent→offer accepted→worker started→result accepted with order/request IDs and monotonic durations.
Compare direct and relay on the same direction; don't measure model runtime as network latency.
For peer messages measure transport ACK and target receipt separately from first reply and completed turn.
Report exact command, UTC time, samples, status/error counts, bytes, compression, route and p50/p95 for each measurement.
Multi-host timestamps need clock alignment; otherwise calculate local spans and don't subtract unrelated clocks.

## 2. Options and security boundaries

No NAT percentage is promised without a representative fleet/network test. The expectations below are **hypotheses**.
Work estimates are **planning estimates**, engineer-hours excluding owner approval, deployment and device access.
All paths preserve paired-device scope, revocation, peer identity pinning, Bearer authorization, signature and E2E-required policy.
Discovery, a shared public egress address and the displayed fingerprint are routing hints, not authorization.
Never send a bearer token to an unverified candidate, accept arbitrary relay-provided URLs, or scan a subnet.

- **(a) LAN discovery** — Browser→own bridge; peer→peer LAN candidate. Good on reachable LAN; shared egress alone proves nothing; isolated Wi-Fi can fail.
  Changes: Browser uses bounded identity-checked hints/probes, CORS/PNA handling; existing local-hop is same-machine desktop only. iOS adds permitted native discovery/local-network consent.
  Bun advertises authorized candidates and verifies identity.
  Lifecycle / estimate: No browser mDNS socket assumption; background suspends probes/streams, resume reprobes. About 8–12 h.

- **(b) WebRTC DataChannel** — Both paths via ICE; STUN discovers candidates but cannot guarantee passage through hard NAT or blocked UDP. TURN would improve reachability by forwarding, not
  by making it direct.
  Changes: Browser RTC adapter; iOS RTC lifecycle/permissions. Bun needs a validated native RTC binding or supervised sidecar, bounded signaling and HTTP/stream multiplex adapter; browser
  APIs are not assumed available in Bun.
  Lifecycle / estimate: Mobile suspension loses sessions; foreground ICE restart plus request recovery. Feasibility 4 h, prototype/integration roughly 24–40 h, not a promise.

- **(c) Tailscale / own HTTPS origin** — Both paths for enrolled devices or an owner-provisioned HTTPS origin. Tailscale can itself use DERP/peer relay; distinguish this from actual direct
  UDP. Public HTTPS needs reachable existing ingress.
  Changes: Browser approved origin and origin-scoped pairing; iOS VPN/existing trusted HTTPS entry; Bun reuse ingress, auth and signed candidate registry. No automatic daemon/DNS/certificate creation.
  Lifecycle / estimate: OS VPN may survive background but app socket may not; reconnect on resume. About 8–12 h when infrastructure exists.

- **(d) Direct peer HTTPS** — Machine↔machine only, using `PEER_INGRESS_PUBLIC`; no browser device endpoints. High when an approved reachable TLS ingress exists; no generic NAT traversal;
  CGNAT needs another option.
  Changes: Browser/iOS no peer-device API bypass. Bun peerFetch chooses pinned HTTPS candidate, signs/verifies as today, falls back to relay preserving E2E.
  Lifecycle / estimate: Bridge stays resident; peer offline requires recovery. About 8–12 h with existing TLS ingress.

(a) reuses [local-hop](../../web/features/machines/local-hop.ts), but same-network is only a hint and its loopback port is not a LAN discovery system.
Cross-origin direct browser requests need explicit origin policy and independent device authorization;
a relay-origin cookie cannot simply be copied to a direct origin. Same-machine preference handoff must not carry credentials.
Native mDNS consent and browser local-network restrictions require real-device tests before enabling automatic switching.

(b) DTLS secures DataChannel transport, but its signaling needs authenticated machine/device identity binding:
sign session/offer/answer and key material, bind the DTLS fingerprint to the trusted identity, nonce and expiry,
and reject replay/stale sessions. ICE candidates are private metadata; disclose only to an authorized participant,
with candidate count, size and destination limits. Preserve application E2E and authorization above the RTC adapter.
Initial proposal: STUN only, no TURN deployment; use existing relay for permitted small requests if ICE fails.
A TURN-selected candidate is a forwarded route and cannot carry the direct-only large-file class.

(c) enrollment and TLS reachability are prerequisites, not automatic installer actions.
Tailscale avoids the Claudestra relay but is not proof of a direct physical route; expose that distinction in diagnostics.
Initially ordinary overlay HTTPS is eligible only for small operations, even after a successful direct UDP probe.
Bulk requires a path that cannot silently switch to third-party forwarding: verified LAN, independent direct HTTPS or non-relay ICE.
(d) public peer ingress must remain peer-only: strip device cookies/headers, reject device endpoints/non-peer tokens,
verify the pinned sender before expensive E2E work and keep the established signed/E2E envelope on both transports.

[The E2E design](../relay/e2e-design.md) remains authoritative for frontend trust and credential provenance.
A compromised relay-hosted frontend can read plaintext or use device keys even when requests travel direct;
changing route is not a solution to its A3 attacker. Trusted packaged iOS code and signed distribution are separate work.
Never clear `everViaRelay` after switching direct: old cookie exposure and issuance history persist.
A direct origin needs independently authorized pairing or the existing approved E2E identity flow, not blind credential transfer.
An E2E-required peer/device never falls back to plaintext on failure or capability disagreement.

Technical references checked 2026-10-02: W3C WebRTC Recommendation (ICE restart / DataChannel), RFC 8831 and RFC 8656;
Tailscale official “Connection types” and “Device connectivity” documentation (direct vs relayed routes).
Source locations are named without embedding external hostnames, to keep this public design free of operational addresses.

## 3. Recommended rollout and fallback state machine

Deliver (a)+(c)+(d) first, then (b). Direct selection is per machine and network generation, not one global UI flag.
The following timeouts are **proposed defaults, unmeasured**: candidate probe budget 1500 ms total,
cooldown retries 5/15/60 seconds with jitter. Probe only authorized configured candidates; race their read-only checks within that budget.

- **START / PROBING:** boot, foreground, selection or cooldown tests identity; hold new writes until selection/deadline. Existing relay reads may render.
- **DIRECT:** a verified candidate wins; pin issued requests to it and cancel losing probes before sending writes.
- **RELAY:** no candidate/deadline expired; send eligible small operations, keep files queued, and probe in the background for future requests.
- **RECOVERING:** disconnect, stalled stream or network/resume change increments generation; stop new writes and reconcile in-flight outcomes before selecting a route.
- **OFFLINE:** neither authenticated route works; retain bounded durable queues and cancellation without reporting delivery.

New writes try verified direct first, with relay selected after the probe deadline if it is permitted.
An already dispatched request is not migrated while its response is still arriving. A later route win is not authority to duplicate it.
For idempotent reads retry on the alternate verified transport; validate full body/schema and discard partial responses.
For writes, exactly-once execution needs server support; aborting fetch does **not** prove the server did not execute it.
Introduce a stable operation ID scoped to principal, machine, method, canonical path and body digest.
The receiver durably and atomically records pending/committed result with the side effect (or an application transaction/outbox).
A duplicate ID with another digest is rejected; concurrent duplicates join one result, including across direct and relay.
Retain results for the complete supported retry window; if that window expires, block automatic retry until reconciled.
After disconnect query status by ID, then recover the cached result or resend the identical operation under that ID.
If the receiver cannot prove non-execution or lacks dedup support, mark “outcome unknown” and reconcile before any resend.
Do not claim generic exactly-once delivery with only a client retry key or a process-local cache.
Messages and lend writes require the same server-side key through the entire dispatch/accept/result chain.
Never parallel-send a write “to whichever route wins”. Offline queues persist IDs; principal revocation invalidates queued authorization.
Streams resume only with a server-supported cursor; retain last committed event ID and deduplicate replayed events.
Without a cursor, resync a snapshot and reconnect. File transfers resume verified chunks under a stable transfer ID and final digest;
check permissions again at resume. Partial body data cannot enter a success cache.
Wi-Fi↔cellular invalidates candidate assumptions and switches through RECOVERING; RTC later performs ICE restart under a new generation.
iOS background closes/suspends active transport work without pretending success; push remains a wake hint, foreground performs reconciliation.

Route UI uses a small animated connection glyph: direct pulses point-to-point; relay pulses through a middle node;
probing/recovering uses a rotating pulse; offline pauses with reduced opacity. No explanatory route prose in the ordinary flow.
Provide accessible labels and a static equivalent under reduced motion; diagnostics can give explicit transport details.

Large files with logical size over 256 KiB never use Claudestra relay, TURN or ordinary overlay routes in phase one.
A successful Tailscale direct probe is not a lifetime guarantee: subsequent bytes could use DERP/peer relay without an HTTP failure.
Reject overlay bulk before sending any bytes; do not try to repair this with periodic polling or abort after forwarded bytes have escaped.
Re-enable overlay bulk only after a separately reviewed underlay can enforce no forwarding for the entire transfer; status hints alone are insufficient.
The protocol frame limit is not a file limit: base64/envelope overhead means even smaller payloads can exceed a frame,
and many small frames must not be used to bypass the logical-file policy. Unknown-length files use direct only.
When direct is unavailable, preserve transfer progress and wait for a permitted route; send only a small metadata/status request through relay.
Existing large API responses are not automatically file transfers, but new bulk endpoints must have an explicit classification and limit.

## 4. Relay v2 invariants and signaling compatibility

1. Keep relay HTTP `idleTimeout: 0` in `src/relay/server.ts`. Route probing has client deadlines, not a changed server idle timeout;
   SSE and long streams still use their current protocol lifetimes/cancel handling.
2. Do not change PROXY protocol termination or trusted reverse-proxy layer counts.
   A route switch cannot reinterpret forwarded headers or make a public peer request loopback-trusted.
   New ingress uses the existing source classification; no listener, TLS, DNS or proxy changes are performed by this design card.
3. `src/lib/relay-protocol.ts` remains the sole source of relay constants/frame validation.
   (a)+(c)+(d) use existing request/response semantics and authenticated application capability discovery; no new relay frame is required.
Later (b) proposes a negotiated `direct-signal-v1` capability, advertised by upgraded peers and relay, not presumed from protocol v2 alone.
The new client offers supported signaling versions; relay returns an explicit supported version, preserving existing v2 auth/welcome fields.
Until both endpoints and relay acknowledge the extension, send no new frame; old relay/peer combinations keep today's relay behavior.
Add typed signal frames centrally (offer/answer/candidate/cancel), bounded payload and rate limits, signed participant/session binding,
and contract tests for old/new combinations. Unknown/unsupported signaling never changes existing `req/res/data/end/cancel` meaning.
A routing-capability hint is not trusted security negotiation: application identities/signatures and required E2E determine acceptance.
If a deployed old relay rejects optional handshake fields, use an authenticated existing capability request before attempting extension negotiation.
Do not make current sessions depend on new signaling. A future incompatible semantic change requires a new protocol/subprotocol version.

## 5. Implementation nodes

Planning estimates: each node ≤4 h, excluding approvals/deployment; oneLine ≤60 characters. These are future implementation tasks.

- **RD1 / Freeze matched transport baseline**; deps: none; 4 h.
  fileGlobs: `tests/relay-direct*.ts`, `docs/design/relay-direct.md`.
  Acceptance: Matched endpoints and PM phases; invalid body excluded.
- **RD2 / Authenticate bounded route candidates**; deps: RD1; 4 h.
  fileGlobs: `src/lib/direct-candidates*.ts`, `src/bridge/direct-candidates*.ts`.
  Acceptance: Pinned identity, expiry and SSRF bounds; inject route queries, not hub imports.
- **RD3 / Add durable operation contracts**; deps: RD1; 4 h.
  fileGlobs: `src/lib/operation-dedup*.ts`, `tests/operation-dedup*.ts`.
  Acceptance: Atomic result/status contract, digest mismatch and crash vectors; no new bypass import of ledger-tx.
- **RD4 / Bind lend admission and result transactions**; deps: RD3, CONV3 PR #413 merged; 4 h.
  fileGlobs: `src/lib/lend-inbox.ts`, `src/lib/ledger-lend-result.ts`, `src/lib/lend-operation*.ts`.
  Acceptance: Reuse admission BEGIN IMMEDIATE and result tx; lost result retry returns the existing signed receipt.
- **RD4M / Bind peer message delivery outcomes**; deps: RD3; 4 h.
  fileGlobs: `src/bridge/http-peer.ts`, `src/bridge/peer-operation*.ts`.
  Acceptance: Persist enqueue/result ownership; ambiguous delivery reconciles by ID, never auto-resends legacy writes.
- **RD5 / Wire bridge peer route selection**; deps: RD2,RD4,RD4M; 4 h.
  fileGlobs: `src/bridge/relay-link.ts`, `src/lib/direct-route*.ts`.
  Acceptance: peerFetch/rawPeerFetch delegate via one-line hooks; send_to_agent, presence and lend use verified direct/fallback.
- **RD5M / Wire manager peer route selection**; deps: RD5; 4 h.
  fileGlobs: `src/manager/relay.ts`, `tests/manager-direct*.ts`.
  Acceptance: peerCliFetch and peerE2eOnlyFetch reuse RD5 selection without losing signatures or E2E-required policy.
- **RD6 / Wire browser transport and origin auth**; deps: RD2,RD7,RD10; 4 h.
  fileGlobs: `web/lib/api/client.ts`, `web/features/machines/direct-route*.ts`, `web/lib/api/transport*.ts`.
  Acceptance: send/resolveTarget wire apiRaw/api/apiStream to route/write/file helpers; keep origin auth and credential history.
- **RD7 / Implement device operation recovery**; deps: RD3; 4 h.
  fileGlobs: `src/bridge/device-operation*.ts`, `web/lib/api/operation*.ts`.
  Acceptance: Durable enqueue/status adapter and stream cursor contracts; connect via RDW/RD6, not orphan helpers.
- **RD8 / Wire native LAN discovery**; deps: RD2; 4 h.
  fileGlobs: `native/ios/App/App/AppDelegate.swift`, `native/ios/App/App/DirectDiscovery*.swift`.
  Acceptance: One-line discovery hookup; consent denial and isolated LAN fall back. No subnet scanning.
- **RD9 / Wire route motion and native resume**; deps: RD6,RD8; 4 h.
  fileGlobs: `web/features/machines/route-status*`, `native/ios/App/App/ClaudestraViewController.swift`, `native/ios/App/App/RouteLifecycle*.swift`.
  Acceptance: One-line lifecycle hookup; generations reject stale wins; reduced-motion/accessibility tested.
- **RD10 / Implement strict bulk eligibility**; deps: RD5,RD7; 4 h.
  fileGlobs: `src/lib/direct-file*.ts`, `web/lib/direct-file*.ts`, `tests/direct-file*.ts`.
  Acceptance: Overlay denied even after direct probe; simulated DERP fallback and unavailable/expired proof send zero bulk bytes.
- **RDW / Wire API writes and upload gates**; deps: RD7,RD10; 4 h.
  fileGlobs: `src/bridge/api-routes.ts`, `src/bridge/direct-api*.ts`.
  Acceptance: One-line pre-dispatch hook covers messages multipart and device status; bind effects atomically or report unknown.
- **RDF / Wire media download eligibility**; deps: RD10,RD6; 4 h.
  fileGlobs: `src/bridge/local-api/media.ts`, `web/lib/api/media.ts`, `tests/direct-media*.ts`.
  Acceptance: raw/download and media URL construction call gate; unknown/oversize files queue without relay or overlay payload.
- **RD11 / Prove Bun RTC feasibility**; deps: RD1; 4 h.
  fileGlobs: `tests/rtc-feasibility*.ts`, `docs/design/rtc-feasibility.md`.
  Acceptance: Browser/Bun and Bun/Bun prototype; validate binding/license/resource limits or report blockers.
- **RD12 / Wire negotiated signaling frames**; deps: RD2,RD11; 4 h.
  fileGlobs: `src/lib/relay-protocol.ts`, `src/relay/server.ts`, `src/lib/relay-client.ts`, `src/relay/direct-signal*.ts`, `tests/relay-signal*.ts`.
  Acceptance: Existing parse/dispatch entrances call bounded signal handlers; old/new matrix preserves v2. Owner approval for relay deployment.
- **RD13 / Adapt RTC request transport**; deps: RD11,RD12; 4 h.
  fileGlobs: `src/lib/rtc-transport*.ts`, `web/lib/rtc-transport*.ts`.
  Acceptance: Adapter plugs into RD5/RD6 transport interface; authenticate ICE/DTLS and check backpressure.
- **RD14 / Implement RTC stream and file adapter**; deps: RD10,RD13; 4 h.
  fileGlobs: `src/lib/rtc-stream*.ts`, `web/lib/rtc-stream*.ts`, `native/ios/App/App/RtcLifecycle*.swift`.
  Acceptance: Pluggable lifecycle/cursor adapter; authenticated resume and TURN rejection. Integration verified in RD15.
- **RD15 / Verify NAT and phased rollout**; deps: RD9,RDW,RDF,RD5M,RD14; 4 h.
  fileGlobs: `tests/direct-route*.ts`, `docs/design/direct-rollout.md`.
  Acceptance: Exercise actual bridge/manager/browser/native hooks, network changes and rollback; owner approves relay activation.

Each existing file has exactly one owning node above; dependencies do not grant another node permission to edit it.
Bridge callers `http-peer.ts`, `peer-presence.ts`, `lend-tools.ts` and `lend-dispatch.ts` already call relay-link peerFetch;
RD5 changes that common exit, not their call sites. Manager exits are independently wired by RD5M.
RD6 owns client.ts for route/write/file delegation; RDW alone owns API write/upload integration.
RD5/RD6/RD9 reserve allowlisted capability-gated lazy adapter loading; RD13/RD14 fill those adapters without editing earlier owners.
RD4 waits for CONV3 #413, then binds operationId to peer/orderId/generation and canonical digest/bodySha within existing transactions;
admission conflicts reject, result/deliver replays reuse stored resultSha/eventSeq/signed receipt. Do not create a second receipt ledger.
`ledger-tx.ts` remains an internal existing primitive; reuse it through its allowed transaction owners, never export a new bypass.
New route/dedup modules hold logic; large hubs receive one-line calls and must not grow under the ratchet.
If atomic effect/outbox support or RTC integration exceeds four hours, split/re-estimate before starting; never weaken retry safety.
Deploying relay signaling, STUN/TURN, TLS/ingress services, DNS or machine-wide settings always needs explicit owner approval;
peer or PM consent is not authorization for shared machine infrastructure. This card deploys none of them.

## 6. Deviation from the original plan

The target remains “relay as rendezvous + signaling + fallback”, with direct-only large files.
The **delivery order deviates**: (a)+(c)+(d) precede WebRTC hole punching (b), instead of making generic hole punching the initial path.
Reason: existing authenticated ingress and local-hop can be extended without first proving a Bun RTC runtime,
while dedup and recovery must be solved for every transport. Local measurements do not justify emergency relay bandwidth changes.
This is a proposal for owner decision, not a silently approved replacement of the original plan.
Planning difference: the fourteen first-stage nodes total 56 engineer-hours; RD11–RD15 add 20 hours, subject to spike results.
Dependency overlap permits some concurrency, but these are not calendar promises. RTC may add more integration work after RD11.
During this interim stage devices with no LAN/approved HTTPS/Tailscale route still use relay for eligible small traffic;
large files remain unavailable without LAN/independent direct HTTPS; ordinary overlay is excluded even if currently direct.
This additional first-stage bulk limitation needs owner review; RTC later permits only non-relay ICE for bulk.
Return to the original order if the owner declines the interim scope, if required devices cannot use (a)/(c)/(d),
or if RD11 demonstrates a supported low-cost RTC integration with materially broader direct reachability.
Then prioritize RD11–RD13 before enabling RD5/RD6 by default, retaining shared dedup/identity groundwork.
After RTC acceptance, candidate selection tries authenticated LAN/HTTPS/overlay-direct/ICE within the bounded discovery budget,
and forwards only after direct attempts fail. No TURN deployment or order change is preapproved here.

## 7. Delivery verification and cleanup

Acceptance mapping: measurement provenance/method → §1; four options → §2; recovery/no duplicate writes → §3;
relay invariants/approval → §4–§5; half-day nodes/deviation → §5–§6; privacy/guard/CI → this section.
Only this document is in scope. No baseline loosening, production configuration edits or code changes.
**Measured cleanup**, 2026-10-02: `sandbox down --lab --port 24900` stopped lab tmux and relay,
but its immediate status reported bridges stopped while port inspection still found two lab bridge PIDs.
The runner PATH omitted the system sbin directory containing `lsof`; cwd verification therefore could not identify a live bridge.
This is a runner environment limitation; retain the full system PATH for reproduction and cleanup.
After matching both PIDs to this checkout's bridge command and lab-only listening ports, send SIGTERM to those lab PIDs only;
never infer cleanup from sandbox status alone. Recheck listeners and processes until absent.
Final verification at 2026-10-02 03:11:04 UTC: `lsof` stdout was empty (exit 1), and both verified lab PIDs were absent. No private raw logs/identity/auth files are committed.

```sh
env -i PATH="$PATH" HOME="$LAB_HOME" USER=lab \
  bun --no-env-file run sandbox --lab --port 24900 down
lsof -nP -iTCP:24900-24906 -sTCP:LISTEN
# Required final result: no stdout, exit 1 (no matching listeners).
```

Before commit run `bun run check`; separately inspect `git diff --check` and run `git grep` on this file for
address literals, external hostname patterns, identity/credential strings and personal names (review prose hits in context).
Keep code/source filename references; remove operational hostnames, actual addresses, generated identity IDs and secrets.
Stage this exact path, never `git add -A`. Push normally and open a PR against main; PR CI is the full verification gate.
