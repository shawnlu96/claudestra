# E2E label compatibility

These opt-in adapters are not connected to production routes. Existing invite parsing,
SIGN1 verification, HPKE, DH handshakes, AES-GCM and record primitives remain canonical.
The old labels are byte-for-byte compatible; the new labels are explicitly registered
in `families.ts`. Invitation fields and protocol versions are unchanged.

`parseE2eRename(config)` reads `rename.e2e`. A scalar enables receiving only;
`{ receive, send }` controls each separately. Missing/invalid values are off.
The exchange entry points have no effects in off; observe reports a read-only
compatibility judgment without calling local key generation, transport or persistence.
Pure crypto/context helpers do not implement rollout policy; call them through the
exchange policy boundary, or apply the same policy when integrating peer handshakes.

Receiving uses `authenticateE2eRequest` to verify a complete request signature against
the caller's trusted identity/E2E pin. The immutable context retains the exact signed
body and family; a structural lookalike is rejected. An optional `route` is a trusted
routing result supplied by the adapter, never copied from request JSON or headers.
The signature still covers the complete external path, including a URL base prefix.

Sending defaults to the old family. Switching requires both receive/send on and
a fresh E2E capability signed by the pinned identity over the instance ID, E2E
public key/version and protocol. This capability also promises support for the
corresponding SIGN1 request family. It is separate from the invitation.
Decryption never tries another label family or falls back to plaintext.

`receiveRedeem` needs a read-only canonical invitation/token lookup and an atomic
redemption adapter. The adapter must recheck TTL, revocation, unused state, secret
and identity under its storage lock before consuming the invitation and writing
the peer, reusing the original invitation token. This directory does not implement
storage or replace the existing manager's transaction boundary. A lost race fails;
it never produces another token or retries the mutation.

`joinInvite` sends one sealed, signed request and verifies the sealed response and
original identity/instance/nonce proof before calling `savePeer`. The caller supplies
local keys and trusted remote pins explicitly. Production activation and storage
integration are separate work; no daemon, shared state or guard configuration changes
are needed for these adapters.
