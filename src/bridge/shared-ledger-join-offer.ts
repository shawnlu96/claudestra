/**
 * Shared-ledger join offers inside the bridge (lib/shared-ledger-join-offer.ts holds the pure parts).
 *   Receiver: a configured peer POSTs an offer → memory pending offer → authorize card for the owner. "加入" + ask-check →
 *   joinSharedLedger (subject owner:self) → inform the owner → receipt to the inviter. "不加入", expiry or failure discard the credential.
 *   Sender: the receipt from that same peer marks our sent record and becomes a ledger note.
 * Every message here is fixed wording (lib joinOfferCard / joinOfferOutcomeText); the code and center responses never reach them.
 */
import { createHash } from "node:crypto";
import { readProjects } from "../lib/projects.js";
import { isPersonalProject } from "../lib/lend-policy.js";
import { projectChoices as makeProjectChoices, selectedProject, sharedProjectCardDigest } from "./local-api/shared-projects-choice.js";
import type { ProjectChoice } from "./local-api/shared-projects-choice.js";
import type { ProjectSelection } from "./local-api/shared-projects-ports.js";
import { bindHash, checkAsk } from "../lib/ask-bind.js";
import { instanceIdSync } from "../lib/instance-id.js";
import { instanceKeySync, signedFor } from "../lib/instance-key.js";
import { closeAsk, getAsk, listAsks, patchAsk, MASTER_PROJECT, ownerAnswered, type Ask, type AskBind } from "../lib/ledger-asks.js";
import { STATE_DIR } from "../lib/paths.js";
import { readPeers, type HttpPeer } from "../lib/peers.js";
import { runManagerProcess } from "../lib/run-manager.js";
import {
  readSharedLedgerLocalProjects, sharedLedgerProjectChoices, sharedLedgerOfferBinding, sharedLedgerEligibleProjects, type SharedLedgerLocalProject,
  type SharedLedgerOfferProject,
} from "../lib/shared-ledger-local-project.js";
import { readSharedLedgerBindings, type SharedLedgerBinding } from "../lib/shared-ledger-gate-bindings.js";
import { sweepSharedLedgerRebinds, onSharedLedgerRebindAnswered, liveRebindDeps } from "./shared-ledger-rebind.js";
import { onSharedProjectAnswered } from "./local-api/shared-projects-runtime.js";
import { sharedProjectAnswerPrincipal } from "./local-api/shared-projects-auth.js";
import { enrollSharedProject } from "./local-api/shared-projects-enrollment.js";
import { joinSharedLedger, type SharedLedgerJoinResult } from "../lib/shared-ledger-join.js";
import {
  attachPendingOfferAsk, claimPendingOffer, isJoinOfferStatus, isOfferId, JOIN_OFFER_RECEIPT_PATH, JoinOfferLimiter, joinOfferCard, joinOfferOutcomeText,
  listPendingOfferIds, parseJoinOffer, readPendingOffer, receiptNoteText, recordSentOfferStatus, savePendingOffer,
  type JoinOfferProject, type JoinOfferRecipient, type JoinOfferStatus, type PendingJoinOffer, type SentJoinOffer,
} from "../lib/shared-ledger-join-offer.js";
import { askDb, askReadDb, asksDeps, createAsk, publishAsk, type CreateAskInput } from "./asks.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";
import { newMessageId, newThreadId } from "./router.js";

/** createdBy of the authorize cards; also the "agent" the bind hash is computed for, since system asks have no fromAgent. */
const JOIN_OFFER_CREATOR = "system:shared-ledger-join-offer";
const BIND_ACTION = "shared_ledger_join";
export const JOIN_BUTTON = "sl_join_accept";
export const DECLINE_BUTTON = "sl_join_decline";

