/**
 * HPKE（RFC 9180）base 模式，套件 DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM（0x0010 / 0x0001 / 0x0002）。
 * 只用在兑换邀请上（docs/relay/e2e-design.md §5.1）：请求封给邀请方的 E2E 公钥，响应用 export("redeem-response") 的密钥加密。
 * WebCrypto 的 HKDF 只有 extract+expand 一步到位，RFC 的 LabeledExtract / LabeledExpand 要分开，所以这里用 HMAC 自己拼。
 * 官方测试向量（CFRG test-vectors.json 同套件那一组）钉在 tests/e2e-hpke.test.ts。
 */
import { concat, uintBE, utf8, type Bytes } from "./encoding.js";
import { ecdh, gcmOpen, gcmSeal, aesKey, generateEcdh, hmac, hmacKey, importPub, type EcdhPair } from "./primitives.js";

const KEM_ID = 0x0010;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
const NK = 32;
const NN = 12;
const NH = 32;
const HPKE_V1 = utf8("HPKE-v1");
const KEM_SUITE = concat(utf8("KEM"), uintBE(KEM_ID, 2));
const HPKE_SUITE = concat(utf8("HPKE"), uintBE(KEM_ID, 2), uintBE(KDF_ID, 2), uintBE(AEAD_ID, 2));

async function extract(salt: Uint8Array, ikm: Uint8Array): Promise<Bytes> {
  return hmac(await hmacKey(salt.length ? salt : new Uint8Array(NH)), ikm);
}

async function expand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Bytes> {
  const k = await hmacKey(prk);
  const out: Uint8Array[] = [];
  let t: Uint8Array = new Uint8Array(0);
  for (let n = 1; out.length * NH < len; n++) {
    t = await hmac(k, concat(t, info, [n]));
    out.push(t);
  }
  return concat(...out).slice(0, len);
}

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) => extract(salt, concat(HPKE_V1, suite, utf8(label), ikm));
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(prk, concat(uintBE(len, 2), HPKE_V1, suite, utf8(label), info), len);

async function kemSharedSecret(dh: Uint8Array, enc: Uint8Array, pkR: Uint8Array): Promise<Bytes> {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", concat(enc, pkR), NH);
}

export class HpkeContext {
  private seq = 0;
  private constructor(
    private readonly key: CryptoKey,
    private readonly baseNonce: Bytes,
    private readonly exporterSecret: Bytes,
  ) {}

  static async fromSharedSecret(shared: Uint8Array, info: Uint8Array): Promise<HpkeContext> {
    const empty = new Uint8Array(0);
    const pskIdHash = await labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty);
    const infoHash = await labeledExtract(HPKE_SUITE, empty, "info_hash", info);
    const ctx = concat([0], pskIdHash, infoHash);
    const secret = await labeledExtract(HPKE_SUITE, shared, "secret", empty);
    const key = await labeledExpand(HPKE_SUITE, secret, "key", ctx, NK);
    const baseNonce = await labeledExpand(HPKE_SUITE, secret, "base_nonce", ctx, NN);
    const exp = await labeledExpand(HPKE_SUITE, secret, "exp", ctx, NH);
    return new HpkeContext(await aesKey(key), baseNonce, exp);
  }

  private nextNonce(): Bytes {
    const n = concat(this.baseNonce);
    const s = uintBE(this.seq++, NN);
    for (let k = 0; k < NN; k++) n[k] ^= s[k];
    return n;
  }

  seal(aad: Uint8Array, pt: Uint8Array): Promise<Bytes> {
    return gcmSeal(this.key, this.nextNonce(), aad, pt);
  }

  /** tag 不对 → null；失败不推进序号，与 RFC 一致 */
  async open(aad: Uint8Array, ct: Uint8Array): Promise<Bytes | null> {
    const seq = this.seq;
    const pt = await gcmOpen(this.key, this.nextNonce(), aad, ct);
    if (!pt) this.seq = seq;
    return pt;
  }

  export(exporterContext: Uint8Array, len: number): Promise<Bytes> {
    return labeledExpand(HPKE_SUITE, this.exporterSecret, "sec", exporterContext, len);
  }
}

/** 发送方：返回 enc（临时公钥，65 字节）与上下文；ephemeral 只给测试向量注入，生产每次新生成 */
export async function setupBaseS(pkR: Uint8Array, info: Uint8Array, ephemeral?: EcdhPair): Promise<{ enc: Bytes; ctx: HpkeContext }> {
  const pub = await importPub(pkR);
  if (!pub) throw new Error("hpke: invalid recipient public key");
  const e = ephemeral ?? (await generateEcdh());
  const shared = await kemSharedSecret(await ecdh(e.priv, pub), e.pub, pkR);
  return { enc: e.pub, ctx: await HpkeContext.fromSharedSecret(shared, info) };
}

/** 接收方：enc 不是合法公钥 → null */
export async function setupBaseR(enc: Uint8Array, recipient: EcdhPair, info: Uint8Array): Promise<HpkeContext | null> {
  const pubE = await importPub(enc);
  if (!pubE) return null;
  const shared = await kemSharedSecret(await ecdh(recipient.priv, pubE), enc, recipient.pub);
  return HpkeContext.fromSharedSecret(shared, info);
}
