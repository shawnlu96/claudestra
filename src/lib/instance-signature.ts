/**
 * 实例钥匙的纯签名 / 验签（Ed25519）：请求签名原文、按用途签文本、公钥与签名的规范编码。
 * 这里不读任何本机状态：签名函数一律显式接收钥匙；默认本机钥匙、密钥文件读写都在 instance-key.ts（旧导出照旧从那里拿）。
 * 单测在 tests/instance-key.test.ts、tests/cloud-protocol-core-*.test.ts。
 */
import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export interface InstanceKey {
  /** 公钥：Ed25519 原始 32 字节的 base64url（43 个字符） */
  publicKey: string;
  privateKey: KeyObject;
}

/**
 * 协议里收到的公钥只认这种形状，而且只认规范编码：末字符有两位不参与解码，一把钥匙本来能写成四种串，
 * 钉住、比对都按原串做，多种写法会被当成换了钥匙（与签名同口径，见 isCanonicalSig）
 */
export function isPublicKey(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, "base64url").toString("base64url") === v;
}

/** 签名覆盖的内容：方法、路径（含查询串）、时间戳、正文哈希——换任何一样签名都对不上 */
function canonical(method: string, path: string, ts: string, body: string | Uint8Array): Buffer {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return Buffer.from(`claudestra-req-v1\n${method.toUpperCase()}\n${path}\n${ts}\n${bodyHash}`);
}

export const SIG_HEADERS = { key: "x-claudestra-key", ts: "x-claudestra-ts", sig: "x-claudestra-sig" } as const;

/** 出站请求要加的三个头；没有钥匙时返回空对象 */
export function signedHeaders(method: string, path: string, body: string | Uint8Array, key: InstanceKey | null, now = Date.now()): Record<string, string> {
  if (!key) return {};
  const ts = String(Math.floor(now / 1000));
  const sig = sign(null, canonical(method, path, ts, body), key.privateKey).toString("base64url");
  return { [SIG_HEADERS.key]: key.publicKey, [SIG_HEADERS.ts]: ts, [SIG_HEADERS.sig]: sig };
}

/**
 * 实例钥匙按用途签文本时认的用途（白名单）。第一行是用途前缀，签给一种用途的签名挪不到另一种用途，也挪不成请求签名
 * （claudestra-req-v1）或中继登录签名（claudestra-relay-auth-v2）——这两种的原文拼法和这里一样，所以只认登记过的用途，
 * 新用途在这里加一行，首行不能和任何已有签名原文相同。
 */
const SIGN_PURPOSES = ["claudestra-invite-pop-v1", "claudestra-lend-receipt-v1", "claudestra-shared-ledger-v1", "claudestra-lend-review-ticket-v1"] as const;
export type SignPurpose = (typeof SIGN_PURPOSES)[number];

/** 字段里不许有换行，否则字段边界能被挪动 */
function purposeMessage(purpose: string, fields: string[]): Buffer | null {
  if (!(SIGN_PURPOSES as readonly string[]).includes(purpose) || fields.some((f) => /[\r\n]/.test(f))) return null;
  return Buffer.from([purpose, ...fields].join("\n"));
}

export function signPurpose(purpose: SignPurpose, fields: string[], key: InstanceKey | null): { key: string; sig: string } | null {
  const msg = purposeMessage(purpose, fields);
  return key && msg ? { key: key.publicKey, sig: sign(null, msg, key.privateKey).toString("base64url") } : null;
}

export function verifyPurpose(publicKey: string, purpose: SignPurpose, fields: string[], sig: string): boolean {
  const msg = purposeMessage(purpose, fields);
  if (!msg || !isPublicKey(publicKey) || !isCanonicalSig(sig)) return false;
  try {
    return verify(null, msg, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }), Buffer.from(sig, "base64url"));
  } catch {
    return false; // 公钥解析不了：和签名对不上是一回事
  }
}

/** 时间戳允许的偏差：两台机器时钟差 + 网络，超过就当重放 */
export const MAX_SKEW_S = 300;

export type SigCheck = "ok" | "bad" | "stale";

/** Ed25519 签名 64 字节 = 86 个 base64url 字符（无填充） */
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

/**
 * 签名串必须是规范编码：Node 的 base64url 解码很宽松（补 =、夹非法字符、改末字符里用不到的低位都解出同样的字节），
 * 不规范的写法一律当 bad——防重放按签名去重（lib/peer-trust.ts ReplayCache），同一签名只能有一种写法。
 */
function isCanonicalSig(sig: string): boolean {
  return SIG_RE.test(sig) && Buffer.from(sig, "base64url").toString("base64url") === sig;
}

export function verifySigned(
  publicKey: string,
  req: { method: string; path: string; ts: string; sig: string; body: string | Uint8Array },
  now = Date.now(),
): SigCheck {
  const ts = Number(req.ts);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_S) return "stale";
  if (!isCanonicalSig(req.sig)) return "bad";
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, canonical(req.method, req.path, req.ts, req.body), pub, Buffer.from(req.sig, "base64url")) ? "ok" : "bad";
  } catch {
    return "bad"; // 公钥或签名格式坏了：和签名对不上是一回事
  }
}
