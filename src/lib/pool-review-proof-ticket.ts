/**
 * dispatch-recovery-POOLRV1 r1: the review ticket. B's bridge signs it (instance key, its own purpose) only inside submit_verdict,
 * after the verified identity's one journal binding and the take_review fact it recorded; CLI `lend submit` never signs.
 * A checks it against the key pinned for that peer before the order's claim. It is a named claim by a trusted B service, not a
 * boundary against a hostile B or another process of the same OS user. tests/pool-review-proof-ticket.test.ts.
 */
import { createHash } from "node:crypto";
import { verifyPurpose } from "./instance-signature.js";

export const REVIEW_TICKET_PURPOSE = "claudestra-lend-review-ticket-v1" as const;

/** What B's take_review recorded for this order: who took it, in which session and lease generation, when. */
export interface TakeFact { orderId: string; gen: number; agent: string; session: string; at: number }

export interface ReviewTicket {
  v: 1; orderId: string; gen: number; taskId: string; head: string; specRev: number; round: number; family: string;
  worker: string; session: string;
  /** canonical sha256 of the result body without `ticket` (the signature never covers itself); the transport sha stays separate */
  payloadSha: string;
  take: TakeFact; key: string; sig: string;
}
type Unsigned = Omit<ReviewTicket, "key" | "sig">;

const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);

/** The logical digest both sides compute: the body's fields minus `ticket`, keys sorted, so key order on the wire does not matter. */
export function logicalSha(body: Record<string, unknown>): string {
  const { ticket: _t, ...rest } = body;
  return createHash("sha256").update(canon(rest), "utf8").digest("hex");
}

const fields = (t: Unsigned): string[] => [t.orderId, String(t.gen), t.taskId, t.head, String(t.specRev), String(t.round), t.family, t.worker,
  t.session, t.payloadSha, t.take.orderId, String(t.take.gen), t.take.agent, t.take.session, String(t.take.at)];

export type TicketSigner = (fields: string[]) => { key: string; sig: string } | null;

/** B: null when the take fact does not match this binding (no take, other session / gen / agent) or there is no key: nothing is sent unsigned-as-signed. */
export function issueReviewTicket(t: Unsigned, sign: TicketSigner): ReviewTicket | null {
  const k = t.take;
  if (k.orderId !== t.orderId || k.gen !== t.gen || k.agent !== t.worker || k.session !== t.session) return null;
  const s = sign(fields(t));
  return s ? { ...t, key: s.key, sig: s.sig } : null;
}

const KEYS = ["v", "orderId", "gen", "taskId", "head", "specRev", "round", "family", "worker", "session", "payloadSha", "take", "key", "sig"];
const TAKE_KEYS = ["orderId", "gen", "agent", "session", "at"];
const ID = /^[\w.:-]{1,200}$/;
const exact = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const whole = (v: unknown, max = 1e15): boolean => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;

/** Strict shape for lend-wire: every field present, nothing extra, identifiers single-line. null = malformed. */
export function parseReviewTicket(v: unknown): ReviewTicket | null {
  if (!isObj(v) || !exact(v, KEYS) || v.v !== 1 || !isObj(v.take) || !exact(v.take, TAKE_KEYS)) return null;
  const k = v.take;
  const ids = [v.orderId, v.taskId, v.family, v.worker, v.session, k.orderId, k.agent, k.session];
  if (!ids.every((x) => typeof x === "string" && ID.test(x))) return null;
  if (typeof v.head !== "string" || !/^[0-9a-f]{40}$/.test(v.head) || typeof v.payloadSha !== "string" || !/^[0-9a-f]{64}$/.test(v.payloadSha)) return null;
  if (![v.gen, v.specRev, v.round, k.gen, k.at].every((x) => whole(x)) || typeof v.key !== "string" || typeof v.sig !== "string") return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(v.key) || !/^[A-Za-z0-9_-]{1,200}$/.test(v.sig)) return null;
  return v as unknown as ReviewTicket;
}

export interface TicketExpect {
  orderId: string; gen: number; taskId: string; head: string; specRev: number; round: number; family: string; worker: string;
  session: string; payloadSha: string;
}

/** A (writer and proof): null = the ticket is signed by `publicKey` and names exactly this order, binding, body and take; else why not. */
export function ticketProblem(t: ReviewTicket, want: TicketExpect, publicKey: string): string | null {
  if (t.key !== publicKey) return "票据不是用钉住的对方钥匙签的";
  if (!verifyPurpose(publicKey, REVIEW_TICKET_PURPOSE, fields(t), t.sig)) return "票据签名不对";
  for (const k of Object.keys(want) as (keyof TicketExpect)[]) if (t[k] !== want[k]) return `票据的 ${k} 与这一单不一致`;
  const take = t.take;
  if (take.orderId !== t.orderId || take.gen !== t.gen || take.agent !== t.worker || take.session !== t.session) return "票据的领单事实与提交绑定不一致";
  return null;
}
