/**
 * Peer-only routes for shared-ledger join offers (bridge/shared-ledger-join-offer.ts):
 *   POST /api/v1/shared-ledger-join-offer          {v:1, offerId, url, code, note?, expiresAt?} → 202 (stored + card) — not "joined"
 *   POST /api/v1/shared-ledger-join-offer/receipt  {v:1, offerId, status: joined|declined|expired|failed} → 200
 * Registered in api-routes before the generic auth so that every non-peer caller — no token, a revoked one, a device, an owner
 * token, a peer we no longer have configured — gets one 403. Peer auth itself (signature, E2E, replay) is authenticateApi unchanged.
 */
import type { Principal } from "../../lib/principals.js";
import { readBoundedRequestBody, RequestBodyError } from "../../lib/request-body.js";
import { JOIN_OFFER_PATH, JOIN_OFFER_RECEIPT_PATH } from "../../lib/shared-ledger-join-offer.js";
import { authenticateApi } from "../api-auth.js";
import { apiJson } from "../api-respond.js";
import { configuredPeer, joinOfferLiveDeps, receiveJoinOffer, receiveJoinOfferReceipt, type JoinOfferDeps } from "../shared-ledger-join-offer.js";

const BODY_CAP = 4096;
const PEERS_ONLY = { ok: false, code: "peer_only", error: "only configured HTTP peers may use this route" };

export interface JoinOfferRouteDeps extends JoinOfferDeps {
  auth: (req: Request, url: URL) => Promise<Principal | Response>;
}
const live: JoinOfferRouteDeps = { ...joinOfferLiveDeps, auth: (req, url) => authenticateApi(req, url, { rateLimit: true }) };

export async function handleJoinOfferApi(req: Request, url: URL, d: JoinOfferRouteDeps = live): Promise<Response | null> {
  const receipt = url.pathname === JOIN_OFFER_RECEIPT_PATH;
  if (url.pathname !== JOIN_OFFER_PATH && !receipt) return null;
  const who = await d.auth(req, url);
  if (who instanceof Response) return who.status === 429 ? who : apiJson(403, PEERS_ONLY);
  const peer = await configuredPeer(who.peer, d);
  if (!peer) return apiJson(403, PEERS_ONLY);
  if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await readBoundedRequestBody(req, BODY_CAP)));
  } catch (e) {
    // Fixed answers only: a parse error message would quote the body, and the body holds the code.
    return apiJson(e instanceof RequestBodyError ? e.status : 400, { ok: false, code: "invalid_body" });
  }
  const r = receipt ? await receiveJoinOfferReceipt(peer, body, d) : await receiveJoinOffer(peer, body, d);
  return apiJson(r.status, r.body);
}
