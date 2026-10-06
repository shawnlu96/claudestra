/**
 * 本机实例的签名密钥（Ed25519，私钥只在 STATE_DIR/instance-key.pem，0600，第一次用到时生成）。
 *
 * 用途：跨实例请求带签名，对方能确认「这个请求真是那台机器发的」，而不只是「拿着那个 token」——
 * token 被抄走、或者以后经中转服务器转发时，签名仍然只有私钥持有者做得出来。
 * 接收方对 peer token 强制验签（bridge/peer-signature.ts、lib/peer-trust.ts）；密钥与 instance-id 分开：
 * instance-id 是对方自报的合并标识，这个才是凭据。纯逻辑部分单测在 tests/instance-key.test.ts。
 * 纯签名 / 验签在 instance-signature.ts（不读本机状态）；这里只管默认本机钥匙与文件，并保留旧导出路径。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { join } from "node:path";
import {
  signedHeaders as signedHeadersWith, signPurpose as signPurposeWith,
  type InstanceKey, type SignPurpose,
} from "./instance-signature.js";
import { readOrCreateKeyFile } from "./key-file.js";
import { STATE_DIR } from "./paths.js";

export {
  isPublicKey, MAX_SKEW_S, SIG_HEADERS, verifyPurpose, verifySigned,
  type InstanceKey, type SigCheck, type SignPurpose,
} from "./instance-signature.js";

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
    const pem = readOrCreateKeyFile(path, () => String(generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" })));
    const privateKey = createPrivateKey(pem);
    const key = { publicKey: publicOf(privateKey), privateKey };
    cache.set(dir, key);
    return key;
  } catch (e) {
    console.error(`⚠️ 读写 ${path} 失败，跨实例请求这次不带签名: ${(e as Error).message}`);
    return null;
  }
}

/** 出站请求要加的三个头；本机没有密钥时返回空对象 */
export function signedHeaders(method: string, path: string, body: string | Uint8Array, key = instanceKeySync(), now = Date.now()): Record<string, string> {
  return signedHeadersWith(method, path, body, key, now);
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

/** 不给钥匙时用本机钥匙签；用途白名单与原文拼法见 instance-signature.ts */
export function signPurpose(purpose: SignPurpose, fields: string[], key = instanceKeySync()): { key: string; sig: string } | null {
  return signPurposeWith(purpose, fields, key);
}
