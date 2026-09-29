/**
 * 兑换邀请的 HPKE 信封（docs/relay/e2e-design.md §5.1）：路径照旧是 POST /api/v1/peers/redeem——中继只放行非联系人发这一个路径，
 * 换路径就得改中继。请求体从明文 {join, …} 换成 {v, suite, enc, ct}：
 *   请求 = HPKE base 模式封给邀请方的 E2E 公钥，info = lp(标签, 邀请方指纹)，AAD = 标签；
 *   响应 = export("redeem-response", 32) 作 AES-256-GCM 密钥，nonce 每次随机，AAD = lp(响应标签, enc)。
 * nonce 必须随机：中继能把同一个兑换请求重放一遍，邀请方会两次导出同一把密钥。失败响应不走这里，明文且不带秘密。
 */
import { fromB64url, lp, toB64url, utf8 } from "./e2e/encoding.js";
import { HpkeContext, setupBaseR, setupBaseS } from "./e2e/hpke.js";
import { aesKey, gcmOpen, gcmSeal, randomBytes, type EcdhPair } from "./e2e/primitives.js";
import { PEER_E2E_SUITE } from "./peer-e2e-wire.js";
import { remoteDetail } from "./remote-text.js";

const REDEEM_LABEL = "cstra-peer-redeem-v1";
const RESPONSE_LABEL = "cstra-peer-redeem-response-v1";
const info = (inviterFp: string) => lp(REDEEM_LABEL, inviterFp);

export interface SealedRedeem {
  v: 1;
  suite: typeof PEER_E2E_SUITE;
  enc: string;
  ct: string;
}

export interface RedeemSession {
  ctx: HpkeContext;
  enc: Uint8Array;
}

/** 是不是加密的兑换请求（否则就是老版本的明文 {join, …}，默认拒） */
export function isSealedRedeem(body: unknown): body is SealedRedeem {
  const o = body as Record<string, unknown> | null;
  return !!o && typeof o === "object" && o.v === 1 && typeof o.enc === "string" && typeof o.ct === "string";
}

export async function sealRedeemRequest(inviterEkPub: Uint8Array, inviterFp: string, payload: unknown): Promise<{ body: SealedRedeem; session: RedeemSession }> {
  const { enc, ctx } = await setupBaseS(inviterEkPub, info(inviterFp));
  const ct = await ctx.seal(utf8(REDEEM_LABEL), utf8(JSON.stringify(payload)));
  return { body: { v: 1, suite: PEER_E2E_SUITE, enc: toB64url(enc), ct: toB64url(ct) }, session: { ctx, enc } };
}

/** 邀请方解开；套件不对、enc 不是合法点、解不开、不是 JSON → null */
export async function openRedeemRequest(m: EcdhPair, myFp: string, body: SealedRedeem): Promise<{ payload: unknown; session: RedeemSession } | null> {
  const s = body.suite as Record<string, unknown> | undefined;
  if (!s || s.kem !== PEER_E2E_SUITE.kem || s.kdf !== PEER_E2E_SUITE.kdf || s.aead !== PEER_E2E_SUITE.aead) return null;
  const enc = fromB64url(body.enc), ct = fromB64url(body.ct);
  if (!enc || !ct) return null;
  const ctx = await setupBaseR(enc, m, info(myFp));
  const pt = ctx && (await ctx.open(utf8(REDEEM_LABEL), ct));
  if (!ctx || !pt) return null;
  try {
    return { payload: JSON.parse(new TextDecoder().decode(pt)), session: { ctx, enc } };
  } catch {
    return null; // 解得开却不是 JSON：对方实现坏了，按无效兑换处理
  }
}

const responseKey = async (s: RedeemSession) => aesKey(await s.ctx.export(utf8("redeem-response"), 32));

export async function sealRedeemResponse(s: RedeemSession, obj: unknown): Promise<{ v: 1; nonce: string; ct: string }> {
  const nonce = randomBytes(12);
  const ct = await gcmSeal(await responseKey(s), nonce, lp(RESPONSE_LABEL, s.enc), utf8(JSON.stringify(obj)));
  return { v: 1, nonce: toB64url(nonce), ct: toB64url(ct) };
}

/** 兑换方解开响应；任何一处不对 → null（调用方当兑换失败，回滚本地记录） */
export async function openRedeemResponse(s: RedeemSession, body: unknown): Promise<unknown | null> {
  const o = body as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== 1 || typeof o.nonce !== "string" || typeof o.ct !== "string") return null;
  const nonce = fromB64url(o.nonce), ct = fromB64url(o.ct);
  if (!nonce || nonce.length !== 12 || !ct) return null;
  const pt = await gcmOpen(await responseKey(s), nonce, lp(RESPONSE_LABEL, s.enc), ct);
  if (!pt) return null;
  try {
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null; // 同上：解得开却不是 JSON
  }
}

export type RedeemOutcome = { ok: true; value: unknown } | { ok: false; code: "redeem_failed" | "redeem_unsealed" | "redeem_tampered"; message: string };

/**
 * 兑换方怎么看待邀请方的回答。成功必须是解得开的加密响应；失败响应是明文、没认证，中继能伪造，所以：
 *   - 明文的「成功」（哪怕 {ok:true, token}）一律当失败——那正是中继塞自己 token 的办法；
 *   - 任何失败只给一句展示用的话，调用方只报错、提示重试，不改本地状态（不落盘、不把 peer 标失败、不回退明文）。
 * 所以 manager 只在 ok:true 之后才写 peers.json，失败时没有需要回滚的东西。
 */
export async function readRedeemResponse(s: RedeemSession, status: number, body: unknown): Promise<RedeemOutcome> {
  const sealed = !!body && typeof body === "object" && (body as { v?: unknown }).v === 1 && typeof (body as { ct?: unknown }).ct === "string";
  if (status === 200 && sealed) {
    const value = await openRedeemResponse(s, body);
    return value === null ? { ok: false, code: "redeem_tampered", message: "invite response failed authentication; retry" } : { ok: true, value };
  }
  if (status === 200) return { ok: false, code: "redeem_unsealed", message: "inviter answered without encryption; refusing (retry, or ask for a new invite)" };
  const err = (body as { error?: unknown } | null)?.error;
  const shown = remoteDetail(err);
  return { ok: false, code: "redeem_failed", message: `inviter refused (${status})${shown ? `: ${shown}` : ""}; retry` };
}
