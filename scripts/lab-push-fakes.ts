/**
 * 假推送的共用件（测试与沙箱 lab 的假推送端点 scripts/sandbox-lab-relay.ts 共用）：本地自签名证书（openssl 生成，给假推送服务 /
 * 假 APNs 的 TLS 用）、能通过 web-push 加密的假订阅，以及像浏览器那样解开推送正文。
 * 生产代码永远不会打这些地址——测试靠 allowPrivateEndpoints / 注入的 connect 才能到达，lab 靠钉死的 endpoint origin。
 */
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { join } from "node:path";

export interface TlsPair { key: string; cert: string }

/** prime256v1 自签名，SAN 含 127.0.0.1 与 localhost；有效期 1 天 */
export async function selfSignedCert(dir: string): Promise<TlsPair> {
  const keyPath = join(dir, "key.pem"), certPath = join(dir, "cert.pem");
  const r = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", keyPath, "-out", certPath,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`openssl failed: ${r.stderr.toString()}`);
  return { key: await Bun.file(keyPath).text(), cert: await Bun.file(certPath).text() };
}

/** 浏览器那头的订阅：p256dh 是未压缩的 P-256 公钥（65 字节 base64url），auth 16 字节。web-push 用它们做 ECDH + HKDF */
export function webPushTestSubscription(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  return webPushTestBrowser(endpoint).subscription;
}

/** 浏览器那头的密钥（base64url）：d = P-256 私钥，raw = 未压缩公钥（订阅的 p256dh），auth = 16 字节。可落盘，lab 的假端点另起进程解密 */
export interface WebPushBrowserKeys { d: string; raw: string; auth: string }

export function newWebPushBrowserKeys(): WebPushBrowserKeys {
  const jwk = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(String(jwk.x), "base64url"), Buffer.from(String(jwk.y), "base64url")]);
  return { d: String(jwk.d), raw: raw.toString("base64url"), auth: randomBytes(16).toString("base64url") };
}

/** 像浏览器一样解开收到的推送正文（RFC 8291 + RFC 8188 aes128gcm，web-push 只发一条记录） */
export function decryptWebPush(k: WebPushBrowserKeys, body: Uint8Array): string {
  const b = Buffer.from(body), raw = Buffer.from(k.raw, "base64url"), auth = Buffer.from(k.auth, "base64url");
  const salt = b.subarray(0, 16), idlen = b[20], asPub = b.subarray(21, 21 + idlen), ct = b.subarray(21 + idlen);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(k.d, "base64url"));
  const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(asPub), auth, Buffer.concat([Buffer.from("WebPush: info\0"), raw, asPub]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const dec = createDecipheriv("aes-128-gcm", cek, nonce);
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  let end = pt.length;
  while (end > 0 && pt[end - 1] === 0) end--;
  if (pt[end - 1] !== 2) throw new Error("aes128gcm: last record lacks the 0x02 delimiter");
  return pt.subarray(0, end - 1).toString("utf8");
}

/**
 * 同上，另留着浏览器私钥：decrypt 像浏览器一样解开收到的推送正文，
 * 测试据此逐字节检查推送内容，而不只是看「密文比明文长」。
 */
export function webPushTestBrowser(endpoint: string) {
  const k = newWebPushBrowserKeys();
  return { subscription: { endpoint, keys: { p256dh: k.raw, auth: k.auth } }, decrypt: (body: Uint8Array) => decryptWebPush(k, body) };
}
