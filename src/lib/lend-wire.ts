/**
 * The four lend calls a lending peer B makes to this instance A (docs/design/remote-capacity.md §0, §2): poll, claim,
 * lease, result. Requests are parsed as strictly as order-wire.ts (unknown / missing field, wrong type or over-long value
 * = refused, never trimmed) because they come from another machine. B's side (T94) builds the same shapes; `v` lets
 * either side rename a field later. Responses are typed here and built by ledger-lend.ts. tests/lend-wire.test.ts.
 */
import { LEND_FAMILIES, type LendFamily } from "./lend-config.js";
import { parseVerdictWire, type VerdictWire } from "./order-wire.js";
import { sanitizeForeign } from "./order-wire-render.js";

const LEND_WIRE_VERSION = 1;
/** Report body bytes; the whole request (verdict + report) must also fit LEND_BODY_MAX, well inside the E2E body cap. */
const LEND_REPORT_MAX = 64 * 1024;
export const LEND_BODY_MAX = 96 * 1024;
export const LEASE_MS_DEFAULT = 10 * 60_000;
export const POLL_AFTER_MS = 30_000;
const DETAIL_MAX = 500;
const POLL_MAX_ORDERS = 20;

const LEND_ENDPOINTS = ["poll", "claim", "lease", "result"] as const;
export type LendEndpoint = (typeof LEND_ENDPOINTS)[number];

export interface PollRequest {
  v: typeof LEND_WIRE_VERSION;
  capacity: { families: Partial<Record<LendFamily, number>>; busy: Partial<Record<LendFamily, number>>; roles: "review"[]; repos: string[]; ordersLeftToday: number };
}
export interface ClaimRequest { v: typeof LEND_WIRE_VERSION; orderId: string; worker: string }
export interface LeaseRequest {
  v: typeof LEND_WIRE_VERSION; orderId: string; gen: number; action: "renew" | "release"; reason: "not_started" | "stopped" | null; detail: string | null;
}
export interface ResultRequest { v: typeof LEND_WIRE_VERSION; orderId: string; gen: number; verdict: VerdictWire; report: string; session: { id: string; family: LendFamily } }

export interface OfferSummary {
  orderId: string; taskId: string; step: "review"; family: LendFamily; repo: string; pr: number | null; head: string; round: number; specRev: number; offeredAt: number;
}
export interface LeaseState { gen: number; expiresAt: number; ms: number }
export interface LendReceipt { orderId: string; sha256: string; eventSeq: number; taskId: string; key: string; sig: string }

/** HTTP status per refusal code; the bridge maps a CLI {code} through this and nothing else. */
export const LEND_STATUS = {
  unauthorized: 401, not_borrowed: 403, not_found: 404, taken: 409, cancelled: 409, lease_expired: 409, stale_gen: 409, conflict: 409,
  max_open: 429, invalid: 400,
} as const;
export type LendRefusal = keyof typeof LEND_STATUS;

class LendWireError extends Error {}
const fail = (path: string, why: string): never => { throw new LendWireError(`${path}: ${why}`); };

function record(v: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(path, "要是对象");
  const r = v as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !keys.includes(k));
  if (extra.length) fail(path, `不认识的字段 ${extra.slice(0, 3).join(", ")}`);
  const missing = keys.filter((k) => !(k in r));
  if (missing.length) fail(path, `缺字段 ${missing.join(", ")}`);
  if (path === "$" && r.v !== LEND_WIRE_VERSION) fail("v", `只认版本 ${LEND_WIRE_VERSION}`);
  return r;
}

const matching = (v: unknown, path: string, re: RegExp): string => (typeof v === "string" && re.test(v) ? v : fail(path, "格式不对"));
const int = (v: unknown, path: string, min: number, max: number): number =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : fail(path, `要是 ${min}–${max} 的整数`);
const oneOf = <T extends string>(v: unknown, path: string, all: readonly T[]): T => (all.includes(v as T) ? v as T : fail(path, `只认 ${all.join(" / ")}`));

const ORDER_ID = /^[\w.:-]{1,200}$/;
const WORKER = /^[\w.-]{1,64}$/;
const SESSION = /^[\w.:-]{1,200}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

function counts(v: unknown, path: string): Partial<Record<LendFamily, number>> {
  const r = v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : fail(path, "要是对象");
  const out: Partial<Record<LendFamily, number>> = {};
  for (const [k, n] of Object.entries(r)) out[oneOf(k, `${path}.${k}`, LEND_FAMILIES)] = int(n, `${path}.${k}`, 0, 100);
  return out;
}