/** Recipient comes from the canonical center invite carried by the verified signed peer offer, before redemption. */
export type JoinOfferExpectedProject = JoinOfferProject & Pick<JoinOfferRecipient, "personId"> & { centerId: string; instanceId?: string };
export interface JoinOfferDeps {
  stateDir: () => string;
  now: () => number;
  peers: () => Promise<HttpPeer[]>;
  openAsk: (input: CreateAskInput) => Ask;
  getAsk: (id: string) => Ask | null;
  closeAsk: (id: string) => void;
  /** Durable cards only; credentials remain solely in the process memory store. */
  listOrphanCandidates?: () => Ask[];
  claimOrphan?: (ask: Ask) => boolean;
  markSettled?: (askId: string) => void;
  projects: () => Promise<SharedLedgerLocalProject[]>;
  /** The shared project this offer explicitly names, when known; the card hint then needs an exact binding (none: old-offer inference). */
  sharedProject?: (centerId: string) => SharedLedgerOfferProject | string | undefined;
  bindings?: () => SharedLedgerBinding[];
  join: (url: string, code: string, localProjectId: string) => Promise<SharedLedgerJoinResult>;
  /** N2 must verify displayed center/team/project/person and the signed receiving instance before saving credentials or bindings. No old-join fallback. */
  joinProject?: (url: string, code: string, selection: ProjectSelection, expected: JoinOfferExpectedProject) => Promise<SharedLedgerJoinResult>;
  /** Runtime rechecks the stored answer and the actual effective owner credential, without requiring a prior center grant. */
  authorizeProjectAnswer?: (ask: Ask) => Promise<boolean>;
  /** The inform card: a notification to the owner (no buttons). */
  inform: (text: string) => Promise<void>;
  /** POST the receipt to the inviter; resolves with the HTTP status. */
  sendReceipt: (peer: HttpPeer, body: string) => Promise<number>;
  /** Sender side: append the receipt as a ledger note. */
  writeNote: (sent: SentJoinOffer, text: string) => Promise<void>;
}

const limiter = new JoinOfferLimiter();
const activeOffers = new Set<string>();
const receiptLimiter = new JoinOfferLimiter(60);
type Reply = { status: number; body: Record<string, unknown> };
const refuse = (status: number, code: string): Reply => ({ status, body: { ok: false, code } });

/** The inbound principal's peer name → its enabled, fully handshaken record; anything else is not a configured peer. */
export async function configuredPeer(name: string | undefined, d: Pick<JoinOfferDeps, "peers">): Promise<HttpPeer | null> {
  if (!name || name.startsWith("invite:")) return null;
  return (await d.peers()).find((p) => p.name === name && !p.disabled && !!p.baseUrl && !!p.outToken) ?? null;
}

const bindOf = (p: PendingJoinOffer): Omit<AskBind, "paramsHash"> => ({
  action: BIND_ACTION, approve: p.project ? [JOIN_BUTTON] : p.projectChoices?.map(c => c.button) ?? [JOIN_BUTTON],
  params: { offerId: p.offerId, peer: p.peer, host: p.host, centerId: p.centerId, expiresAt: p.expiresAt,
    approvalCardDigest: p.approvalCardDigest, project: p.project, recipient: p.recipient, inviteDigest: p.inviteDigest,
    projectOptions: p.projectOptions, recommended: p.recommended, projectChoices: p.projectChoices,
    sharedProjectId: p.sharedProjectId, codeHash: createHash("sha256").update(p.code).digest("hex") },
});

