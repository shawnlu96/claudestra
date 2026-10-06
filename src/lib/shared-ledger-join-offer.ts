/**
 * Shared-ledger join offers: one peer bridge hands a join code to another, whose owner approves it with one button.
 * The code is a one-time credential, so it travels only in the offer body over the configured peer channel and rests only in
 * process memory on the receiving machine. A restart requires a fresh invitation. Cards, receipts, logs and errors carry
 * fixed wording plus the peer name,
 * the center host and the centerId — never the code, a bearer or anything the center answered.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { looksLikeSharedLedgerJoinCode, parseSharedLedgerJoinCode } from "./shared-ledger-join.js";
import type { SharedLedgerProjectChoice } from "./shared-ledger-local-project.js";
import { writeJsonAtomic } from "./state-file.js";

export const JOIN_OFFER_PATH = "/api/v1/shared-ledger-join-offer";
export const JOIN_OFFER_RECEIPT_PATH = "/api/v1/shared-ledger-join-offer/receipt";
/** A pending offer never outlives the code; codes minted for peers are 24h, and nothing waits longer than that here. */
export const JOIN_OFFER_MAX_TTL_MS = 24 * 3600_000;
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 3600_000;
/** Memory cap across all peers prevents invitation floods from retaining unbounded credentials. */
const MAX_PENDING = 50;
const NOTE_MAX = 120;
const OFFER_ID_RE = /^[a-f0-9]{32}$/;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

const JOIN_OFFER_STATUSES = ["joined", "declined", "expired", "failed"] as const;
export type JoinOfferStatus = (typeof JOIN_OFFER_STATUSES)[number];
export const isJoinOfferStatus = (v: unknown): v is JoinOfferStatus => JOIN_OFFER_STATUSES.includes(v as JoinOfferStatus);
export const isOfferId = (v: unknown): v is string => typeof v === "string" && OFFER_ID_RE.test(v);

/**
 * The center root URL as the join will request it: https, a DNS-shaped host, no userinfo / path / query / fragment, and already
 * in canonical form — anything the URL parser would rewrite (backslashes, odd escapes, IDN) is refused rather than normalised,
 * so the host shown on the card is byte for byte the host that joinSharedLedger contacts.
 */
export function centerOfferUrl(raw: unknown): { url: string; host: string } | null {
  if (typeof raw !== "string" || raw.length > 300) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null; // Not a URL at all: the caller answers a fixed "invalid url".
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") return null;
  const labels = u.hostname.split(".");
  if (u.hostname.length > 253 || labels.length < 2 || !labels.every((l) => LABEL_RE.test(l)) || /^\d+$/.test(labels.at(-1)!)) return null;
  const url = u.toString();
  return url === raw || `${raw}/` === url ? { url, host: u.host } : null;
}

/** The free-text note from the inviter: one short line, printable, never something shaped like a code. */
function offerNote(v: unknown): string | null | undefined {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || Array.from(v).length > NOTE_MAX || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(v) || looksLikeSharedLedgerJoinCode(v)) return null;
  return v.trim() || undefined;
}

export interface JoinOfferProject { teamId: string; projectId: string; name: string }

/** Display data is untrusted; reject secret-shaped and control-bearing labels before any persistence or card rendering. */
export function parseJoinOfferProject(value: unknown): JoinOfferProject | null {
  const p = value as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || Array.isArray(p)
    || Object.keys(p).some(k => !["teamId", "projectId", "name"].includes(k))) return null;
  if (typeof p.teamId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(p.teamId)
    || typeof p.projectId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(p.projectId)) return null;
  if (typeof p.name !== "string" || !p.name.trim() || Array.from(p.name).length > 64
    || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(p.name) || looksLikeSharedLedgerJoinCode(p.name)) return null;
  return { teamId: p.teamId, projectId: p.projectId, name: p.name };
}

export interface JoinOffer { project?: JoinOfferProject; offerId: string; url: string; host: string; centerId: string; code: string; note?: string; expiresAt: number }
export type JoinOfferRefusal = "invalid_offer" | "invalid_url" | "invalid_code" | "expired";
const OFFER_KEYS = new Set(["v", "offerId", "url", "code", "note", "expiresAt", "project"]);

