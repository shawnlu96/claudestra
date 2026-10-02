/**
 * Lend protocol v2 (docs/design/remote-capacity.md §8): what a v2 lender B sends this instance A — hello (capacity + grant),
 * beat (batched heartbeat that also renews leases), ask (a remote worker's question, relayed by B) — and the offer A pushes
 * to B. The four v1 calls (lib/lend-wire.ts) stay byte-for-byte as they are; v2 only adds endpoints, never fields to v1
 * bodies (tests/lend-wire-v1-golden.test.ts). Both directions parse strictly, the same way: unknown / missing field, wrong
 * type, over-long value = refused, never trimmed. LEND_PROTO is defined here and nowhere else. tests/lend-wire-v2.test.ts.
 */
import { LEND_FAMILIES, type LendFamily } from "./lend-config.js";
import type { OfferSummary } from "./lend-wire.js";
import { parseAskWire } from "./order-wire.js";

/** The protocol generation this build speaks; hello carries it both ways. A peer with no hello on file is proto 1 (poll only). */
export const LEND_PROTO = 3;
const BODY_V = 1;
const HELLO_MS = 60_000;
const BEAT_MS = 15_000;
/** A hello older than this counts as zero capacity: B says hello every HELLO_MS, three missed = gone. */
export const HELLO_FRESH_MS = 180_000;
const BEAT_MAX = 50;
export const OFFER_MAX = 20;
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
export interface HelloRequest { v: 1; proto: number; boot: string; seq: number; grant: Grant | null; slots: Slots; paused: Paused | null; quota?: HelloQuota }
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

interface AskRequest { v: 1; orderId: string; gen: number; question: string; options: string[] }
export interface OfferRequest { v: 1; proto: number; orders: OfferSummary[] }
export interface OfferResponse { accepted: string[]; refused: { orderId: string; code: string }[] }

class V2Error extends Error {}
const no = (path: string, why: string): never => { throw new V2Error(`${path}: ${why}`); };

/** Exactly these keys (optional ones may be absent); anything else is refused. */
function fields(v: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return no(path, "要是对象");
  const r = v as Record<string, unknown>;
  const unknownKey = Object.keys(r).find((k) => !keys.includes(k) && !optional.includes(k));
  if (unknownKey !== undefined) no(path, `不认识的字段 ${unknownKey}`);
  const absent = keys.filter((k) => !(k in r));
  if (absent.length) no(path, `缺字段 ${absent.join(", ")}`);
  return r;
}
const whole = (v: unknown, path: string, lo: number, hi: number): number =>
  Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi ? v as number : no(path, `要是 ${lo}–${hi} 的整数`);
const pattern = (v: unknown, path: string, re: RegExp): string => (typeof v === "string" && re.test(v) ? v : no(path, "格式不对"));
const pick = <T extends string>(v: unknown, path: string, all: readonly T[]): T => (all.includes(v as T) ? v as T : no(path, `只认 ${all.join(" / ")}`));
function arrayOf<T>(v: unknown, path: string, max: number, each: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v) || v.length > max) return no(path, `要是不超过 ${max} 项的数组`);
  return v.map((x, i) => each(x, `${path}[${i}]`));
}
const version = (r: Record<string, unknown>): 1 => (r.v === BODY_V ? BODY_V : no("v", `只认版本 ${BODY_V}`));
const MAX_TS = 8.64e15;

const ORDER_ID = /^[\w.:-]{1,200}$/;
const TASK_ID = /^[\w.-]{1,64}$/;
const BOOT = /^[A-Za-z0-9_-]{8,64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;
const SHA40 = /^[0-9a-f]{40}$/;
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

function parseHello(raw: unknown): HelloRequest {
  const r = fields(raw, "$", ["v", "proto", "boot", "seq", "grant", "slots", "paused"], ["quota"]);
  const p = r.paused === null ? null : fields(r.paused, "paused", ["reason", "until"]);
  return { v: version(r), proto: whole(r.proto, "proto", 2, 99), boot: pattern(r.boot, "boot", BOOT), seq: whole(r.seq, "seq", 0, MAX_TS),
    grant: grantOf(r.grant), slots: slotsOf(r.slots), paused: p && { reason: pattern(p.reason, "paused.reason", CODE), until: whole(p.until, "paused.until", 0, MAX_TS) },
    ...(r.quota === undefined ? {} : { quota: quotaOf(r.quota) }) };
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
  const r = fields(raw, "$", ["v", "orderId", "gen", "question", "options"]);
  const w = parseAskWire({ v: version(r), orderId: r.orderId, question: r.question, options: r.options });
  if (!w.ok) return no("ask", w.error);
  return { v: BODY_V, orderId: w.value.orderId, gen: whole(r.gen, "gen", 1, 1e9), question: w.value.question, options: w.value.options };
}

function summaryOf(v: unknown, path: string): OfferSummary {
  const s = fields(v, path, ["orderId", "taskId", "step", "family", "repo", "pr", "head", "round", "specRev", "offeredAt"]);
  return { orderId: pattern(s.orderId, `${path}.orderId`, ORDER_ID), taskId: pattern(s.taskId, `${path}.taskId`, TASK_ID),
    step: pick(s.step, `${path}.step`, ["review", "write", "fix"] as const), family: pick(s.family, `${path}.family`, LEND_FAMILIES),
    repo: pattern(s.repo, `${path}.repo`, REPO), pr: s.pr === null ? null : whole(s.pr, `${path}.pr`, 1, 1e9), head: pattern(s.head, `${path}.head`, SHA40),
    round: whole(s.round, `${path}.round`, 0, 1e6), specRev: whole(s.specRev, `${path}.specRev`, 0, 1e6), offeredAt: whole(s.offeredAt, `${path}.offeredAt`, 0, MAX_TS) };
}

function parseOffer(raw: unknown): OfferRequest {
  const r = fields(raw, "$", ["v", "proto", "orders"]);
  const orders = arrayOf(r.orders, "orders", OFFER_MAX, summaryOf);
  if (!orders.length) no("orders", "不能是空的");
  if (new Set(orders.map((o) => o.orderId)).size !== orders.length) no("orders", "同一单出现两次");
  return { v: version(r), proto: whole(r.proto, "proto", 2, 99), orders };
}

const REQUESTS = { hello: parseHello, beat: parseBeat, ask: parseAsk, offer: parseOffer } as const;
type Requests = { hello: HelloRequest; beat: BeatRequest; ask: AskRequest; offer: OfferRequest };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
function guard<T>(fn: () => T): Parsed<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (e instanceof V2Error) return { ok: false, error: e.message };
    throw e;
  }
}

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

/** The bodies this side sends: A's hello answer and its offer push. */
export const helloAnswer = (): HelloResponse => ({ proto: LEND_PROTO, helloMs: HELLO_MS, beatMs: BEAT_MS });
export const offerBody = (orders: OfferSummary[]): OfferRequest => ({ v: BODY_V, proto: LEND_PROTO, orders: orders.slice(0, OFFER_MAX) });
export const V2_BODY_VERSION = BODY_V;
