import { randomBytes } from "node:crypto";
import type { Ask } from "../../lib/ledger-asks.js";
import type { HttpPeer } from "../../lib/peers.js";
import { v2ObjectDigest } from "../../lib/shared-ledger-contract-v2-integrity.js";
import { parseV2ProjectRecord, parseV2ProjectsRequest, parseV2ProjectsResponse,
  type V2ProjectInvite, type V2ProjectMember, type V2ProjectRecord } from "../../lib/shared-ledger-contract-v2-projects.js";
import { JOIN_OFFER_PATH, joinOfferProjectDisplay, parseJoinOffer, saveSentOffer } from "../../lib/shared-ledger-join-offer.js";
import { openSharedProjectAction, type ProjectAction } from "./shared-projects-actions.js";
import { requireProjectPerson, SharedProjectsError, type ProjectInviteApproval, type ProjectPerson, type ProjectRecipient, type SharedProjectsPorts } from "./shared-projects-ports.js";

export interface ProjectInvitePorts {
  now: () => number;
  stateDir: string;
  peers: () => Promise<HttpPeer[]>;
  /** Canonical N3 reads use the authenticated owner's original project credential. */
  project: (who: ProjectPerson, projectId: string) => Promise<V2ProjectRecord>;
  members: (who: ProjectPerson, projectId: string) => Promise<V2ProjectMember[]>;
  /** Transport machines never select a person. Preserve both canonical records returned by N3. */
  mint: (who: ProjectPerson, projectId: string, recipient: ProjectRecipient) => Promise<{
    url: string; invite: V2ProjectInvite; member: V2ProjectMember; project: V2ProjectRecord;
  }>;
  post: (peer: HttpPeer, url: string, body: string) => Promise<Response>;
  receiptProject: string;
}
type Minted = Awaited<ReturnType<ProjectInvitePorts["mint"]>>;
interface Prepared { who: ProjectPerson; approval: ProjectInviteApproval; minted: Minted[]; note?: string }
/** Secrets survive across HTTP/answer adapter instances, but never across process restarts. */
const pending = new Map<string, Map<string, Prepared>>();
const fingerprint = (peer: HttpPeer) => v2ObjectDigest(peer);
const unavailable = () => new SharedProjectsError(403, "invitation_changed");

function selectedPeers(names: string[], peers: HttpPeer[]): HttpPeer[] {
  if (!names.length || names.length > 50 || new Set(names).size !== names.length) throw unavailable();
  return names.map(name => {
    const matches = peers.filter(p => p.name === name && !p.disabled && p.baseUrl && p.outToken);
    const peer = matches[0];
    if (matches.length !== 1 || !peer || (!peer.e2e && !peer.baseUrl!.startsWith("https://"))) throw unavailable();
    return structuredClone(peer);
  });
}
async function ownerProject(who: ProjectPerson, projectId: string, d: ProjectInvitePorts) {
  requireProjectPerson(who);
  const scope = { centerId: who.centerId, teamId: who.teamId, projectId };
  const project = parseV2ProjectRecord(await d.project(who, projectId));
  const members = parseV2ProjectsResponse("members", 200, { ok: true, v: 2, ...scope, members: await d.members(who, projectId) }, scope);
  const self = members.ok ? members.members.filter(m => m.personId === who.personId && m.role === "owner" && m.status === "active") : [];
  if (!members.ok || self.length !== 1 || project.centerId !== who.centerId || project.teamId !== who.teamId
    || project.projectId !== projectId || project.status !== "active"
    || !joinOfferProjectDisplay({ teamId: project.teamId, projectId, name: project.name })) throw unavailable();
  return { project, members: members.members };
}
function verifiedMint(value: Minted, who: ProjectPerson, project: V2ProjectRecord, recipient: ProjectRecipient,
  offerId: string, note: string | undefined, now: number): Minted {
  const scope = { centerId: who.centerId, teamId: who.teamId, projectId: project.projectId,
    ...("personId" in recipient ? { personId: recipient.personId } : {}) };
  const result = parseV2ProjectsResponse("invite", 201, { ok: true, v: 2, member: value.member, invite: value.invite }, scope);
  if (!result.ok || v2ObjectDigest(parseV2ProjectRecord(value.project)) !== v2ObjectDigest(project)
    || ("code" in recipient && result.member.code !== recipient.code)) throw unavailable();
  const minted = { url: value.url, project, member: result.member, invite: result.invite };
  if (!parseJoinOffer(invitationWire(offerId, minted, note), now).ok) throw unavailable();
  return minted;
}
function invitationWire(offerId: string, m: Minted, note?: string) {
  const { teamId, projectId, name } = m.project;
  return { v: 1, offerId, url: m.url, code: m.invite.code, expiresAt: m.invite.expiresAt,
    project: { teamId, projectId, name }, projectInvite: m.invite, ...(note ? { note } : {}) };
}

