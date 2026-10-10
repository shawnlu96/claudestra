/**
 * Lend protocol v2 (docs/design/remote-capacity.md §8): what a v2 lender B sends this instance A — hello (capacity + grant),
 * beat (batched heartbeat that also renews leases), ask (a remote worker's question, relayed by B) — and the offer A pushes
 * to B. The four v1 calls (lib/lend-wire.ts) stay byte-for-byte as they are; v2 only adds endpoints, never fields to v1
 * bodies (tests/lend-wire-v1-golden.test.ts). Both directions parse strictly, the same way: unknown / missing field, wrong
 * type, over-long value = refused, never trimmed. The shared helpers and LEND_PROTO / OFFER_MAX / BODY_V live in
 * lib/lend-wire-v2-schema.ts; the offer body is lib/lend-offer-protocol.ts (pure, no local state). tests/lend-wire-v2.test.ts.
 */
import { LEND_FAMILIES, type LendFamily } from "./lend-wire-types.js";
import { offerBody, parseOffer, type OfferRequest } from "./lend-offer-protocol.js";
import { arrayOf, BODY_V, fields, guard, LEND_PROTO, MAX_TS, no, OFFER_MAX, ORDER_ID, pattern, pick, REPO, version, whole, type Parsed } from "./lend-wire-v2-schema.js";
import { askScopeExtra, parseAskWire, type AskScopeReason } from "./order-wire.js";

export { LEND_PROTO, OFFER_MAX, offerBody, type OfferRequest };
const HELLO_MS = 60_000;
const BEAT_MS = 15_000;
/** A hello older than this counts as zero capacity: B says hello every HELLO_MS, three missed = gone. */
export const HELLO_FRESH_MS = 180_000;
const BEAT_MAX = 50;
const EXCERPT_MAX = 1024;

const LEND_V2_ENDPOINTS = ["hello", "beat", "ask", "offer"] as const;
export type LendV2Endpoint = (typeof LEND_V2_ENDPOINTS)[number];
/**
 * HTTP status per v2 refusal. None of them is 404: a v2 endpoint answering 404 means the other side predates it (old build),
 * which is how B falls back to polling (lib/lend-remote.ts).
 */
export const LEND_V2_STATUS = { unauthorized: 401, invalid: 400, not_held: 409, no_hello: 409, unavailable: 503 } as const;

type Role = "review" | "write";
export interface Grant { until: number; roles: Role[]; repos: string[]; ordersPerDay: number; ordersLeftToday: number }
export type Slots = Record<LendFamily, { total: number; busy: number }>;
export interface Paused { reason: string; until: number }
/** Optional (i28-Q1): the lender's weekly quota per family, percent + reset time only — a peer without it still says hello. */
export type HelloQuota = Partial<Record<LendFamily, { weekUsedPct: number; resetAt: number }>>;
/** Optional (LCFG1): per family, the lender owner's explicit recovery of config-fault generation gen, with that generation's evidence orders. */
export type HelloConfigRecovered = Partial<Record<LendFamily, { gen: number; orders: string[] }>>;
export interface HelloRequest { v: 1; proto: number; boot: string; seq: number; grant: Grant | null; slots: Slots; paused: Paused | null; quota?: HelloQuota; configRecovered?: HelloConfigRecovered }
export interface HelloResponse { proto: number; helloMs: number; beatMs: number }

const PHASES = ["cloning", "starting", "working", "publishing", "result_pending"] as const;
export interface BeatOrder {
  orderId: string; gen: number; phase: (typeof PHASES)[number]; lastActivityAt: number; excerpt: string; ended: { reason: "revoked"; clean: boolean } | null;
}
export interface BeatRequest { v: 1; orders: BeatOrder[] }
const BEAT_VERDICTS = ["ok", "cancelled", "convergence_cancelled", "lease_expired", "stale_gen", "not_found", "done"] as const;
type BeatVerdict = (typeof BEAT_VERDICTS)[number];
interface LeaseV2 { gen: number; expiresAt: number; ms: number }
export interface BeatAnswer { orderId: string; verdict: BeatVerdict; lease: LeaseV2 | null }

interface AskRequest { v: 1; orderId: string; gen: number; question: string; options: string[]; files?: string[]; reason?: AskScopeReason }
export interface OfferResponse { accepted: string[]; refused: { orderId: string; code: string }[] }

const BOOT = /^[A-Za-z0-9_-]{8,64}$/;
const CODE = /^[a-z_]{1,40}$/;
const ASK_ID = /^[\w:-]{1,100}$/;

