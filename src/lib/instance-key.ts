/**
 * 本机实例的签名密钥（Ed25519，私钥只在 STATE_DIR/instance-key.pem，0600，第一次用到时生成）。
 *
 * 用途：跨实例请求带签名，对方能确认「这个请求真是那台机器发的」，而不只是「拿着那个 token」——
 * token 被抄走、或者以后经中转服务器转发时，签名仍然只有私钥持有者做得出来。
 * 接收方对 peer token 强制验签（bridge/peer-signature.ts、lib/peer-trust.ts）；密钥与 instance-id 分开：
 * instance-id 是对方自报的合并标识，这个才是凭据。纯逻辑部分单测在 tests/instance-key.test.ts。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";

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

/** 给人核对用的指纹：公钥 sha256 的前 16 位十六进制，四位一组 */
export function keyFingerprint(publicKey: string): string {
  const hex = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
  return hex.match(/.{4}/g)!.join("-");
}

const publicOf = (k: KeyObject): string => String(createPublicKey(k).export({ format: "jwk" }).x);

const cache = new Map<string, InstanceKey>();

/** 读（或生成）本机密钥；读写失败返回 null——调用方照常发请求，只是不带签名 */
export function instanceKeySync(dir: string = STATE_DIR): InstanceKey | null {
  const hit = cache.get(dir);
  if (hit) return hit;
  const path = join(dir, "instance-key.pem");
  try {
    let pem: string;
    try {
      pem = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // 先写临时文件再 link：两个进程同时首用时只有一个 link 成功，另一个读回它的
      mkdirSync(dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
      try {
        linkSync(tmp, path);
      } catch (le) {
        if ((le as NodeJS.ErrnoException).code !== "EEXIST") throw le;
      } finally {
        rmSync(tmp, { force: true });
      }
      pem = readFileSync(path, "utf8");
    }
    const privateKey = createPrivateKey(pem);
    const key = { publicKey: publicOf(privateKey), privateKey };
    cache.set(dir, key);
    return key;
  } catch (e) {
    console.error(`⚠️ 读写 ${path} 失败，跨实例请求这次不带签名: ${(e as Error).message}`);
    return null;
  }
}

/** 签名覆盖的内容：方法、路径（含查询串）、时间戳、正文哈希——换任何一样签名都对不上 */
function canonical(method: string, path: string, ts: string, body: string | Uint8Array): Buffer {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return Buffer.from(`claudestra-req-v1\n${method.toUpperCase()}\n${path}\n${ts}\n${bodyHash}`);
}

export const SIG_HEADERS = { key: "x-claudestra-key", ts: "x-claudestra-ts", sig: "x-claudestra-sig" } as const;

/** 出站请求要加的三个头；本机没有密钥时返回空对象 */
export function signedHeaders(method: string, path: string, body: string | Uint8Array, key = instanceKeySync(), now = Date.now()): Record<string, string> {
  if (!key) return {};
  const ts = String(Math.floor(now / 1000));
  const sig = sign(null, canonical(method, path, ts, body), key.privateKey).toString("base64url");
  return { [SIG_HEADERS.key]: key.publicKey, [SIG_HEADERS.ts]: ts, [SIG_HEADERS.sig]: sig };
}

/** 按完整 URL 签（对方看到的是 pathname + 查询串）；URL 解析不了就不签 */
export function signedFor(method: string, url: string, body: string | Uint8Array): Record<string, string> {
  try {
    const u = new URL(url);
    return signedHeaders(method, u.pathname + u.search, body);
  } catch {
    return {}; // 地址本身有问题，请求自己会失败并按原逻辑报错；签名不是这里该报的事
  }
}

/**
 * 按用途签一段文本（不是 HTTP 请求）：第一行是用途前缀，签给一种用途的签名挪不到另一种用途、也挪不成请求签名
 * （请求签名的第一行固定是 claudestra-req-v1）。字段里不许有换行，否则字段边界能被挪动。
 */
function purposeMessage(purpose: string, fields: string[]): Buffer | null {
  if (!/^claudestra-[a-z-]+-v\d+$/.test(purpose) || purpose === "claudestra-req-v1" || fields.some((f) => /[\r\n]/.test(f))) return null;
  return Buffer.from([purpose, ...fields].join("\n"));
}

export function signPurpose(purpose: string, fields: string[], key = instanceKeySync()): { key: string; sig: string } | null {
  const msg = purposeMessage(purpose, fields);
  return key && msg ? { key: key.publicKey, sig: sign(null, msg, key.privateKey).toString("base64url") } : null;
}

export function verifyPurpose(publicKey: string, purpose: string, fields: string[], sig: string): boolean {
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