function list<T>(v: unknown, path: string, max: number, read: (x: unknown, p: string) => T): T[] {
  if (!Array.isArray(v) || v.length > max) return fail(path, `要是不超过 ${max} 项的数组`);
  return v.map((x, i) => read(x, `${path}[${i}]`));
}

function parsePoll(raw: unknown): PollRequest {
  const r = record(raw, "$", ["v", "capacity"]);
  const c = record(r.capacity, "capacity", ["families", "busy", "roles", "repos", "ordersLeftToday"]);
  return { v: LEND_WIRE_VERSION, capacity: {
    families: counts(c.families, "capacity.families"), busy: counts(c.busy, "capacity.busy"),
    roles: list(c.roles, "capacity.roles", 2, (x, p) => oneOf(x, p, ["review"] as const)),
    repos: list(c.repos, "capacity.repos", 50, (x, p) => matching(x, p, REPO)), ordersLeftToday: int(c.ordersLeftToday, "capacity.ordersLeftToday", 0, 1000),
  } };
}

function parseClaim(raw: unknown): ClaimRequest {
  const r = record(raw, "$", ["v", "orderId", "worker"]);
  return { v: LEND_WIRE_VERSION, orderId: matching(r.orderId, "orderId", ORDER_ID), worker: matching(r.worker, "worker", WORKER) };
}

function parseLease(raw: unknown): LeaseRequest {
  const r = record(raw, "$", ["v", "orderId", "gen", "action", "reason", "detail"]);
  const action = oneOf(r.action, "action", ["renew", "release"] as const);
  const reason = r.reason === null ? null : oneOf(r.reason, "reason", ["not_started", "stopped"] as const);
  if ((action === "release") !== (reason !== null)) fail("reason", "release 必须带 not_started / stopped，renew 必须是 null");
  const detail = r.detail === null ? null : typeof r.detail === "string" && r.detail.length > 0 && Buffer.byteLength(r.detail) <= DETAIL_MAX &&
    !/[\p{Cc}\u2028\u2029]/u.test(r.detail) ? r.detail : fail("detail", `要是 null 或不超过 ${DETAIL_MAX} 字节的单行文字`);
  return { v: LEND_WIRE_VERSION, orderId: matching(r.orderId, "orderId", ORDER_ID), gen: int(r.gen, "gen", 1, 1e9), action, reason, detail };
}

/** findingId / family are identifiers A keeps and prints as they are: one that masking would change (a token, an address) is refused, never rewritten (T93 r1 P2-3) */
const plainId = (v: string, path: string): string => (sanitizeForeign(v) === v ? v : fail(path, "看着像凭据或地址，不收"));

function parseResult(raw: unknown): ResultRequest {
  const r = record(raw, "$", ["v", "orderId", "gen", "verdict", "report", "session"]);
  const verdict = parseVerdictWire(r.verdict);
  if (!verdict.ok) return fail("verdict", verdict.error);
  verdict.value.findings.forEach((f, i) => { plainId(f.findingId, `verdict.findings[${i}].findingId`); plainId(f.family, `verdict.findings[${i}].family`); });
  const orderId = matching(r.orderId, "orderId", ORDER_ID);
  if (verdict.value.orderId !== orderId) fail("verdict.orderId", "与请求的 orderId 不一致");
  if (typeof r.report !== "string" || r.report.length === 0 || Buffer.byteLength(r.report) > LEND_REPORT_MAX) fail("report", `要是非空且不超过 ${LEND_REPORT_MAX} 字节`);
  const s = record(r.session, "session", ["id", "family"]);
  return { v: LEND_WIRE_VERSION, orderId, gen: int(r.gen, "gen", 1, 1e9), verdict: verdict.value, report: r.report as string,
    session: { id: matching(s.id, "session.id", SESSION), family: oneOf(s.family, "session.family", LEND_FAMILIES) } };
}

const PARSERS = { poll: parsePoll, claim: parseClaim, lease: parseLease, result: parseResult } as const;
type Parsed = { poll: PollRequest; claim: ClaimRequest; lease: LeaseRequest; result: ResultRequest };

export function parseLendRequest<E extends LendEndpoint>(endpoint: E, raw: unknown): { ok: true; value: Parsed[E] } | { ok: false; error: string } {
  try {
    return { ok: true, value: PARSERS[endpoint](raw) as Parsed[E] };
  } catch (e) {
    if (e instanceof LendWireError) return { ok: false, error: e.message };
    throw e;
  }
}

export const pollLimit = (n: number): number => Math.min(n, POLL_MAX_ORDERS);
export const LEND_VERSION = LEND_WIRE_VERSION;