/** POST /api/v1/shared-ledger-join-offer from peer `peerName` (already authenticated as a configured peer). */
export async function receiveJoinOffer(peer: HttpPeer, body: unknown, d: JoinOfferDeps): Promise<Reply> {
  const now = d.now();
  if (!limiter.tryAcquire(peer.name, now)) return refuse(429, "rate_limited");
  const parsed = parseJoinOffer(body, now);
  if (!parsed.ok) return refuse(400, parsed.error);
  let projects: SharedLedgerLocalProject[], bindings: SharedLedgerBinding[], hint: SharedLedgerBinding | undefined;
  try {
    bindings = d.bindings?.() ?? [];
    const explicit = parsed.offer.project ?? d.sharedProject?.(parsed.offer.centerId);
    hint = sharedLedgerOfferBinding(parsed.offer.centerId, bindings, typeof explicit === "string" ? { projectId: explicit } : explicit);
    projects = await d.projects();
  } catch (e) {
    console.error(`⚠️ [join-offer] 本机项目状态不可用: ${(e as Error).name}`);
    return refuse(503, "local_project_state_unavailable");
  }
  const sharedProjectId = hint?.projectId;
  const target = hint ? { centerId: hint.centerId, teamId: hint.teamId, projectId: hint.projectId } : undefined;
  const projectChoices = sharedLedgerProjectChoices(sharedLedgerEligibleProjects(projects, bindings, target), sharedProjectId, JOIN_BUTTON, JOIN_BUTTON);
  if (!parsed.offer.project && !projectChoices.length) return refuse(409, "no_local_projects");
  const pending: PendingJoinOffer = { ...parsed.offer, peer: peer.name, receivedAt: now, projectChoices, sharedProjectId };
  const selection = pending.project ? makeProjectChoices(pending.project, projects, bindings) : undefined;
  if (selection) { pending.projectOptions = selection.choices; pending.recommended = selection.recommended; }
  const saved = await savePendingOffer(d.stateDir(), pending);
  if (saved !== "ok") return refuse(saved === "exists" ? 409 : 429, saved === "exists" ? "duplicate_offer" : "too_many_pending");
  let ask: Ask;
  try {
    const card = joinOfferCard(pending);
    const context = pending.project ? `${card.context}\n请选择新建或已有本机项目，然后点加入。` : `${card.context}\n${sharedProjectId ? `共享项目（根据已有绑定）：${sharedProjectId}` : "入组后才能确定团队 / 共享项目"}\n请选择要绑定的本机项目`;
    const buttons = projectChoices.map(c => ({ id: c.button,
      label: `加入并绑到 ${c.name.slice(0, 60)}${c.localProjectId === sharedProjectId ? "（同名）" : ""}`, style: "success" }));
    const options: Ask["options"] = [...(selection ? [selection.row] : []), { type: "buttons",
        buttons: [...(selection ? [{ id: JOIN_BUTTON, label: "加入", style: "success" }] : buttons), { id: DECLINE_BUTTON, label: "不加入", style: "secondary" }] }];
    if (pending.project) pending.approvalCardDigest = sharedProjectCardDigest({ title: card.title, context, options });
    const bind = bindOf(pending);
    ask = d.openAsk({
      source: "system", createdBy: JOIN_OFFER_CREATOR, kind: "authorize", project: MASTER_PROJECT, ...card, context,
      options,
      allowText: false, blocking: true, expiresAt: pending.expiresAt, dedupKey: `sl-join-offer:${pending.offerId}`,
      bind: { ...bind, paramsHash: bindHash(bind, JOIN_OFFER_CREATOR) }, extra: { joinOfferId: pending.offerId,
        ...(selection ? { sharedProjectChoice: { selectId: "shared_project_local", recommended: selection.recommended } } : {}) },
    });
  } catch (e) {
    claimPendingOffer(d.stateDir(), pending.offerId);
    console.error(`⚠️ [join-offer] 给 owner 开授权卡失败，邀请已删除: ${(e as Error).name}`);
    return refuse(503, "ask_unavailable");
  }
  if (ask.state !== "open") {
    claimPendingOffer(d.stateDir(), pending.offerId);
    return refuse(409, "duplicate_offer");
  }
  attachPendingOfferAsk(d.stateDir(), pending.offerId, ask.id, pending.approvalCardDigest);
  console.log(`🤝 [join-offer] 收到 ${peer.name} 的共享台账邀请（中心 ${pending.host}），已开授权卡 ${ask.id}`);
  return { status: 202, body: { ok: true, accepted: true, offerId: pending.offerId } };
}

/** "加入" counts only if ask-check passes for the card we opened (same params) and the owner — not a guest — answered. */
function approved(a: Ask, p: PendingJoinOffer): boolean {
  const asked = { ...a, fromAgent: JOIN_OFFER_CREATOR };
  return !!a.bind && bindHash(a.bind, JOIN_OFFER_CREATOR) === a.bind.paramsHash && ownerAnswered(a.answer)
    && checkAsk(asked, bindHash(bindOf(p), JOIN_OFFER_CREATOR), JOIN_OFFER_CREATOR).ok;
}

/** Settle one claimed offer: tell the owner, tell the inviter. Neither failure undoes the outcome. */
async function settle(p: PendingJoinOffer, status: JoinOfferStatus, d: JoinOfferDeps, joined?: SharedLedgerJoinResult): Promise<void> {
  if (p.askId) d.markSettled?.(p.askId);
  if (status === "joined" && sharedProjectAudit) await sharedProjectAudit().catch(() => console.warn("shared project audit deferred"));
  console.log(`🤝 [join-offer] ${p.peer} 的邀请（中心 ${p.host}）：${status}`);
  await d.inform(joinOfferOutcomeText(p, status, joined)).catch((e: Error) => console.error(`⚠️ [join-offer] 通知 owner 失败: ${e.name}`));
  const peer = await configuredPeer(p.peer, d);
  if (!peer) return console.warn(`⚠️ [join-offer] ${p.peer} 已不是可用的 peer，回执（${status}）没发`);
  try {
    const code = await d.sendReceipt(peer, JSON.stringify({ v: 1, offerId: p.offerId, status }));
    if (code >= 300) console.warn(`⚠️ [join-offer] 回执（${status}）发给 ${p.peer}，对方回 ${code}`);
  } catch (e) {
    console.warn(`⚠️ [join-offer] 回执（${status}）没发到 ${p.peer}: ${(e as Error).name}`); // Transport text may echo URLs; name only.
  }
}

