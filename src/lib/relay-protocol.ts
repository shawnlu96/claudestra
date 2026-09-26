/**
 * 中继协议 v2 的共享部分（docs/relay/protocol.md）：常量、帧形状校验、握手 canonical、slug / 短码规则。
 * 服务端（src/relay/）与客户端（src/lib/relay-client.ts）都只从这里取，协议常量不许在别处再写一遍——
 * 两边一旦各写一份，改一处漏一处就是线上握手失败。只依赖 node:crypto；不读文件、不碰网络。
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const PROTOCOL_VERSION = 2;
export const SUBPROTOCOL = "claudestra-relay.v2";
const AUTH_CANONICAL_PREFIX = "claudestra-relay-auth-v2";
/** 隧道请求的 from；实例据此区分「浏览器经中继」与「别的实例」 */
export const RELAY_FROM = "relay";
export const RELAY_FROM_HEADER = "x-claudestra-relay-from";
export const RELAY_BASE_HEADER = "x-claudestra-relay-base";
/** 兑换邀请：目标还没把发起方列为联系人时唯一放行的路径（§4） */
export const REDEEM_PATH = "/api/v1/peers/redeem";

export const LIMITS = {
  maxFrameBytes: 256 * 1024,
  maxChunkBytes: 160 * 1024,
  maxReqTimeoutMs: 180_000,
  defaultReqTimeoutMs: 40_000,
  heartbeatMs: 25_000,
  pongTimeoutMs: 20_000,
  idleTimeoutMs: 75_000,
  authTimeoutMs: 10_000,
  nonceTtlMs: 60_000,
  streamIdleMs: 600_000,
  streamMaxMs: 3_600_000,
  reqPerMinute: 120,
  maxInflight: 64,
  authPerIpPerMinute: 10,
  redeemPerMinute: 6,
  maxContacts: 500,
  maxCodesPerInstance: 5,
  codeTtlMs: 10 * 60_000,
  fatalRetryMs: 300_000,
  /** front（§6.1）：短码查询按 IP 限流；隧道请求按 IP 限流（一页几十个资源，别卡正常浏览）；每台实例在途隧道请求上限 */
  codeLookupPerIpPerMinute: 30,
  tunnelPerIpPerMinute: 600,
  maxTunnelInflightPerInstance: 256,
} as const;

/** WebSocket 关闭码（§8）；1009 是 Bun 在硬上限处自己发的 */
export const CLOSE = {
  NORMAL: 1000,
  RESTART: 1012,
  PROTOCOL: 4400,
  AUTH: 4401,
  DIRECTORY: 4403,
  TIMEOUT: 4408,
  REPLACED: 4409,
  TOO_LARGE: 4413,
  RATE: 4429,
} as const;

/** 收到这些错误码再连也没用，退避 fatalRetryMs */
export const FATAL_CODES: ReadonlySet<string> = new Set(["protocol_version", "auth_failed", "fingerprint_conflict", "replaced"]);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const FP_RE = /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/;
export const NAME_RE = /^[\p{L}\p{N} ._-]{1,64}$/u;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** 短码字母表：去掉 0/O/1/I（§5.2） */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

// ── 公钥、指纹、握手签名 ────────────────────────────────────────────────

export function isPublicKey(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, "base64url").length === 32;
}

export function keyFingerprint(publicKey: string): string {
  const hex = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
  return hex.match(/.{4}/g)!.join("-");
}

function authCanonical(nonce: string, key: string, name: string, slug: string): Buffer {
  return Buffer.from(`${AUTH_CANONICAL_PREFIX}\n${nonce}\n${key}\n${name}\n${slug}`);
}

export function authSignature(privateKey: KeyObject, nonce: string, key: string, name: string, slug: string): string {
  return sign(null, authCanonical(nonce, key, name, slug), privateKey).toString("base64url");
}

