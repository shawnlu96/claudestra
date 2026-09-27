/**
 * 推送测试的共用件：本地自签名证书（openssl 生成，给假推送服务 / 假 APNs 的 TLS 用）、能通过 web-push 加密的假订阅。
 * 生产代码永远不会打这些地址——测试靠 allowPrivateEndpoints / 注入的 connect 才能到达。
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
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
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = ec.publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(String(jwk.x), "base64url"), Buffer.from(String(jwk.y), "base64url")]);
  return { endpoint, keys: { p256dh: raw.toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
