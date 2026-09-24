/**
 * 本机实例的签名密钥（Ed25519，私钥只在 STATE_DIR/instance-key.pem，0600，第一次用到时生成）。
 *
 * 用途：跨实例请求带签名，对方能确认「这个请求真是那台机器发的」，而不只是「拿着那个 token」——
 * token 被抄走、或者以后经中转服务器转发时，签名仍然只有私钥持有者做得出来。
 * 现阶段只记录验签结果、不拦截（见 bridge/peer-signature.ts）；密钥与 instance-id 分开：
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

/** 协议里收到的公钥只认这种形状 */
export function isPublicKey(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v, "base64url").length === 32;
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

/** 时间戳允许的偏差：两台机器时钟差 + 网络，超过就当重放 */
const MAX_SKEW_S = 300;

export type SigCheck = "ok" | "bad" | "stale";

export function verifySigned(
  publicKey: string,
  req: { method: string; path: string; ts: string; sig: string; body: string | Uint8Array },
  now = Date.now(),
): SigCheck {
  const ts = Number(req.ts);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > MAX_SKEW_S) return "stale";
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, canonical(req.method, req.path, req.ts, req.body), pub, Buffer.from(req.sig, "base64url")) ? "ok" : "bad";
  } catch {
    return "bad"; // 公钥或签名格式坏了：和签名对不上是一回事
  }
}
