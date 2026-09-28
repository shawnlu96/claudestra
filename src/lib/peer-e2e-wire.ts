/**
 * peer 整体加密的线上格式（docs/relay/e2e-design.md §5.1；握手 §4.1.3、记录流 §4.1.4）：
 *   POST /api/v1/e2e/hello          {v, suite, from, to, ce, key}  →  {v, be, sid, ttl, confirm, key}
 *   POST /api/v1/e2e/<sid>/<rid>    记录流（application/octet-stream）→ 200 记录流，内层状态码在第 0 条里
 * 内层请求头走白名单：内层来自一个已认证的 peer，但它照样不许带 host / x-forwarded-* / 中继标记这类
 * 会影响「请求从哪来」判定的头——那些只由外层连接决定（lib/request-context 由调用方从外层复制）。
 */
import { fromB64url, toB64url } from "./e2e/encoding.js";

export const PEER_E2E_LABEL = "cstra-peer-e2e-v1";
/** 套件编号，记法同 HPKE：DHKEM(P-256) / HKDF-SHA256 / AES-256-GCM。换套件就换标签版本，所以它也绑进了 th */
export const PEER_E2E_SUITE = { kem: 0x0010, kdf: 0x0001, aead: 0x0002 } as const;
export const E2E_HELLO_PATH = "/api/v1/e2e/hello";
export const E2E_CONTENT_TYPE = "application/octet-stream";
/** 会话有效期（秒）：24 小时，响应里报给发起方，它据此提前换会话 */
export const E2E_SESSION_TTL_S = 24 * 3600;

const FP_RE = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/;
const RECORD_PATH_RE = /^\/api\/v1\/e2e\/([A-Za-z0-9_-]{22})\/([1-9]\d{0,16})$/;
const RID_LIMIT = 1n << 56n;
const INNER_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const INNER_REQ_HEADERS = new Set(["authorization", "content-type", "accept", "x-claudestra-key", "x-claudestra-ts", "x-claudestra-sig"]);
const INNER_RES_HEADERS = new Set(["content-type", "retry-after"]);
const PATH_MAX = 2048;

export interface Hello {
  from: string;
  to: string;
  ce: Uint8Array;
  key: unknown;
}

export interface HelloReply {
  be: Uint8Array;
  sid: Uint8Array;
  ttl: number;
  confirm: Uint8Array;
  key: unknown;
}

const bytes = (v: unknown, len: number): Uint8Array | null => {
  const b = typeof v === "string" ? fromB64url(v) : null;
  return b && b.length === len ? b : null;
};

export const encodeHello = (h: Hello): string =>
  JSON.stringify({ v: 1, suite: PEER_E2E_SUITE, from: h.from, to: h.to, ce: toB64url(h.ce), key: h.key });

/** 形状不对 → 带原因的 error；套件不认识单独报 e2e_suite，发起方据此知道是版本不配，而不是被改了 */
export function parseHello(raw: unknown): Hello | { error: "e2e_bad_hello" | "e2e_suite" } {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== 1) return { error: "e2e_bad_hello" };
  const s = o.suite as Record<string, unknown> | null;
  if (!s || s.kem !== PEER_E2E_SUITE.kem || s.kdf !== PEER_E2E_SUITE.kdf || s.aead !== PEER_E2E_SUITE.aead) return { error: "e2e_suite" };
  const ce = bytes(o.ce, 65);
  if (typeof o.from !== "string" || !FP_RE.test(o.from) || typeof o.to !== "string" || !FP_RE.test(o.to) || !ce) return { error: "e2e_bad_hello" };
  return { from: o.from, to: o.to, ce, key: o.key };
}

export const encodeHelloReply = (r: HelloReply): string =>
  JSON.stringify({ v: 1, be: toB64url(r.be), sid: toB64url(r.sid), ttl: r.ttl, confirm: toB64url(r.confirm), key: r.key });

export function parseHelloReply(raw: unknown): HelloReply | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== 1) return null;
  const be = bytes(o.be, 65), sid = bytes(o.sid, 16), confirm = bytes(o.confirm, 32);
  if (!be || !sid || !confirm || !Number.isSafeInteger(o.ttl) || (o.ttl as number) <= 0) return null;
  return { be, sid, ttl: o.ttl as number, confirm, key: o.key };
}

export const recordPath = (sid: Uint8Array, rid: bigint): string => `/api/v1/e2e/${toB64url(sid)}/${rid}`;

/** /api/v1/e2e/<sid>/<rid>：sid 16 字节 base64url，rid 规范十进制（无前导 0）且 1 ≤ rid < 2^56；否则 null */
export function parseRecordPath(path: string): { sid: Uint8Array; rid: bigint } | null {
  const m = RECORD_PATH_RE.exec(path);
  if (!m) return null;
  const sid = fromB64url(m[1]);
  const rid = BigInt(m[2]);
  return sid && sid.length === 16 && rid < RID_LIMIT ? { sid, rid } : null;
}

export interface InnerHead {
  method: string;
  path: string;
  headers: Record<string, string>;
}

const pickHeaders = (h: Headers | Record<string, string>, allow: Set<string>): Record<string, string> => {
  const out: Record<string, string> = {};
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h);
  for (const [k, v] of entries) if (allow.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
};

export const encodeInnerHead = (method: string, path: string, headers: Headers | Record<string, string>): string =>
  JSON.stringify({ method: method.toUpperCase(), path, headers: pickHeaders(headers, INNER_REQ_HEADERS) });

/** 内层请求只许打 /api/v1/ 下、非 /api/v1/e2e/ 的路径（不套娃），方法与头走白名单 */
export function parseInnerHead(raw: unknown): InnerHead | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.method !== "string" || typeof o.path !== "string") return null;
  if (!INNER_METHODS.has(o.method) || o.path.length > PATH_MAX || !o.path.startsWith("/api/v1/") || o.path.startsWith("/api/v1/e2e/")) return null;
  if (o.path.includes("..") || o.path.includes("#") || /[\s\\]/.test(o.path)) return null;
  const h = o.headers;
  if (!h || typeof h !== "object" || Object.values(h).some((v) => typeof v !== "string")) return null;
  return { method: o.method, path: o.path, headers: pickHeaders(h as Record<string, string>, INNER_REQ_HEADERS) };
}

export const encodeResponseHead = (status: number, headers: Headers): string =>
  JSON.stringify({ status, headers: pickHeaders(headers, INNER_RES_HEADERS) });

export function parseResponseHead(raw: unknown): { status: number; headers: Record<string, string> } | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !Number.isInteger(o.status) || (o.status as number) < 200 || (o.status as number) > 599) return null;
  const h = o.headers;
  if (!h || typeof h !== "object" || Object.values(h).some((v) => typeof v !== "string")) return null;
  return { status: o.status as number, headers: pickHeaders(h as Record<string, string>, INNER_RES_HEADERS) };
}

/** 收方的明文错误体：只有 code，不带任何细节（中继看得到它，也能伪造它） */
export const e2eError = (status: number, code: string): Response => Response.json({ ok: false, code }, { status });
