/**
 * Shared-ledger join offers inside the bridge (lib/shared-ledger-join-offer.ts holds the pure parts).
 *   Receiver: a configured peer POSTs an offer → 0600 pending file → authorize card for the owner. "加入" + ask-check →
 *   joinSharedLedger (subject owner:self) → inform the owner → receipt to the inviter. "不加入", expiry or failure delete the file.
 *   Sender: the receipt from that same peer marks our sent record and becomes a ledger note.
 * Every message here is fixed wording (lib joinOfferCard / joinOfferOutcomeText); the code and center responses never reach them.
 */
import { bindHash, checkAsk } from "../lib/ask-bind.js";
import { instanceIdSync } from "../lib/instance-id.js";
import { instanceKeySync, signedFor } from "../lib/instance-key.js";
import { closeAsk, getAsk, MASTER_PROJECT, ownerAnswered, type Ask, type AskBind } from "../lib/ledger-asks.js";
import { STATE_DIR } from "../lib/paths.js";
import { readPeers, type HttpPeer } from "../lib/peers.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { joinSharedLedger, type SharedLedgerJoinResult } from "../lib/shared-ledger-join.js";
import {
  attachPendingOfferAsk, claimPendingOffer, isJoinOfferStatus, isOfferId, JOIN_OFFER_RECEIPT_PATH, JoinOfferLimiter, joinOfferCard, joinOfferOutcomeText,
  listPendingOfferIds, parseJoinOffer, readPendingOffer, receiptNoteText, recordSentOfferStatus, savePendingOffer,
  type JoinOfferStatus, type PendingJoinOffer, type SentJoinOffer,
} from "../lib/shared-ledger-join-offer.js";
import { askDb, askReadDb, asksDeps, createAsk, publishAsk, type CreateAskInput } from "./asks.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";
import { newMessageId, newThreadId } from "./router.js";

/** createdBy of the authorize cards; also the "agent" the bind hash is computed for, since system asks have no fromAgent. */
const JOIN_OFFER_CREATOR = "system:shared-ledger-join-offer";
const BIND_ACTION = "shared_ledger_join";
export const JOIN_BUTTON = "sl_join_accept";
export const DECLINE_BUTTON = "sl_join_decline";

export interface JoinOfferDeps {
  stateDir: () => string;
  now: () => number;
  peers: () => Promise<HttpPeer[]>;
  openAsk: (input: CreateAskInput) => Ask;
  getAsk: (id: string) => Ask | null;
  closeAsk: (id: string) => void;
  join: (url: string, code: string) => Promise<SharedLedgerJoinResult>;
  /** The inform card: a notification to the owner (no buttons). */
  inform: (text: string) => Promise<void>;
  /** POST the receipt to the inviter; resolves with the HTTP status. */
  sendReceipt: (peer: HttpPeer, body: string) => Promise<number>;
  /** Sender side: append the receipt as a ledger note. */
  writeNote: (sent: SentJoinOffer, text: string) => Promise<void>;
}

const limiter = new JoinOfferLimiter();
const receiptLimiter = new JoinOfferLimiter(60);
type Reply = { status: number; body: Record<string, unknown> };
const refuse = (status: number, code: string): Reply => ({ status, body: { ok: false, code } });

/** The inbound principal's peer name → its enabled, fully handshaken record; anything else is not a configured peer. */
export async function configuredPeer(name: string | undefined, d: Pick<JoinOfferDeps, "peers">): Promise<HttpPeer | null> {
  if (!name || name.startsWith("invite:")) return null;
  return (await d.peers()).find((p) => p.name === name && !p.disabled && !!p.baseUrl && !!p.outToken) ?? null;
}

const bindOf = (p: PendingJoinOffer): Omit<AskBind, "paramsHash"> => ({
  action: BIND_ACTION, approve: [JOIN_BUTTON], params: { offerId: p.offerId, peer: p.peer, host: p.host, centerId: p.centerId, expiresAt: p.expiresAt },
});