/** POST body → offer. Each refusal is a fixed code; nothing from the body is echoed back. */
export function parseJoinOffer(body: unknown, now: number): { ok: true; offer: JoinOffer } | { ok: false; error: JoinOfferRefusal } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object" || Array.isArray(b) || b.v !== 1 || Object.keys(b).some((k) => !OFFER_KEYS.has(k)) || !isOfferId(b.offerId)) {
    return { ok: false, error: "invalid_offer" };
  }
  const center = centerOfferUrl(b.url);
  if (!center) return { ok: false, error: "invalid_url" };
  const code = typeof b.code === "string" && b.code === b.code.trim() ? parseSharedLedgerJoinCode(b.code) : null;
  if (!code) return { ok: false, error: "invalid_code" };
  const project = b.project === undefined ? undefined : parseJoinOfferProject(b.project);
  if (project === null) return { ok: false, error: "invalid_offer" };
  const note = offerNote(b.note);
  if (note === null || (note && note.includes(code.secret)) || (project && Object.values(project).some(v => v.includes(code.secret)))) return { ok: false, error: "invalid_offer" };
  if (b.expiresAt !== undefined && !Number.isSafeInteger(b.expiresAt)) return { ok: false, error: "invalid_offer" };
  const expiresAt = Math.min((b.expiresAt as number | undefined) ?? Infinity, now + JOIN_OFFER_MAX_TTL_MS);
  if (expiresAt <= now) return { ok: false, error: "expired" };
  return { ok: true, offer: { offerId: b.offerId, ...center, centerId: code.centerId, code: b.code as string, ...(note ? { note } : {}), ...(project ? { project } : {}), expiresAt } };
}

/** Per-peer sliding window (5 per hour); in memory, so a bridge restart forgives — the pending-offer cap still holds. */
export class JoinOfferLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit = RATE_LIMIT, private readonly windowMs = RATE_WINDOW_MS) {}
  tryAcquire(peer: string, now: number): boolean {
    const recent = (this.hits.get(peer) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(peer, recent);
      return false;
    }
    this.hits.set(peer, [...recent, now]);
    return true;
  }
}

// Pending credentials stay in process memory; only non-secret sender receipts are persisted.

interface JoinProjectSelection { mode: "create" | "existing"; localProjectId?: string }
interface JoinProjectOption { value: string; name: string; selection: JoinProjectSelection }
export interface PendingJoinOffer extends JoinOffer {
  projectOptions?: JoinProjectOption[]; recommended?: string; peer: string; receivedAt: number; askId?: string;
  projectChoices?: SharedLedgerProjectChoice[]; sharedProjectId?: string;
}
export interface SentJoinOffer {
  offerId: string; peer: string; host: string; centerId: string; project: string; target: string; sentAt: number; expiresAt: number;
  status?: JoinOfferStatus; statusAt?: number;
}

export const pendingOfferDir = (stateDir: string): string => join(stateDir, "shared-ledger-join-offers");
export const sentOfferDir = (stateDir: string): string => join(stateDir, "shared-ledger-join-offers-sent");

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error("join offer state path is not a directory");
}

async function writePrivate(dir: string, offerId: string, data: unknown): Promise<void> {
  ensurePrivateDir(dir);
  await chmod(dir, 0o700);
  await writeJsonAtomic(join(dir, `${offerId}.json`), data, { mode: 0o600, noFollow: true });
}

function readPrivate<T>(dir: string, offerId: string, shape: (v: unknown) => v is T): T | null {
  if (!isOfferId(offerId)) return null;
  const file = join(dir, `${offerId}.json`);
  if (!existsSync(file) || !lstatSync(file).isFile()) return null;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return shape(v) && (v as { offerId: string }).offerId === offerId ? v : null;
  } catch {
    return null; // A torn or hand-edited file is treated as absent: the sweeper's unlink then removes it.
  }
}

// Key by state directory so isolated instances and tests cannot claim each other's invitations.
const pendingOffers = new Map<string, Map<string, PendingJoinOffer>>();

const isSent = (v: unknown): v is SentJoinOffer => {
  const s = v as SentJoinOffer;
  return !!s && typeof s === "object" && isOfferId(s.offerId) && typeof s.peer === "string" && typeof s.host === "string"
    && typeof s.project === "string" && typeof s.target === "string" && (s.status === undefined || isJoinOfferStatus(s.status));
};

export function listPendingOfferIds(stateDir: string): string[] {
  return [...(pendingOffers.get(stateDir)?.keys() ?? [])];
}

export function readPendingOffer(stateDir: string, offerId: string): PendingJoinOffer | null {
  const p = pendingOffers.get(stateDir)?.get(offerId);
  return p ? structuredClone(p) : null;
}