function grantOf(v: unknown): Grant | null {
  if (v === null) return null;
  const g = fields(v, "grant", ["until", "roles", "repos", "ordersPerDay", "ordersLeftToday"]);
  const roles = arrayOf(g.roles, "grant.roles", 2, (x, p) => pick(x, p, ["review", "write"] as const));
  if (new Set(roles).size !== roles.length) no("grant.roles", "有重复");
  return { until: whole(g.until, "grant.until", 0, MAX_TS), roles, repos: arrayOf(g.repos, "grant.repos", 50, (x, p) => pattern(x, p, REPO)),
    ordersPerDay: whole(g.ordersPerDay, "grant.ordersPerDay", 0, 1000), ordersLeftToday: whole(g.ordersLeftToday, "grant.ordersLeftToday", 0, 1000) };
}

function slotsOf(v: unknown): Slots {
  const s = fields(v, "slots", LEND_FAMILIES);
  const one = (f: LendFamily) => {
    const c = fields(s[f], `slots.${f}`, ["total", "busy"]);
    return { total: whole(c.total, `slots.${f}.total`, 0, 100), busy: whole(c.busy, `slots.${f}.busy`, 0, 100) };
  };
  return { codex: one("codex"), claude: one("claude") };
}

/** Exactly {weekUsedPct, resetAt} per family, nothing else: an account, token or session id has no key to ride on. */
function quotaOf(v: unknown): HelloQuota {
  const q = fields(v, "quota", [], LEND_FAMILIES);
  const out: HelloQuota = {};
  for (const f of LEND_FAMILIES) {
    if (q[f] === undefined) continue;
    const w = fields(q[f], `quota.${f}`, ["weekUsedPct", "resetAt"]);
    out[f] = { weekUsedPct: whole(w.weekUsedPct, `quota.${f}.weekUsedPct`, 0, 100), resetAt: whole(w.resetAt, `quota.${f}.resetAt`, 0, MAX_TS) };
  }
  return out;
}

/** Each family: gen 1+, 1–20 distinct order ids; strict like the rest (unknown / missing / repeated refused). */
function configRecoveredOf(v: unknown): HelloConfigRecovered {
  const c = fields(v, "configRecovered", [], LEND_FAMILIES);
  return Object.fromEntries(LEND_FAMILIES.filter((f) => c[f] !== undefined).map((f) => {
    const e = fields(c[f], `configRecovered.${f}`, ["gen", "orders"]), orders = arrayOf(e.orders, `configRecovered.${f}.orders`, 20, (x, p) => pattern(x, p, ORDER_ID));
    if (!orders.length || new Set(orders).size !== orders.length) no(`configRecovered.${f}.orders`, "要是不重复的非空订单号");
    return [f, { gen: whole(e.gen, `configRecovered.${f}.gen`, 1, 1e9), orders }];
  }));
}

function parseHello(raw: unknown): HelloRequest {
  const r = fields(raw, "$", ["v", "proto", "boot", "seq", "grant", "slots", "paused"], ["quota", "configRecovered"]);
  const p = r.paused === null ? null : fields(r.paused, "paused", ["reason", "until"]);
  return { v: version(r), proto: whole(r.proto, "proto", 2, 99), boot: pattern(r.boot, "boot", BOOT), seq: whole(r.seq, "seq", 0, MAX_TS),
    grant: grantOf(r.grant), slots: slotsOf(r.slots), paused: p && { reason: pattern(p.reason, "paused.reason", CODE), until: whole(p.until, "paused.until", 0, MAX_TS) },
    ...(r.quota === undefined ? {} : { quota: quotaOf(r.quota) }), ...(r.configRecovered === undefined ? {} : { configRecovered: configRecoveredOf(r.configRecovered) }) };
}