export function verifyAuthSignature(key: string, nonce: string, name: string, slug: string, sig: string): boolean {
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key }, format: "jwk" });
    return verify(null, authCanonical(nonce, key, name, slug), pub, Buffer.from(sig, "base64url"));
  } catch {
    return false; // 公钥或签名不是合法编码：和签名对不上是一回事
  }
}

// ── slug 与短码 ──────────────────────────────────────────────────────────

/** 主机名 / 任意字符串 → 合法 slug；什么都不剩就退回 "claudestra" */
export function slugify(raw: string): string {
  const s = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return SLUG_RE.test(s) ? s : "claudestra";
}

/** 冲突时的候选顺序：原样 → 加指纹前 4 位 → 加前 8 位（§5.1） */
export function slugCandidates(wanted: string, fp: string): string[] {
  const hex = fp.replace(/-/g, "");
  const cut = (n: number) => `${wanted.slice(0, 32 - n - 1)}-${hex.slice(0, n)}`;
  return [wanted, cut(4), cut(8)];
}

/** 用户输入的短码规整成 8 位大写、去中划线与空格；形状不对返回 null */
export function normalizeCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** 展示用 XXXX-XXXX */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function randomCode(random: (n: number) => Uint8Array): string {
  const bytes = random(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

// ── 帧 ──────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
export type Headers = Record<string, string>;

export interface AuthFrame { t: "auth"; v: number; key: string; name: string; slug: string; sig: string }
export interface ReqFrame {
  t: "req";
  id: string;
  to?: string;
  from?: string;
  timeoutMs?: number;
  method: string;
  path: string;
  headers: Headers;
  body?: string;
  more?: boolean;
}
export interface ResFrame { t: "res"; id: string; to?: string; from?: string; status: number; headers: Headers; body?: string; more?: boolean }
export interface DataFrame { t: "data"; id: string; to?: string; from?: string; b64: string }
export interface EndFrame { t: "end"; id: string; to?: string; from?: string }
export interface CancelFrame { t: "cancel"; id: string; to?: string; from?: string }
export interface ErrorFrame { t: "error"; id?: string; to?: string; from?: string; code: string; message?: string; origin: "relay" | "peer" | "client" }
export interface ContactsFrame { t: "contacts"; fps: string[] }
export interface CodeFrame { t: "code"; op: "put" | "del"; code: string; exp?: number }
export interface PeerRecord { fp: string; slug: string; name: string; online: boolean; lastSeen: string; mutual?: boolean }

/** 文本 → 对象；不是带字符串 t 的 JSON 对象都算坏帧 */
export function parseFrame(raw: string): Obj | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) && typeof v.t === "string" ? (v as Obj) : null;
  } catch {
    return null; // 坏 JSON 就是坏帧，调用方按 frame_invalid 处理，不需要异常信息
  }
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optFp = (v: unknown): v is string | undefined => v === undefined || (str(v) && FP_RE.test(v));
const optBody = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";

