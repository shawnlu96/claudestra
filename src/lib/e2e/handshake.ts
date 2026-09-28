/**
 * 会话握手（docs/relay/e2e-design.md §4.1.3，参照 Noise KK：双方事先都知道对方的静态公钥）。
 *   ikm = lp(ECDH(ce,be), ECDH(D,be), ECDH(ce,M), ECDH(D,M))
 *   th  = SHA-256(lp(label, fp, devId, ce, be, sid))
 *   key_c2b / key_b2c / key_confirm = HKDF(ikm, salt = th, info = "c2b" / "b2c" / "confirm")；confirm = HMAC(key_confirm, th)
 * 发起方（浏览器或 peer 发起方，静态钥 D）先发 ce；响应方（bridge，静态钥 M）回 be、sid、confirm。
 * 认证全来自 DH：没有 D 算不出 ECDH(D,·)，没有 M 算不出 ECDH(·,M)，所以 hello 不带签名；confirm 对上才算握手成功。
 */
import { concat, lp, utf8, type Bytes } from "./encoding.js";
import { aesKey, ecdh, generateEcdh, hkdfBytes, hmac, hmacKey, hmacVerify, importPub, randomBytes, sha256, type EcdhPair } from "./primitives.js";
import { E2E_LABEL, SID_LEN } from "./records.js";

export interface SessionKeys {
  c2b: CryptoKey;
  b2c: CryptoKey;
  th: Bytes;
}

/** 两端都要一致的上下文：fp = 响应方机器指纹，devId = 发起方标识（浏览器是 SHA-256(设备公钥)） */
export interface HandshakeScope {
  fp: string;
  devId: Uint8Array;
  label?: string;
}

const transcriptHash = (s: HandshakeScope, ce: Uint8Array, be: Uint8Array, sid: Uint8Array): Promise<Bytes> =>
  sha256(lp(s.label ?? E2E_LABEL, s.fp, s.devId, ce, be, sid));

async function derive(dhs: Uint8Array[], th: Bytes): Promise<{ keys: SessionKeys; confirmKey: CryptoKey }> {
  const ikm = lp(...dhs);
  const sub = (info: string) => hkdfBytes(ikm, th, utf8(info), 32);
  const [c2b, b2c, conf] = await Promise.all([sub("c2b"), sub("b2c"), sub("confirm")]);
  return { keys: { c2b: await aesKey(c2b), b2c: await aesKey(b2c), th }, confirmKey: await hmacKey(conf) };
}

async function pubOrThrow(raw: Uint8Array, what: string): Promise<CryptoKey> {
  const k = await importPub(raw);
  if (!k) throw new Error(`e2e handshake: invalid ${what}`);
  return k;
}

export interface Response {
  be: Bytes;
  sid: Bytes;
  confirm: Bytes;
  keys: SessionKeys;
}

/** 响应方：M = 本机静态钥，remoteStatic = 发起方静态公钥（配对 / 邀请时钉住的），ce = 发起方临时公钥 */
export async function respond(
  s: HandshakeScope,
  p: { local: EcdhPair; remoteStatic: Uint8Array; ce: Uint8Array; ephemeral?: EcdhPair; sid?: Uint8Array },
): Promise<Response> {
  const [ce, d] = [await pubOrThrow(p.ce, "ephemeral key"), await pubOrThrow(p.remoteStatic, "static key")];
  const e = p.ephemeral ?? (await generateEcdh());
  const sid = p.sid ? concat(p.sid) : randomBytes(SID_LEN);
  if (sid.length !== SID_LEN) throw new RangeError("sid must be 16 bytes");
  const dhs = [await ecdh(e.priv, ce), await ecdh(e.priv, d), await ecdh(p.local.priv, ce), await ecdh(p.local.priv, d)];
  const th = await transcriptHash(s, p.ce, e.pub, sid);
  const { keys, confirmKey } = await derive(dhs, th);
  return { be: e.pub, sid, confirm: await hmac(confirmKey, th), keys };
}

/** 发起方：local = D，ephemeral = 发 hello 时的临时钥，remoteStatic = M。confirm 不对 → null（对面不持有 M，或被改过） */
export async function finish(
  s: HandshakeScope,
  p: { local: EcdhPair; ephemeral: EcdhPair; remoteStatic: Uint8Array; be: Uint8Array; sid: Uint8Array; confirm: Uint8Array },
): Promise<SessionKeys | null> {
  if (p.sid.length !== SID_LEN) return null;
  const be = await importPub(p.be);
  if (!be) return null;
  const m = await pubOrThrow(p.remoteStatic, "static key");
  const dhs = [await ecdh(p.ephemeral.priv, be), await ecdh(p.local.priv, be), await ecdh(p.ephemeral.priv, m), await ecdh(p.local.priv, m)];
  const th = await transcriptHash(s, p.ephemeral.pub, p.be, p.sid);
  const { keys, confirmKey } = await derive(dhs, th);
  return (await hmacVerify(confirmKey, p.confirm, th)) ? keys : null;
}
