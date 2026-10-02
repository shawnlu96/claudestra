# Direct first, relay fallback

Status: design proposal; no transport or deployment changes. The initial delivery order needs owner approval (§6).
Names below are only 本机, peer A, peer B and 中继. Measurements are local lab results, not production claims.

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
For the strict large-file policy require proven direct UDP or independent direct HTTPS, not DERP or Funnel forwarding.
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

| State | Trigger and transition | Request ownership |
|---|---|---|
| START / PROBING | On boot, foreground, machine selection, network generation change or cooldown expiry: test identity and authorization. | Hold new writes until direct is selected or
deadline expires; existing relay reads may render without blocking startup. |
| DIRECT | Verified candidate wins within budget; preserve generation and selected transport. | Pin each issued request to this transport; cancel losing probes before dispatching writes. |
| RELAY | No usable candidate or probe deadline expires. Keep bounded background discovery; direct success applies to future requests. | Small eligible operations use existing relay.
Direct-only files stay queued; no alternate relay upload. |
| RECOVERING | Direct disconnect, failed read, stalled stream, network change or resumed app. Increment generation; invalidate stale probe wins. | Stop new writes, classify in-flight
operations, resolve ambiguous writes, then use verified direct or relay. |
| OFFLINE | Neither authenticated transport available. | Keep bounded durable operation queue, visible progress state and cancellation; never report a queued write as delivered. |

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

Large files with logical size over 256 KiB never use Claudestra relay, TURN or a known overlay forwarding route.
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

All estimates below are **planning estimates**, at most four engineer-hours per node, excluding approvals/deployment wait.
`oneLine` descriptions are below 60 characters. These are new implementation tasks, not changes made by this card.

|---|---|---|---|---|
- **RD1 / Freeze matched transport baseline**; deps: none; 4 h.
  fileGlobs: `tests/relay-direct*.ts`, `docs/design/relay-direct.md`.
  Acceptance: Same responder/payload cold/hot metrics; corrupt body excluded; PM WAN/lend evidence attached. No relay deployment.
- **RD2 / Authenticate bounded route candidates**; deps: RD1; 4 h.
  fileGlobs: `src/lib/direct-candidates*.ts`, `src/bridge/direct-candidates*.ts`.
  Acceptance: Expiry/identity, SSRF bounds and source restrictions tested; no credential leak to an unverified URL. No relay deployment.
- **RD3 / Add peer write dedup contracts**; deps: RD1; 4 h.
  fileGlobs: `src/lib/operation-dedup*.ts`, `tests/operation-dedup*.ts`.
  Acceptance: Atomic transaction contract, digest mismatch, concurrent duplicate and crash recovery vectors. No relay deployment.
- **RD4 / Bind peer and lend operations to dedup**; deps: RD3; 4 h.
  fileGlobs: `src/bridge/peer-operation*.ts`, `src/lib/lend-operation*.ts`.
  Acceptance: Direct commit + lost response + relay resend executes one side effect; unknown legacy result never auto-replayed. No relay deployment.
- **RD5 / Select direct HTTPS for peers**; deps: RD2,RD4; 4 h.
  fileGlobs: `src/bridge/peer-fetch.ts`, `src/lib/direct-route*.ts`.
  Acceptance: Pinned HTTPS first, timeout fallback, same E2E identity/scope, no public device auth bypass. No relay deployment.
- **RD6 / Select browser direct with origin auth**; deps: RD2,RD3; 4 h.
  fileGlobs: `web/features/machines/direct-route*.ts`, `web/lib/api/transport*.ts`.
  Acceptance: Independent pairing/E2E authorization; CORS/blocked probe fallback; everViaRelay never reset. No relay deployment.
- **RD7 / Bind browser writes and stream recovery**; deps: RD3,RD6; 4 h.
  fileGlobs: `src/bridge/device-operation*.ts`, `web/lib/api/operation*.ts`.
  Acceptance: Lost response resolved by status; cursor/snapshot recovery; full-body validation. No relay deployment.