/** headers 只认字符串值，键统一小写；不是对象就当空 */
export function normalizeHeaders(h: unknown): Headers {
  const out: Headers = {};
  if (!h || typeof h !== "object") return out;
  for (const [k, v] of Object.entries(h as Obj)) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

export function asAuth(f: Obj): AuthFrame | null {
  if (f.t !== "auth" || typeof f.v !== "number" || !str(f.key) || !str(f.name) || !str(f.slug) || !str(f.sig)) return null;
  return { t: "auth", v: f.v, key: f.key, name: f.name, slug: f.slug, sig: f.sig };
}

export function asReq(f: Obj): ReqFrame | null {
  if (f.t !== "req" || !str(f.id) || !ID_RE.test(f.id) || !optFp(f.to) || !str(f.method) || !str(f.path) || !optBody(f.body)) return null;
  const from = f.from === RELAY_FROM || optFp(f.from) ? (f.from as string | undefined) : null;
  if (from === null) return null;
  const timeoutMs = typeof f.timeoutMs === "number" && Number.isFinite(f.timeoutMs) ? f.timeoutMs : undefined;
  return {
    t: "req", id: f.id, to: f.to, from, timeoutMs, method: f.method.toUpperCase(), path: f.path,
    headers: normalizeHeaders(f.headers), body: f.body, more: f.more === true,
  };
}

export function asRes(f: Obj): ResFrame | null {
  if (f.t !== "res" || !str(f.id) || !ID_RE.test(f.id) || !optFp(f.to) || !optBody(f.body)) return null;
  if (typeof f.status !== "number" || f.status < 100 || f.status > 599) return null;
  return { t: "res", id: f.id, to: f.to, status: Math.trunc(f.status), headers: normalizeHeaders(f.headers), body: f.body, more: f.more === true };
}

export function asData(f: Obj): DataFrame | null {
  if (f.t !== "data" || !str(f.id) || !ID_RE.test(f.id) || !optFp(f.to) || typeof f.b64 !== "string") return null;
  return { t: "data", id: f.id, to: f.to, b64: f.b64 };
}

/** end 与 cancel 形状相同，只差 t */
export function asEndOrCancel(f: Obj): EndFrame | CancelFrame | null {
  if ((f.t !== "end" && f.t !== "cancel") || !str(f.id) || !ID_RE.test(f.id) || !optFp(f.to)) return null;
  return { t: f.t, id: f.id, to: f.to };
}

/** 实例发出的 error（origin=peer）必须带 id；`to` 是发起方指纹，答隧道请求（from:"relay"）时省略 */
export function asPeerError(f: Obj): (ErrorFrame & { id: string }) | null {
  if (f.t !== "error" || !str(f.id) || !ID_RE.test(f.id) || !optFp(f.to) || !str(f.code)) return null;
  return { t: "error", id: f.id, to: f.to, code: f.code, message: typeof f.message === "string" ? f.message : undefined, origin: "peer" };
}

export function asContacts(f: Obj): ContactsFrame | null {
  if (f.t !== "contacts" || !Array.isArray(f.fps) || f.fps.length > LIMITS.maxContacts) return null;
  const fps = f.fps.filter((x): x is string => str(x) && FP_RE.test(x));
  return fps.length === f.fps.length ? { t: "contacts", fps: [...new Set(fps)] } : null;
}

export function asCode(f: Obj): CodeFrame | null {
  if (f.t !== "code" || (f.op !== "put" && f.op !== "del") || typeof f.code !== "string") return null;
  const code = normalizeCode(f.code);
  if (!code) return null;
  const exp = typeof f.exp === "number" && Number.isFinite(f.exp) ? f.exp : undefined;
  if (f.op === "put" && exp === undefined) return null;
  return { t: "code", op: f.op, code, exp };
}

/** 请求路径规整后必须在 /api/v1 下（peer 路径两端都查） */
export function apiPathOk(path: string): boolean {
  try {
    const p = new URL(path, "http://x").pathname.replace(/\/{2,}/g, "/");
    return p === "/api/v1" || p.startsWith("/api/v1/");
  } catch {
    return false; // 连 URL 都解析不了的路径肯定不在 /api/v1 下
  }
}

/** 兑换邀请这一条允许陌生实例敲门 */
export function isRedeemRequest(method: string, path: string): boolean {
  try {
    return method.toUpperCase() === "POST" && new URL(path, "http://x").pathname === REDEEM_PATH;
  } catch {
    return false; // 解析失败就不是兑换
  }
}

export function newRequestId(random: (n: number) => Uint8Array): string {
  const tail = Buffer.from(random(4)).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "x";
  return `r_${Date.now()}_${tail}`;
}

/** .env 里通常只写 wss://<base>；协议端点是 /v1/ws（§1），没写路径就补上，写了别的路径（反代挂在子路径下）照用 */
export function relayWsEndpoint(relayUrl: string): string {
  const u = new URL(relayUrl);
  if (u.pathname === "" || u.pathname === "/") u.pathname = "/v1/ws";
  return u.toString();
}
