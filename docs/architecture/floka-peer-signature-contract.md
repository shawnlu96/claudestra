# Peer signature compatibility contract (SIGCOMP1)

This contract resolves the `off-mode-tighten` review finding. “Off falls back
completely” means **the existing peer acceptance baseline**, including its
protections. It does not mean that every failed signature becomes anonymous.
A failed request is never resent after deleting signature headers, changing
signature family, or falling back to plaintext within the same call.

## Acceptance matrix

`rename.signature` is the upstream protocol switch. It is distinct from the
recovery key `peerSignatureContract`. A successful signature proves possession
of a key; contact, token ownership, invitation validity, replay and scope checks
still decide authority.

| Headers / verification | signature off | signature observe | signature on |
| --- | --- | --- | --- |
| No signature headers | Existing entry gate | Existing entry gate | Existing entry gate |
| Old family, valid | Existing peer trust | Existing peer trust | Existing peer trust |
| Old family, bad / stale / partial | Original exception only | Original exception only | Reject |
| New family, valid | Reject: family disabled | Reject; existing protocol observation only | Existing peer trust |
| New family, bad / stale / partial | Reject | Reject | Reject |
| Both complete and identical, valid old signature | Existing peer trust | Existing peer trust | Existing peer trust |
| Mixed partial / conflicting / bad / stale | Reject | Reject | Reject |

Both complete identical families are verified once as the old family. A request
containing any new-family header cannot take the old-family failure exception.
An empty or incomplete signature set is a present failed signature, not unsigned.
`signature-contract.ts` centralizes this veto matrix; the existing SIGN1 verifier
remains responsible for cryptography and family enablement.

“Original exception” is only what the receiving path already permitted:

- Direct established peers use `peerSigVerdict`: anchored peers require `ok`;
  unanchored peers can pass only before the existing legacy deadline. At and
  after the deadline even an unanchored valid signature is refused. A failed or
  unsigned request allowed before the deadline remains `legacy`, never verified.
- The default deadline remains `2026-11-01T00:00:00Z`. Its existing
  `PEER_LEGACY_DEADLINE` configuration and cache semantics are unchanged. This
  card does not set, extend, reset or replace that deadline.
- Invitation previews still require a live invitation and GET/HEAD. Their old
  off/observe compatibility path does not authorize POST or an expired invite.
  Redemption keeps its existing invitation expiry and legacy identity checks.
- Relay admission and E2E signature checks remain strict, even for old-family
  failures. The direct-peer exception is not exported to these paths.
- Unsigned requests keep their original entry permissions. The family veto
  returning false is **not** authentication or permission to enter.

## Recovery and observations

The permission-class recovery key is
`projects.claude-orchestrator.keys.peerSignatureContract` in
`recovery-policy.json`. Its unconfigured default is **observe**; explicit
project/key modes follow the shared recovery policy precedence. Invalid policy
files select off. The key is read on each decision; changing it needs no restart.

| Recovery mode | Business decision | New contract observations |
| --- | --- | --- |
| off | Current baseline | None |
| observe | Current baseline | Only differing allow / legacy / reject outcomes |
| on | Contract intersected with current baseline | None |

The confirmed contract deliberately agrees with today's protected baseline.
Zero differences are expected for the covered matrix; there is no manufactured
policy tightening just to produce samples. The baseline intersection ensures
that an originally denied request cannot become allowed. Observation records
contain bounded family/mode/outcome categories only, are throttled, and contain
no headers, keys, bodies, URLs, tokens or caller-controlled error text. Existing
`rename.signature=observe` protocol logs are independent of contract-difference
logs and retain their original behavior.

The recovery key never enables `rename.signature`, `peerRelayInbound`, or E2E
receive/send. Their existing switches can still reject a request. Nor does it
change outgoing signing, retry handling, pins, capability lifetimes or encryption.
A capability hint can be retired for a **later independent call**; that is not
permission to retry the failed call anonymously or in another family. Existing
bounded same-family E2E session recovery is distinct from signature failure.

Observe for at least 24 hours. PM must review actual difference samples (if any),
false positives/negatives and isolated positive/negative exercises before:

```sh
ledger scheduler-recovery claude-orchestrator on \
  --key peerSignatureContract --reason '<PM approval and evidence>'
```

Observe another 24 hours after enabling. Immediate rollback:

```sh
ledger scheduler-recovery claude-orchestrator off \
  --key peerSignatureContract --reason '<incident and evidence>'
```

This delivery does not change production modes or claim the observation period
has elapsed.

## Regression evidence

`tests/floka-peer-signature-contract.test.ts` exercises actual Ed25519 checks,
old/new/identical-mixed headers, bad/stale/partial inputs, all three protocol and
recovery modes, anchors, deadline minus one / equal / plus one milliseconds,
live recovery-file changes and corrupt-file rollback. Direct and invitation
entry checks, relay forwarding counters, E2E family selection and outgoing
signing/recovery boundaries check that failed requests do not gain authority or
trigger another send. Existing `tests/floka-peer.test.ts` additionally exercises
three-instance rolling upgrades, real E2E sessions and invitation redemption.

At baseline `cc037eab`, the initial regression run had 0 pass / 2 fail:
`peerSignatureContract` returned off (unknown key) instead of the required
observe default, and the explicit matrix module was absent. These are contract
registration/API failures, not a claim that the baseline already allowed new
invalid signatures. The established old-off exception and new-family refusal
are intentionally preserved, not “fixed” by tightening old peers.