/** No await between the cap/dedup check and insertion: concurrent arrivals cannot overfill the store. */
export async function savePendingOffer(stateDir: string, p: PendingJoinOffer, opts: { replace?: boolean } = {}): Promise<"ok" | "exists" | "full"> {
  const offers = pendingOffers.get(stateDir) ?? new Map<string, PendingJoinOffer>();
  const present = offers.has(p.offerId);
  if (!opts.replace && present) return "exists";
  if (!present && offers.size >= MAX_PENDING) return "full";
  offers.set(p.offerId, structuredClone(p));
  pendingOffers.set(stateDir, offers);
  return "ok";
}

/** An ask id is public metadata; the credential itself never enters the ask database. */
export function attachPendingOfferAsk(stateDir: string, offerId: string, askId: string): void {
  const pending = pendingOffers.get(stateDir)?.get(offerId);
  if (pending) pending.askId = askId;
}

/** Synchronous claim prevents double clicks and the sweeper from redeeming the same credential twice. */
export function claimPendingOffer(stateDir: string, offerId: string): PendingJoinOffer | null {
  const offers = pendingOffers.get(stateDir);
  if (!offers) return null;
  const p = offers.get(offerId);
  if (!p) return null;
  offers.delete(offerId);
  if (!offers.size) pendingOffers.delete(stateDir);
  return p;
}

export const saveSentOffer = (stateDir: string, s: SentJoinOffer): Promise<void> => writePrivate(sentOfferDir(stateDir), s.offerId, s);
export const readSentOffer = (stateDir: string, offerId: string): SentJoinOffer | null => readPrivate(sentOfferDir(stateDir), offerId, isSent);

/** Receipt from `peer`: only for an offer we sent to that same peer, only once. */
export async function recordSentOfferStatus(stateDir: string, peer: string, offerId: string, status: JoinOfferStatus, now: number):
  Promise<{ ok: true; sent: SentJoinOffer; duplicate: boolean } | { ok: false }> {
  const sent = readSentOffer(stateDir, offerId);
  if (!sent || sent.peer !== peer) return { ok: false };
  if (sent.status) return sent.status === status ? { ok: true, sent, duplicate: true } : { ok: false };
  const next = { ...sent, status, statusAt: now };
  await saveSentOffer(stateDir, next);
  return { ok: true, sent: next, duplicate: false };
}

// ── Wording (fixed; only peer name, host, centerId, team / project ids) ──

const STATUS_ZH: Record<JoinOfferStatus, string> = { joined: "已入组", declined: "对方不加入", expired: "邀请已过期", failed: "入组失败" };

export function joinOfferCard(p: Pick<PendingJoinOffer, "peer" | "host" | "centerId" | "note" | "expiresAt" | "project">): { title: string; context: string } {
  const lines = [
    `邀请方（peer）：${p.peer}`,
    `中心主机：${p.host}`,
    `中心 ID：${p.centerId}`,
    p.project ? `团队：${p.project.teamId}；项目：${p.project.name}（${p.project.projectId}）` : "团队 / 项目：入组后显示",
    ...(p.note ? [`对方附言：${p.note}`] : []),
    `有效至：${new Date(p.expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`,
  ];
  return { title: p.project ? `加入团队项目 ${p.project.name}？` : "加入共享台账？", context: lines.join("\n") };
}

export function joinOfferOutcomeText(p: Pick<PendingJoinOffer, "peer" | "host">, status: JoinOfferStatus, joined?: { teamId: string; projectId: string }): string {
  if (status === "joined" && joined) return `✅ 已加入共享台账：中心 ${p.host}，团队 ${joined.teamId}，项目 ${joined.projectId}（邀请方 ${p.peer}）。`;
  if (status === "declined") return `已不加入 ${p.peer} 邀请的共享台账（中心 ${p.host}），邀请已删除。`;
  if (status === "expired") return `${p.peer} 邀请的共享台账（中心 ${p.host}）已过期，邀请已删除。`;
  return `⚠️ 加入 ${p.peer} 邀请的共享台账没成功（中心 ${p.host}），邀请已删除；需要的话请对方重新发码。`;
}

export const receiptNoteText = (s: Pick<SentJoinOffer, "peer" | "host" | "offerId">, status: JoinOfferStatus): string =>
  `共享台账入组回执：${s.peer} ${STATUS_ZH[status]}（${status}；中心 ${s.host}；offer ${s.offerId}）`;