/** Hook after any ask answer (ask-entry.ts commitNoticing): acts only on our own cards once they are answered. */
export async function onJoinOfferAnswered(a: Ask, d: JoinOfferDeps = liveDeps): Promise<void> {
  const offerId = a.extra.joinOfferId;
  if (a.createdBy !== JOIN_OFFER_CREATOR) {
    await onSharedProjectAnswered(a, d.inform);
    if (!sharedProjectAudit) await onSharedLedgerRebindAnswered(a, liveRebindDeps(d.inform));
    return;
  }
  if (a.state !== "answered" || !isOfferId(offerId)) return;
  const stateDir = d.stateDir(), activeId = `${stateDir}:${offerId}`;
  const p = claimPendingOffer(stateDir, offerId);
  if (!p) { await sweepOrphanJoinCards(d, [a]); return; }
  p.askId ??= a.id;
  activeOffers.add(activeId);
  try { await answerClaimedOffer(a, p, d); }
  finally { activeOffers.delete(activeId); }
}
async function answerClaimedOffer(a: Ask, p: PendingJoinOffer, d: JoinOfferDeps): Promise<void> {
  if (p.project) return answerProjectOffer(a, p, d);
  if (!p.projectChoices) {
    const declined = (a.answer?.choices ?? []).includes(`[button:${DECLINE_BUTTON}]`);
    return settle(p, declined ? "declined" : "failed", d);
  }
  const choice = p.projectChoices.filter(c => (a.answer?.choices ?? []).includes(`[button:${c.button}]`));
  if (!choice?.length) return settle(p, "declined", d);
  if (p.expiresAt <= d.now()) return settle(p, "expired", d);
  if (choice.length !== 1 || !approved(a, p) || !(await d.projects()).some(c => c.id === choice[0]!.localProjectId)) {
    return settle(p, "failed", d);
  }
  let joined: SharedLedgerJoinResult;
  try {
    joined = await d.join(p.url, p.code, choice[0]!.localProjectId);
  } catch {
    return settle(p, "failed", d); // SharedLedgerJoinError text is fixed, but nothing of it is needed: the card says "failed" only.
  }
  return settle(p, "joined", d, joined);
}

/** New project offers never call the legacy join path, which could save a mismatched grant before we inspect it. */
async function answerProjectOffer(a: Ask, p: PendingJoinOffer, d: JoinOfferDeps): Promise<void> {
  const wires = a.answer?.choices ?? [];
  if (wires.includes(`[button:${DECLINE_BUTTON}]`) && !wires.includes(`[button:${JOIN_BUTTON}]`)) return settle(p, "declined", d);
  if (p.expiresAt <= d.now()) return settle(p, "expired", d);
  const selection = selectedProject(wires, (p.projectOptions ?? []) as ProjectChoice[]);
  if (p.approvalCardDigest !== sharedProjectCardDigest(a)) return settle(p, "failed", d);
  if (!selection || !p.recipient || !p.inviteDigest || !approved(a, p) || !d.joinProject) return settle(p, "failed", d);
  try {
    if (d.authorizeProjectAnswer && !await d.authorizeProjectAnswer(a)) return settle(p, "failed", d);
    if (selection.mode === "existing" && (!(await d.projects()).some(c => c.id === selection.localProjectId)
      || (d.bindings?.() ?? []).some(b => (b.localProjectId ?? b.projectId) === selection.localProjectId))) return settle(p, "failed", d);
    const joined = await d.joinProject(p.url, p.code, selection, { ...p.project!, centerId: p.centerId, personId: p.recipient.personId,
      ...(p.recipient.instanceId !== null ? { instanceId: p.recipient.instanceId } : {}) });
    if (joined.centerId !== p.centerId || joined.teamId !== p.project!.teamId || joined.projectId !== p.project!.projectId || joined.personId !== p.recipient.personId || joined.kind !== "person") {
      return settle(p, "failed", d);
    }
    return settle(p, "joined", d, joined);
  } catch {
    return settle(p, "failed", d); // Grant/transport errors must never enter the card, log or receipt.
  }
}

