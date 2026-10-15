# Peer protocol rollout

Production adapters read `config.json` through the existing config store. Missing or
invalid values are off. No environment variable, identity file or peer schema is added.

```json
{
  "rename": {
    "signature": "off",
    "peerRequestSend": "off",
    "peerRelayInbound": "off",
    "e2e": { "receive": "off", "send": "off" }
  }
}
```

- `signature=off` retains legacy `peerSigVerdict` behavior: unanchored old peers
  with bad/stale signatures remain legacy until `PEER_LEGACY_DEADLINE`; invalid
  old signatures on direct non-E2E invite redemption retain anonymous handling.
  `observe` makes the same decision and reports that on would reject the request.
  `on` rejects any present invalid signature without an anonymous exception.
  New-family failures and conflicting families never use legacy exceptions.
- `peerRelayInbound` additionally gates new signatures arriving through the relay.
  RELAY1 owns source-marker parsing and stripping. Invalid markers never acquire
  the peer ingress loopback device-cookie exception.
- New E2E handshakes require both `e2e.receive=on` and `signature=on`, before key pin
  updates or session creation. Each session retains its authenticated record label.
- New ordinary request signatures require `peerRequestSend=on`, `signature=on` and
  a current signed capability matching the pinned instance ID and identity key.
- New E2E sends additionally require both E2E switches on and the E2E capability
  bound to the pinned encryption key and version. Unknown or expired capabilities
  select legacy before sending. Failure after sending never triggers another family
  or a plaintext/anonymous retry. Legacy same-family session-reset behavior remains;
  a new-family signature/session rejection terminates the current call immediately.

Capability proofs are optional extensions of the legacy hello response. They use
SIGN1/E2E1's signed capability formats and are advertised only when signature and
relay reception are on. E2E capability additionally requires E2E reception on.
They are checked against trusted peer pins, never learned from untrusted identity
claims. Off does not learn them; observe reports without retaining them. The bounded
cache is memory-only; a process restart returns to legacy until a fresh handshake
authenticates capability again. A new-family send rejected with a signature/session
401 or relay `bad_signature` retires only that pin's capabilities. The current call
fails without retry; the next independent call selects legacy and can learn fresh
signed capabilities during hello. Old-family rejections, token/scope failures,
network errors, timeouts and 5xx responses do not clear capabilities. These hints
are not delivery evidence: an unauthenticated refusal can retire a capability but
cannot prove whether an application request ran. Both families retain the same
pinned identity, encryption and permission requirements.

Invitations keep their original URL, instance ID, fingerprint, key, secret and token.
The canonical redemption manager still enforces expiry, revocation and consumption.
Old invitations need no reissue. Only labels change; encrypted response authentication
must succeed before the existing join flow writes peer state.

`tests/floka-peer.test.ts` exercises all six three-instance upgrade orders with a
fake direct/relay network, real cryptography, production routing adapters and state
hashes. Production peer connections and rollout switches are not changed by this
work. Separate receive/send activation and the 24-hour observation remain PM tasks.
