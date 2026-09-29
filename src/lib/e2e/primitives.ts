/**
 * E2E 用到的 WebCrypto 原语（套件固定为 P-256 + HKDF-SHA256 + AES-256-GCM，docs/relay/e2e-design.md §4.1.1）。
 * 公钥一律 SEC1 未压缩 65 字节；导入时由 WebCrypto 校验点在曲线上，不合法的公钥在这里就被拒，不会进到 ECDH。
 * 私钥默认不可导出：浏览器侧要求设备密钥存进 IndexedDB 后拿不走，bridge 侧没这条限制也照同一个默认。
 */
import { concat, toB64url, type Bytes } from "./encoding.js";

const EC = { name: "ECDH", namedCurve: "P-256" } as const;
const PUB_LEN = 65;

export interface EcdhPair {
  priv: CryptoKey;
  /** SEC1 未压缩公钥 */
  pub: Bytes;
}

export const randomBytes = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));

export async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(...parts)));
}

export async function generateEcdh(): Promise<EcdhPair> {
  const kp = await crypto.subtle.generateKey(EC, false, ["deriveBits"]);
  return { priv: kp.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)) };
}

/** 形状不对（不是 65 字节的 0x04 开头）或点不在曲线上 → null */
export async function importPub(raw: Uint8Array): Promise<CryptoKey | null> {
  if (raw.length !== PUB_LEN || raw[0] !== 4) return null;
  try {
    return await crypto.subtle.importKey("raw", concat(raw), EC, true, []);
  } catch {
    return null; // 点不在曲线上：WebCrypto 拒导入，调用方把它当「对方公钥无效」处理
  }
}

/** 由私钥标量 d 和对应公钥导入：测试向量与 bridge 读 PEM 都走这里（JWK 必须同时给 x、y） */
export async function importPair(d: Uint8Array, pub: Uint8Array): Promise<EcdhPair> {
  if (d.length !== 32 || pub.length !== PUB_LEN || pub[0] !== 4) throw new Error("bad P-256 key material");
  const jwk = { kty: "EC", crv: "P-256", d: toB64url(d), x: toB64url(pub.subarray(1, 33)), y: toB64url(pub.subarray(33)), ext: false };
  return { priv: await crypto.subtle.importKey("jwk", jwk, EC, false, ["deriveBits"]), pub: concat(pub) };
}

/** ECDH 共享秘密：x 坐标 32 字节（与 RFC 9180 DHKEM(P-256) 的 DH() 输出一致） */
export async function ecdh(priv: CryptoKey, pub: CryptoKey): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
}

export async function hkdfBytes(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", concat(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: concat(salt), info: concat(info) }, k, len * 8));
}

export const aesKey = (raw: Uint8Array): Promise<CryptoKey> => crypto.subtle.importKey("raw", concat(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
export const hmacKey = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", concat(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function hmac(key: CryptoKey, data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, concat(data)));
}

/** 常数时间比较交给 WebCrypto 的 verify */
export const hmacVerify = (key: CryptoKey, mac: Uint8Array, data: Uint8Array): Promise<boolean> => crypto.subtle.verify("HMAC", key, concat(mac), concat(data));

export async function gcmSeal(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: concat(nonce), additionalData: concat(aad) }, key, concat(pt)));
}

/** tag 不对 → null（调用方按「解密失败」处理，不区分原因） */
export async function gcmOpen(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Promise<Bytes | null> {
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: concat(nonce), additionalData: concat(aad) }, key, concat(ct)));
  } catch {
    return null; // WebCrypto 只抛 OperationError，没有更多信息可留
  }
}