/** Every minute: expired offers (or ones whose card closed without an answer) are deleted; answered ones the hook missed are settled. */
export async function sweepJoinOffers(d: JoinOfferDeps = liveDeps): Promise<void> {
  await sweepOrphanJoinCards(d);
  for (const id of listPendingOfferIds(d.stateDir())) {
    const p = readPendingOffer(d.stateDir(), id);
    const a = p?.askId ? d.getAsk(p.askId) : null;
    if (p && a?.state === "answered") {
      await onJoinOfferAnswered(a, d);
      continue;
    }
    // Unreadable ask (no ledger right now) is not "closed": only time or a closed card retires an offer.
    if (p && p.expiresAt > d.now() && (!a || a.state === "open")) continue;
    const claimed = claimPendingOffer(d.stateDir(), id);
    if (!claimed) continue;
    if (a?.state === "open") d.closeAsk(a.id);
    await settle(claimed, "expired", d);
  }
}

/** Restart discards codes; retire their durable cards and send a fixed failure receipt using only bound routing metadata. */
async function sweepOrphanJoinCards(d: JoinOfferDeps, candidates = d.listOrphanCandidates?.() ?? []): Promise<void> {
  for (const a of candidates) {
    const offerId = a.extra.joinOfferId;
    if (a.createdBy !== JOIN_OFFER_CREATOR || !isOfferId(offerId) || a.extra.joinOfferOrphanSettled
      || activeOffers.has(`${d.stateDir()}:${offerId}`) || readPendingOffer(d.stateDir(), offerId) || !a.bind || bindHash(a.bind, JOIN_OFFER_CREATOR) !== a.bind.paramsHash) continue;
    const params = a.bind.params as { offerId?: unknown; peer?: unknown };
    if (params.offerId !== offerId || typeof params.peer !== "string") continue;
    const peer = await configuredPeer(params.peer, d);
    if (readPendingOffer(d.stateDir(), offerId) || activeOffers.has(`${d.stateDir()}:${offerId}`) || !d.claimOrphan?.(a)) continue;
    d.closeAsk(a.id);
    await d.inform("邀请已失效，请邀请方重新发起。").catch(() => console.warn("join offer restart notice failed")); // A failed notice must not prevent the inviter receipt.
    if (!peer) continue;
    try { await d.sendReceipt(peer, JSON.stringify({ v: 1, offerId, status: "failed" })); }
    catch { console.warn("join offer restart failure receipt deferred"); } // Retired cards cannot redeem; transport details may contain credentials.
  }
}

/** POST /api/v1/shared-ledger-join-offer/receipt from `peer`: only for an offer we sent to that peer; becomes a ledger note once. */
export async function receiveJoinOfferReceipt(peer: HttpPeer, body: unknown, d: JoinOfferDeps): Promise<Reply> {
  if (!receiptLimiter.tryAcquire(peer.name, d.now())) return refuse(429, "rate_limited");
  const b = body as Record<string, unknown> | null;
  const keys = b && typeof b === "object" && !Array.isArray(b) ? Object.keys(b) : null;
  if (!keys || keys.some((k) => !["v", "offerId", "status"].includes(k)) || b!.v !== 1 || !isOfferId(b!.offerId) || !isJoinOfferStatus(b!.status)) {
    return refuse(400, "invalid_receipt");
  }
  const r = await recordSentOfferStatus(d.stateDir(), peer.name, b!.offerId, b!.status, d.now());
  if (!r.ok) return refuse(404, "unknown_offer");
  if (!r.duplicate) {
    await d.writeNote(r.sent, receiptNoteText(r.sent, b!.status)).catch((e: Error) => console.error(`⚠️ [join-offer] 回执写台账失败: ${e.message.slice(0, 200)}`));
  }
  return { status: 200, body: { ok: true, duplicate: r.duplicate } };
}