- **RD8 / Discover LAN on native shell**; deps: RD2; 4 h.
  fileGlobs: `ios/**/DirectDiscovery*`, `src/bridge/lan-discovery*.ts`.
  Acceptance: Local-network denial and isolated LAN fall back; no unauthenticated address scan. No relay deployment.
- **RD9 / Show route motion and resume safely**; deps: RD5,RD7,RD8; 4 h.
  fileGlobs: `web/features/machines/route-status*`, `ios/**/RouteLifecycle*`.
  Acceptance: Background/network generation changes reject stale probe wins; reduced-motion/accessibility tested. No relay deployment.
- **RD10 / Enforce direct-only file transfers**; deps: RD5,RD7; 4 h.
  fileGlobs: `src/lib/direct-file*.ts`, `web/lib/direct-file*.ts`, `tests/direct-file*.ts`.
  Acceptance: Oversized/unknown files never sent relay or TURN; chunk digest/resume and revocation checked. No relay deployment.
- **RD11 / Prove Bun RTC feasibility**; deps: RD1; 4 h.
  fileGlobs: `tests/rtc-feasibility*.ts`, `docs/design/rtc-feasibility.md`.
  Acceptance: Browser→Bun and Bun→Bun ICE/DTLS prototype, dependency/license/resource assessment; failed spike reports blockers. No relay deployment.
- **RD12 / Negotiate signaling frames**; deps: RD2,RD11; 4 h.
  fileGlobs: `src/lib/relay-protocol.ts`, `src/relay/direct-signal*.ts`, `tests/relay-signal*.ts`.
  Acceptance: Old/new negotiation matrix, signed offers, expiry/limits; no old frame changes. Relay deployment requires owner button approval.
- **RD13 / Adapt RTC to browser and Bun**; deps: RD11,RD12; 4 h.
  fileGlobs: `src/lib/rtc-transport*.ts`, `web/lib/rtc-transport*.ts`.
  Acceptance: Authenticated small request/response and backpressure; direct ICE candidate proof. No additional relay change.
- **RD14 / Resume RTC streams and files**; deps: RD9,RD10,RD13; 4 h.
  fileGlobs: `src/lib/rtc-stream*.ts`, `web/lib/rtc-stream*.ts`, `ios/**/RtcLifecycle*`.
  Acceptance: Network restart, ambiguous writes and cursor/chunk recovery; TURN candidate rejects bulk. No additional relay change.
- **RD15 / Verify NAT and phased rollout**; deps: RD14; 4 h.
  fileGlobs: `tests/direct-route*.ts`, `docs/design/direct-rollout.md`.
  Acceptance: Representative network matrix with real evidence, strict-file fallback, fleet rollback drill. Relay signaling activation needs owner button approval.

RD3/RD4/RD7 must be split further if existing storage cannot provide the required atomic semantics within the estimates;
never mark retry safety complete from client tests alone. Shell paths are provisional and must be checked against its actual source tree before implementation.
RD11 may uncover a larger RTC dependency task; halt that branch for re-estimation rather than disguising a multi-day integration as a half-day node.
Deploying relay signaling, STUN/TURN, TLS/ingress services, DNS or machine-wide settings always needs explicit owner approval;
peer or PM consent is not authorization for shared machine infrastructure. This card deploys none of them.

## 6. Deviation from the original plan

The target remains “relay as rendezvous + signaling + fallback”, with direct-only large files.
The **delivery order deviates**: (a)+(c)+(d) precede WebRTC hole punching (b), instead of making generic hole punching the initial path.
Reason: existing authenticated ingress and local-hop can be extended without first proving a Bun RTC runtime,
while dedup and recovery must be solved for every transport. Local measurements do not justify emergency relay bandwidth changes.
This is a proposal for owner decision, not a silently approved replacement of the original plan.

Planning difference: RD1–RD10 sum to 40 engineer-hours; RD11–RD15 add 20 hours, subject to spike results.
Dependency overlap permits some concurrency, but these are not calendar promises. RTC may add more integration work after RD11.
During this interim stage devices with no LAN/approved HTTPS/Tailscale route still use relay for eligible small traffic;
large files remain unavailable until a proven direct route exists. State that limitation at owner review.

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
