/**
 * 本机 E2E 密钥 M（P-256 ECDH；私钥只在 STATE_DIR/e2e-key.pem，0600，第一次用到时生成。docs/relay/e2e-design.md §4.1.1）。
 * 对外只发「签名公钥块」：lp("peer-e2e-key", u32 版本, u64 生成时间秒, 公钥) 由本机 Ed25519 身份钥签名（§5.1），
 * 对方拿邀请里钉住的身份公钥验签，只收版本比已钉住的更新的，所以旧块被重放也不会被采纳。
 * 不放进 lib/e2e/：这里要读 PEM、用身份钥签名，是 bridge 独有的；lib/e2e/ 只用 WebCrypto，P2 要原样搬去 web。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { concat, fromB64url, lp, toB64url, uintBE, type Bytes } from "./e2e/encoding.js";
import { importPair, importPub, type EcdhPair } from "./e2e/primitives.js";
import { isPublicKey, type InstanceKey } from "./instance-key.js";
import { readOrCreateKeyFile } from "./key-file.js";
import { STATE_DIR } from "./paths.js";

const BLOB_LABEL = "peer-e2e-key";

export interface SignedE2eKey {
  v: number;
  /** 生成时间（unix 秒） */
  ts: number;
  /** SEC1 未压缩公钥的 base64url */
  pub: string;
  /** Ed25519 签名的 base64url */
  sig: string;
}

export interface MachineE2eKey {
  pair: EcdhPair;
  ts: number;
}

export const e2eKeyBlobMessage = (v: number, ts: number, pub: Uint8Array): Bytes => lp(BLOB_LABEL, uintBE(v, 4), uintBE(ts, 8), pub);

export function signE2eKey(identity: Pick<InstanceKey, "privateKey">, pub: Uint8Array, v: number, ts: number): SignedE2eKey {
  const sig = sign(null, e2eKeyBlobMessage(v, ts, pub), identity.privateKey);
  return { v, ts, pub: toB64url(pub), sig: toB64url(sig) };
}

/** 形状检查：整数范围、base64url 规范写法、公钥是曲线上的 65 字节点；不合格 → null */
async function parseSignedE2eKey(raw: unknown): Promise<(SignedE2eKey & { pubBytes: Bytes }) | null> {
  const b = raw as Partial<SignedE2eKey> | null;
  if (!b || typeof b !== "object") return null;
  if (!Number.isSafeInteger(b.v) || b.v! < 1 || b.v! > 0xffffffff || !Number.isSafeInteger(b.ts) || b.ts! < 0) return null;
  const pub = typeof b.pub === "string" ? fromB64url(b.pub) : null;
  const sig = typeof b.sig === "string" ? fromB64url(b.sig) : null;
  if (!pub || !sig || sig.length !== 64 || !(await importPub(pub))) return null;
  return { v: b.v!, ts: b.ts!, pub: b.pub!, sig: b.sig!, pubBytes: pub };
}

/** 用钉住的身份公钥（lib/instance-key.ts 的 base64url 形状）验签；通过返回解析后的块，否则 null */
export async function verifyE2eKey(identityPub: string, raw: unknown): Promise<(SignedE2eKey & { pubBytes: Bytes }) | null> {
  if (!isPublicKey(identityPub)) return null;
  const b = await parseSignedE2eKey(raw);
  if (!b) return null;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: identityPub }, format: "jwk" });
    return verify(null, e2eKeyBlobMessage(b.v, b.ts, b.pubBytes), key, fromB64url(b.sig)!) ? b : null;
  } catch {
    return null; // 公钥导入失败和签名对不上是一回事：都不能信这个块
  }
}

/**
 * 已钉住一把之后，新验过签的块能不能替换它：版本更高 → "newer"；同版本同公钥 → "same"；
 * 其它（版本更低，或同版本却换了公钥）→ "stale"，调用方拒绝并告警——后者说明身份钥签过两把同版本的钥匙，不该发生。
 */
export function compareE2eKey(pinned: { v: number; pub: string } | undefined, b: { v: number; pub: string }): "newer" | "same" | "stale" {
  if (!pinned || b.v > pinned.v) return "newer";
  return b.v === pinned.v && b.pub === pinned.pub ? "same" : "stale";
}

const cache = new Map<string, Promise<MachineE2eKey | null>>();

async function load(dir: string): Promise<MachineE2eKey | null> {
  const path = join(dir, "e2e-key.pem");
  try {
    const pem = readOrCreateKeyFile(path, () => String(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" })));
    const jwk = createPrivateKey(pem).export({ format: "jwk" });
    const [d, x, y] = [jwk.d, jwk.x, jwk.y].map((s) => fromB64url(String(s)));
    if (jwk.crv !== "P-256" || !d || !x || !y) throw new Error("e2e-key.pem is not a P-256 key");
    return { pair: await importPair(d, concat([4], x, y)), ts: Math.floor(statSync(path).mtimeMs / 1000) };
  } catch (e) {
    console.error(`⚠️ 读写 ${path} 失败，这次不能建立加密会话: ${(e as Error).message}`);
    return null;
  }
}

/** 读（或生成）本机 E2E 密钥；失败返回 null，且不缓存失败，下次再试 */
export function machineE2eKey(dir: string = STATE_DIR): Promise<MachineE2eKey | null> {
  const hit = cache.get(dir);
  if (hit) return hit;
  const p = load(dir);
  cache.set(dir, p);
  void p.then((k) => k || cache.delete(dir));
  return p;
}