/** Owner selects recipient and transports explicitly; center results pin the recipient before the approval card is opened. */
export async function proposeSharedProjectInvite(who: ProjectPerson, projectId: string, names: string[], note: string | undefined,
  recipient: ProjectRecipient, actions: SharedProjectsPorts, d: ProjectInvitePorts): Promise<{ askId: string }> {
  const request = parseV2ProjectsRequest("invite", { centerId: who.centerId, teamId: who.teamId, projectId, ...recipient });
  recipient = "personId" in request ? { personId: request.personId } : { code: request.code };
  const { project, members } = await ownerProject(who, projectId, d);
  if ("personId" in recipient && !members.some(m => m.personId === recipient.personId && m.status !== "removed")) throw unavailable();
  const targets = selectedPeers(names, await d.peers());
  const store = pending.get(d.stateDir) ?? new Map<string, Prepared>();
  pending.set(d.stateDir, store);
  for (const [id, entry] of store) {
    const ask = actions.getAsk(id);
    if (entry.approval.invitations.some(i => i.expiresAt <= d.now())
      || !ask || ["expired", "cancelled"].includes(ask.state) || ask.extra.sharedProjectExecuted) store.delete(id);
  }
  if (store.size >= 50) throw new SharedProjectsError(429, "too_many_invitation_approvals");
  const minted: Minted[] = [], invitations: ProjectInviteApproval["invitations"] = [];
  for (const _target of targets) {
    const offerId = randomBytes(16).toString("hex");
    const m = verifiedMint(await d.mint(who, projectId, recipient), who, project, recipient, offerId, note, d.now());
    if (minted[0] && minted[0].member.personId !== m.member.personId) throw unavailable();
    minted.push(m); invitations.push({ offerId, digest: v2ObjectDigest(m), expiresAt: m.invite.expiresAt });
  }
  const member = minted.at(-1)!.member;
  const approval: ProjectInviteApproval = { project, recipient, personId: member.personId, member,
    peers: targets.map(p => ({ name: p.name, digest: fingerprint(p) })), noteDigest: v2ObjectDigest(note ?? null), invitations };
  const ask = openSharedProjectAction(actions, { kind: "invite", who, operationId: `invite:${invitations[0]!.offerId}`, invitation: approval },
    `邀请加入团队项目 ${project.name}`, `项目 ${project.projectId}；收件人 ${member.code}（${member.personId}）\n传输机器：${names.join("、")}\n备注摘要：${approval.noteDigest}`);
  if (ask.state !== "open") throw unavailable();
  store.set(ask.id, structuredClone({ who, approval, minted, note }));
  return { askId: ask.id };
}

/** Called only after the common stored-card/approver checks. Recheck revocation, display and transport before one durable claim. */
export async function sendApprovedSharedProjectInvite(who: ProjectPerson, ask: Ask, actions: SharedProjectsPorts, d: ProjectInvitePorts) {
  const prepared = pending.get(d.stateDir)?.get(ask.id);
  const approved = (ask.bind?.params as ProjectAction | undefined)?.invitation;
  if (!prepared || !approved || v2ObjectDigest(approved) !== v2ObjectDigest(prepared.approval)
    || v2ObjectDigest(who) !== v2ObjectDigest(prepared.who) || v2ObjectDigest(prepared.note ?? null) !== approved.noteDigest) throw unavailable();
  const { project, members } = await ownerProject(who, approved.project.projectId, d);
  const recipient = members.filter(m => m.personId === approved.personId && m.status !== "removed");
  if (v2ObjectDigest(project) !== v2ObjectDigest(approved.project) || recipient.length !== 1
    || v2ObjectDigest(recipient[0]) !== v2ObjectDigest(approved.member)) throw unavailable();
  const targets = selectedPeers(approved.peers.map(p => p.name), await d.peers());
  if (targets.some((p, i) => fingerprint(p) !== approved.peers[i]!.digest)
    || approved.invitations.some(i => i.expiresAt <= d.now())) throw unavailable();
  // Re-read after asynchronous center calls; a withdrawal or changed answer cannot race the send.
  const current = actions.getAsk(ask.id);
  if (!current || current.state !== "answered" || v2ObjectDigest(current) !== v2ObjectDigest(ask)
    || !await actions.authorizeAnswer(current) || !actions.claimAsk(current)) throw unavailable();
  pending.get(d.stateDir)?.delete(ask.id);
  return inviteSharedProject(who, approved, targets, prepared, d);
}

/** Codes travel straight from the retained N3 response to the signed/encrypted peer request, never through disk, argv or cards. */
async function inviteSharedProject(who: ProjectPerson, approved: ProjectInviteApproval, targets: HttpPeer[], prepared: Prepared, d: ProjectInvitePorts) {
  const results: { peer: string; offerId: string; accepted: boolean }[] = [];
  for (const [index, peer] of targets.entries()) {
    const { offerId, digest } = approved.invitations[index]!;
    try {
      const m = verifiedMint(prepared.minted[index]!, who, approved.project, approved.recipient, offerId, prepared.note, d.now());
      if (v2ObjectDigest(m) !== digest) throw unavailable();
      const parsed = parseJoinOffer(invitationWire(offerId, m, prepared.note), d.now());
      if (!parsed.ok) throw unavailable();
      const { host, centerId, expiresAt } = parsed.offer;
      await saveSentOffer(d.stateDir, { offerId, peer: peer.name, host, centerId, project: d.receiptProject, target: "", sentAt: d.now(), expiresAt });
      const response = await d.post(peer, `${peer.baseUrl!.replace(/\/+$/, "")}${JOIN_OFFER_PATH}`, JSON.stringify(invitationWire(offerId, m, prepared.note)));
      results.push({ peer: peer.name, offerId, accepted: response.status === 202 });
      await response.body?.cancel().catch(() => undefined); // Only status matters; never read or reflect an arbitrary peer response body.
    } catch {
      // A transport failure may follow delivery; public receipts contain no secret or exception detail.
      results.push({ peer: peer.name, offerId, accepted: false });
    }
  }
  return results;
}
