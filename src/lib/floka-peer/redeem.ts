/** The canonical invitation transaction stays unchanged. Only authenticated encryption labels vary. */
import { keyFingerprint } from "../instance-key.js";
import { checkRequest, peerHeaders } from "./signature.js";
import { peerPolicy } from "./policy.js";
import { peerCapabilities } from "./capability.js";
import type { E2eFamily } from "../floka-compat/e2e/families.js";
import { signRequestFamily } from "../floka-compat/signature/request.js";
import { sealRequest, REDEEM_PATH } from "../floka-compat/e2e/redeem.js";
import { openRedeemRequest, isSealedRedeem } from "../peer-e2e-redeem.js";
import type { LocalE2e } from "../peer-e2e-local.js";
import type { PeerInviteV2 } from "../peers.js";
import { fromB64url } from "../e2e/encoding.js";
export { isPublicKey, keyFingerprint } from "../instance-key.js";
export { peerHeaders } from "./signature.js";

export function trustedRelaySender(req: Request, relayFrom: string) {
  return relayFrom && !peerHeaders(req.headers).present ? { fp: relayFrom, pk: "" } : null;
}
export const invalidRedeemer = (req: Request, sender: { fp: string }): boolean => peerHeaders(req.headers).present && !sender.fp;

const verified = new WeakMap<Request, E2eFamily>();
export function verifyRedeemer(key: string, req: Request, body: Uint8Array, relayFrom = ""): boolean {
  if (relayFrom && keyFingerprint(key) !== relayFrom) return false;
  const u = new URL(req.url), policy = peerPolicy();
  const v = checkRequest(req.headers, { method: req.method, path: u.pathname + u.search, body });
  if (v.status !== "ok" || v.publicKey !== key || (v.family === "floka" && policy.e2e.receive !== "on")) return false;
  verified.set(req, v.family);
  return true;
}

export async function openPeerRedeem(req: Request, local: LocalE2e, raw: unknown) {
  const family = verified.get(req);
  if (!family || !isSealedRedeem(raw)) return null;
  return openRedeemRequest(local.machine.pair, local.fp, raw, family);
}

export async function sealInviteRedeem(invite: PeerInviteV2, local: LocalE2e | null, payload: Record<string, unknown>, config?: unknown) {
  if (!local || !invite.ek) return null;
  const pin = invite.iid && invite.idk ? { instanceId: invite.iid, idk: invite.idk, ek: invite.ek } : null;
  const family = peerCapabilities.family(pin, config, true);
  const sealed = await sealRequest(family, fromB64url(invite.ek.pub)!, invite.fp!, { ...payload, idk: local.key.publicKey, key: local.signed });
  const u = new URL(`${invite.url}${REDEEM_PATH}`), req = { method: "POST", path: u.pathname + u.search, body: JSON.stringify(sealed.body) };
  return { ...sealed, headers: signRequestFamily(family, req, local.key) };
}