/** POST /api/v1/shared-ledger-join-offer from peer `peerName` (already authenticated as a configured peer). */
export async function receiveJoinOffer(peer: HttpPeer, body: unknown, d: JoinOfferDeps): Promise<Reply> {
  const now = d.now();
  if (!limiter.tryAcquire(peer.name, now)) return refuse(429, "rate_limited");
  const parsed = parseJoinOffer(body, now);
  if (!parsed.ok) return refuse(400, parsed.error);
  const pending: PendingJoinOffer = { ...parsed.offer, peer: peer.name, receivedAt: now };
  const saved = await savePendingOffer(d.stateDir(), pending);
  if (saved !== "ok") return refuse(saved === "exists" ? 409 : 429, saved === "exists" ? "duplicate_offer" : "too_many_pending");
  let ask: Ask;
  try {
    const bind = bindOf(pending);
    ask = d.openAsk({
      source: "system", createdBy: JOIN_OFFER_CREATOR, kind: "authorize", project: MASTER_PROJECT, ...joinOfferCard(pending),
      options: [{ type: "buttons", buttons: [{ id: JOIN_BUTTON, label: "加入", style: "success" }, { id: DECLINE_BUTTON, label: "不加入", style: "secondary" }] }],
      allowText: false, blocking: true, expiresAt: pending.expiresAt, dedupKey: `sl-join-offer:${pending.offerId}`,
      bind: { ...bind, paramsHash: bindHash(bind, JOIN_OFFER_CREATOR) }, extra: { joinOfferId: pending.offerId },
    });
  } catch (e) {
    claimPendingOffer(d.stateDir(), pending.offerId);
    console.error(`⚠️ [join-offer] 给 owner 开授权卡失败，邀请已删除: ${(e as Error).name}`);
    return refuse(503, "ask_unavailable");
  }
  attachPendingOfferAsk(d.stateDir(), pending.offerId, ask.id);
  console.log(`🤝 [join-offer] 收到 ${peer.name} 的共享台账邀请（中心 ${pending.host}），已开授权卡 ${ask.id}`);
  return { status: 202, body: { ok: true, accepted: true, offerId: pending.offerId } };
}

/** "加入" counts only if ask-check passes for the card we opened (same params) and the owner — not a guest — answered. */
function approved(a: Ask, p: PendingJoinOffer): boolean {
  const asked = { ...a, fromAgent: JOIN_OFFER_CREATOR };
  return ownerAnswered(a.answer) && checkAsk(asked, bindHash(bindOf(p), JOIN_OFFER_CREATOR), JOIN_OFFER_CREATOR).ok;
}

/** Settle one claimed offer: tell the owner, tell the inviter. Neither failure undoes the outcome. */
async function settle(p: PendingJoinOffer, status: JoinOfferStatus, d: JoinOfferDeps, joined?: SharedLedgerJoinResult): Promise<void> {
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
  if (a.createdBy !== JOIN_OFFER_CREATOR || a.state !== "answered" || !isOfferId(offerId)) return;
  const p = claimPendingOffer(d.stateDir(), offerId);
  if (!p) return;
  const accept = (a.answer?.choices ?? []).includes(`[button:${JOIN_BUTTON}]`);
  if (!accept) return settle(p, "declined", d);
  if (p.expiresAt <= d.now()) return settle(p, "expired", d);
  if (!approved(a, p)) return settle(p, "failed", d);
  let joined: SharedLedgerJoinResult;
  try {
    joined = await d.join(p.url, p.code);
  } catch {
    return settle(p, "failed", d); // SharedLedgerJoinError text is fixed, but nothing of it is needed: the card says "failed" only.
  }
  return settle(p, "joined", d, joined);
}

/** Every minute: expired offers (or ones whose card closed without an answer) are deleted; answered ones the hook missed are settled. */
export async function sweepJoinOffers(d: JoinOfferDeps = liveDeps): Promise<void> {
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
  closeAsk: (id) => {
    const a = closeAsk(askDb(), id, "cancelled", "join offer expired");
    if (a) publishAsk(a);
  },
  join: (url, code) => {
    const key = instanceKeySync();
    const instanceId = instanceIdSync();
    if (!key || !instanceId) return Promise.reject(new Error("instance key unavailable"));
    return joinSharedLedger({ url, code, key, instanceId, subject: "owner:self" });
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
  const sweep = () => void sweepJoinOffers().catch((e: Error) => console.error(`⚠️ [join-offer] 扫描失败: ${e.message.slice(0, 200)}`));
  sweep();
  setInterval(sweep, 60_000).unref?.();
}