const liveDeps: JoinOfferDeps = {
  stateDir: () => STATE_DIR,
  now: () => Date.now(),
  peers: async () => (await readPeers()).httpPeers ?? [],
  openAsk: (input) => createAsk(input),
  getAsk: (id) => {
    const db = askReadDb();
    return db ? getAsk(db, id) : null;
  },
  listOrphanCandidates: () => {
    const db = askReadDb();
    return db ? listAsks(db, { source: "system", states: ["open"] }).filter(a => a.createdBy === JOIN_OFFER_CREATOR && !a.extra.joinOfferOrphanSettled) : [];
  },
  markSettled: id => { patchAsk(askDb(), id, { extra: { joinOfferOrphanSettled: true } }); },
  claimOrphan: a => {
    const db = askDb();
    return db.transaction(() => {
      const current = getAsk(db, a.id);
      if (!current || current.extra.joinOfferOrphanSettled || !current.bind || !a.bind
        || current.bind.paramsHash !== a.bind.paramsHash || bindHash(current.bind, JOIN_OFFER_CREATOR) !== current.bind.paramsHash
        || !["open", "answered"].includes(current.state)) return false;
      patchAsk(db, a.id, { extra: { joinOfferOrphanSettled: true } });
      return true;
    }).immediate();
  },
  closeAsk: (id) => {
    const a = closeAsk(askDb(), id, "cancelled", "join offer expired");
    if (a) publishAsk(a);
  },
  projects: async () => {
    const [{ projects }, local] = await Promise.all([readProjects(), readSharedLedgerLocalProjects()]);
    const eligible = new Set(projects.filter(p => !isPersonalProject(p)).map(p => p.id));
    return local.filter(p => eligible.has(p.id));
  },
  bindings: () => readSharedLedgerBindings(),
  authorizeProjectAnswer: async a => {
    const db = askReadDb(), stored = db ? getAsk(db, a.id) : null;
    if (!stored || stored.state !== "answered" || stored.createdBy !== JOIN_OFFER_CREATOR || !stored.bind || !a.bind
      || stored.bind.paramsHash !== a.bind.paramsHash || bindHash(stored.bind, JOIN_OFFER_CREATOR) !== bindHash(a.bind, JOIN_OFFER_CREATOR)
      || JSON.stringify(stored.answer) !== JSON.stringify(a.answer)) return false;
    return !!await sharedProjectAnswerPrincipal(stored, STATE_DIR);
  },
  joinProject: (url, code, selection, expected) => enrollSharedProject(url, code, selection, expected),
  join: (url, code, localProjectId) => {
    const key = instanceKeySync();
    const instanceId = instanceIdSync();
    if (!key || !instanceId) return Promise.reject(new Error("instance key unavailable"));
    return joinSharedLedger({ url, code, key, instanceId, subject: "owner:self", localProjectId });
  },
  inform: async (text) => {
    const d = asksDeps();
    if (!d) return;
    const meta = { messageId: newMessageId("ask"), triggerKind: "bridge_synth" as const, ts: new Date().toISOString(), threadId: newThreadId() };
    await d.deliver({ from: { kind: "bridge", label: "join-offer" }, to: { kind: "user", userId: "", channelId: d.controlChannelId }, intent: "notification", content: text, meta });
  },
  sendReceipt: async (peer, body) => {
    const { peerFetch } = await import("./relay-link.js");
    const url = `${peer.baseUrl!.replace(/\/+$/, "")}${JOIN_OFFER_RECEIPT_PATH}`;
    const headers = { Authorization: `Bearer ${peer.outToken}`, "Content-Type": "application/json", ...signedFor("POST", url, body) };
    const res = await peerFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) }, { timeoutMs: 20_000 });
    await res.body?.cancel().catch(() => undefined); // Only the status matters; a body we never read cannot leak anywhere.
    return res.status;
  },
  writeNote: async (sent, text) => {
    const env = { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: "" }; // Empty channel = owner identity, like peer-ledger writes.
    const args = ["ledger", "note", sent.target || "-", text, "--project", sent.project, "--dedup", `sl-join-offer:${sent.offerId}`];
    const r = await runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env, timeoutMs: 30_000 });
    if (!r?.ok) throw new Error(`ledger note failed: ${String(r?.error ?? "no result")}`);
  },
};
export const joinOfferLiveDeps = liveDeps;

/** ask-entry.ts initAskWiring: sweep once now, then every minute. */
export function initJoinOffers(): void {
  const sweep = () => void sweepJoinOfferMaintenance();
  sweep();
  setInterval(sweep, 60_000).unref?.();
}


/** Keep legacy maintenance until N6W installs the real replacement; never run both binding audits. */
let sharedProjectAudit: (() => Promise<void>) | undefined;
export function setSharedProjectAuditHook(audit: (() => Promise<void>) | undefined): void { sharedProjectAudit = audit; }
export async function sweepJoinOfferMaintenance(d: JoinOfferDeps = liveDeps, rebind = liveRebindDeps(d.inform)): Promise<void> {
  const maintenance = sharedProjectAudit ? sharedProjectAudit() : sweepSharedLedgerRebinds(rebind);
  const results = await Promise.allSettled([sweepJoinOffers(d), maintenance]);
  for (const r of results) if (r.status === "rejected") {
    console.error("⚠️ [join-offer] 扫描失败");
  }
}