/** One line of excerpt text: newlines and tabs allowed, other control characters refused (the lender redacts before sending). */
function excerptOf(v: unknown, path: string): string {
  if (typeof v !== "string" || Buffer.byteLength(v) > EXCERPT_MAX) return no(path, `要是不超过 ${EXCERPT_MAX} 字节的文字`);
  return /[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/.test(v) ? no(path, "含控制字符") : v;
}

function beatOrderOf(v: unknown, path: string): BeatOrder {
  const o = fields(v, path, ["orderId", "gen", "phase", "lastActivityAt", "excerpt"], ["ended"]);
  const e = o.ended === undefined ? null : fields(o.ended, `${path}.ended`, ["reason", "clean"]);
  if (e && typeof e.clean !== "boolean") no(`${path}.ended.clean`, "要是 true / false");
  return { orderId: pattern(o.orderId, `${path}.orderId`, ORDER_ID), gen: whole(o.gen, `${path}.gen`, 1, 1e9), phase: pick(o.phase, `${path}.phase`, PHASES),
    lastActivityAt: whole(o.lastActivityAt, `${path}.lastActivityAt`, 0, MAX_TS), excerpt: excerptOf(o.excerpt, `${path}.excerpt`),
    ended: e && { reason: pick(e.reason, `${path}.ended.reason`, ["revoked"] as const), clean: e.clean as boolean } };
}

function parseBeat(raw: unknown): BeatRequest {
  const r = fields(raw, "$", ["v", "orders"]);
  const orders = arrayOf(r.orders, "orders", BEAT_MAX, beatOrderOf);
  if (new Set(orders.map((o) => o.orderId)).size !== orders.length) no("orders", "同一单出现两次");
  return { v: version(r), orders };
}

/** The question and options follow the local ask tool's limits (order-wire parseAskWire); gen pins the lease it is asked under. */
function parseAsk(raw: unknown): AskRequest {
  // files / reason（i28-ASK4 测试类扩围）可选：旧版出借方不带，照常解析；不升版本号
  const r = fields(raw, "$", ["v", "orderId", "gen", "question", "options"], ["files", "reason"]);
  const scope = Object.fromEntries((["files", "reason"] as const).filter((k) => k in r).map((k) => [k, r[k]]));
  const w = parseAskWire({ v: version(r), orderId: r.orderId, question: r.question, options: r.options, ...scope });
  if (!w.ok) return no("ask", w.error);
  return { v: BODY_V, orderId: w.value.orderId, gen: whole(r.gen, "gen", 1, 1e9), question: w.value.question, options: w.value.options, ...askScopeExtra(w.value) };
}

const REQUESTS = { hello: parseHello, beat: parseBeat, ask: parseAsk, offer: parseOffer } as const;
type Requests = { hello: HelloRequest; beat: BeatRequest; ask: AskRequest; offer: OfferRequest };

export const parseV2Request = <E extends LendV2Endpoint>(endpoint: E, raw: unknown): Parsed<Requests[E]> =>
  guard(() => REQUESTS[endpoint](raw) as Requests[E]);

const leaseOf = (v: unknown, path: string): LeaseV2 | null => {
  if (v === null) return null;
  const l = fields(v, path, ["gen", "expiresAt", "ms"]);
  return { gen: whole(l.gen, `${path}.gen`, 0, 1e9), expiresAt: whole(l.expiresAt, `${path}.expiresAt`, 0, MAX_TS), ms: whole(l.ms, `${path}.ms`, 1, 864e5) };
};

/** Success bodies (ok:true, v:1 plus these fields), parsed by the side that called. */
const RESPONSES = {
  hello: (r: Record<string, unknown>): HelloResponse => ({ proto: whole(r.proto, "proto", 1, 99), helloMs: whole(r.helloMs, "helloMs", 1000, 36e5),
    beatMs: whole(r.beatMs, "beatMs", 1000, 36e5) }),
  beat: (r: Record<string, unknown>): BeatAnswer[] => arrayOf(r.orders, "orders", BEAT_MAX, (x, p) => {
    const a = fields(x, p, ["orderId", "verdict", "lease"]);
    return { orderId: pattern(a.orderId, `${p}.orderId`, ORDER_ID), verdict: pick(a.verdict, `${p}.verdict`, BEAT_VERDICTS), lease: leaseOf(a.lease, `${p}.lease`) };
  }),
  ask: (r: Record<string, unknown>): { askId: string } => ({ askId: pattern(r.askId, "askId", ASK_ID) }),
  offer: (r: Record<string, unknown>): OfferResponse => ({
    accepted: arrayOf(r.accepted, "accepted", OFFER_MAX, (x, p) => pattern(x, p, ORDER_ID)),
    refused: arrayOf(r.refused, "refused", OFFER_MAX, (x, p) => {
      const f = fields(x, p, ["orderId", "code"]);
      return { orderId: pattern(f.orderId, `${p}.orderId`, ORDER_ID), code: pattern(f.code, `${p}.code`, CODE) };
    }),
  }),
} as const;
const RESPONSE_KEYS: Record<LendV2Endpoint, readonly string[]> = {
  hello: ["proto", "helloMs", "beatMs"], beat: ["orders"], ask: ["askId"], offer: ["accepted", "refused"],
};
type Responses = { [K in LendV2Endpoint]: ReturnType<(typeof RESPONSES)[K]> };

export function parseV2Response<E extends LendV2Endpoint>(endpoint: E, raw: unknown): Parsed<Responses[E]> {
  return guard(() => {
    const r = fields(raw, "$", ["ok", "v", ...RESPONSE_KEYS[endpoint]]);
    if (r.ok !== true) no("ok", "要是 true");
    version(r);
    return RESPONSES[endpoint](r) as Responses[E];
  });
}

/** The bodies this side sends: A's hello answer and its offer push (offerBody, re-exported from lib/lend-offer-protocol.ts). */
export const helloAnswer = (): HelloResponse => ({ proto: LEND_PROTO, helloMs: HELLO_MS, beatMs: BEAT_MS });
export const V2_BODY_VERSION = BODY_V;
