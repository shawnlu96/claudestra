import { parseV2ProjectInvite, type V2ProjectInvite } from "../../lib/shared-ledger-contract-v2-projects.js";
import { randomBytes } from "node:crypto";
import type { HttpPeer } from "../../lib/peers.js";
import { JOIN_OFFER_PATH, parseJoinOffer, saveSentOffer, type JoinOfferProject } from "../../lib/shared-ledger-join-offer.js";
import { requireProjectPerson, SharedProjectsError, type ProjectPerson } from "./shared-projects-ports.js";

export interface ProjectInvitePorts {
  now: () => number;
  stateDir: string;
  peers: () => Promise<HttpPeer[]>;
  /** N3 must authenticate the center transport and parse its response; JSON shape alone is not identity proof.
   * Resolve the recipient identity from verified peer/center state. Never derive a personId from the caller's JSON or display name. */
  mint: (who: ProjectPerson, projectId: string, peer: HttpPeer) => Promise<{ url: string; invite: V2ProjectInvite; project: JoinOfferProject }>;
  post: (peer: HttpPeer, url: string, body: string) => Promise<Response>;
  receiptProject: string;
}

/** The join code travels from the N3 response straight to the peer request, never through files, argv, cards or errors. */
export async function inviteSharedProject(who: ProjectPerson, projectId: string, names: string[], note: string | undefined, d: ProjectInvitePorts) {
  requireProjectPerson(who);
  const peers = await d.peers();
  const targets = names.map(name => peers.find(p => p.name === name && !p.disabled && p.baseUrl && p.outToken));
  if (targets.some(p => !p || (!p.e2e && !p.baseUrl!.startsWith("https://")))) throw new SharedProjectsError(403, "configured_encrypted_peer_required");
  const results: { peer: string; offerId: string; accepted: boolean }[] = [];
  for (const peer of targets as HttpPeer[]) {
    const offerId = randomBytes(16).toString("hex");
    try {
      const minted = await d.mint(who, projectId, peer);
      const invite = parseV2ProjectInvite(minted.invite);
      const wire = { v: 1, offerId, url: minted.url, code: invite.code, expiresAt: invite.expiresAt, project: minted.project, projectInvite: invite, ...(note ? { note } : {}) };
      const parsed = parseJoinOffer(wire, d.now());
      if (!parsed.ok || parsed.offer.centerId !== who.centerId || minted.project.teamId !== who.teamId || minted.project.projectId !== projectId) {
        throw new SharedProjectsError(503, "invite_response_mismatch");
      }
      const { host, centerId, expiresAt } = parsed.offer;
      await saveSentOffer(d.stateDir, { offerId, peer: peer.name, host, centerId, project: d.receiptProject, target: "", sentAt: d.now(), expiresAt });
      const response = await d.post(peer, `${peer.baseUrl!.replace(/\/+$/, "")}${JOIN_OFFER_PATH}`, JSON.stringify(wire));
      results.push({ peer: peer.name, offerId, accepted: response.status === 202 });
      await response.body?.cancel().catch(() => undefined); // Only status matters; never read or reflect a peer's arbitrary response body.
    } catch {
      // Each target may have received its invitation even after a transport failure; return no secret or exception detail.
      results.push({ peer: peer.name, offerId, accepted: false });
    }
  }
  return results;
}
