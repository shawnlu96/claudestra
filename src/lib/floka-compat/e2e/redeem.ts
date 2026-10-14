/** HPKE and AES-GCM are canonical primitives; only info/AAD labels differ between families. */
import { lp, toB64url, utf8 } from "../../e2e/encoding.js";
import { setupBaseS, setupBaseR } from "../../e2e/hpke.js";
import { aesKey, gcmOpen, gcmSeal, randomBytes, type EcdhPair } from "../../e2e/primitives.js";
import { PEER_E2E_SUITE } from "../../peer-e2e-wire.js";
import type { RedeemSession, SealedRedeem } from "../../peer-e2e-redeem.js";
import { authenticatedBody, bytes, parseJson, type E2eContext } from "./context.js";
import { E2E_LABELS, type E2eFamily } from "./families.js";

export interface FamilyRedeemSession extends RedeemSession { readonly family: E2eFamily }
export const REDEEM_PATH = "/api/v1/peers/redeem";
const json = (value: unknown) => utf8(JSON.stringify(value));
const responseKey = async (s: FamilyRedeemSession) => aesKey(await s.ctx.export(utf8("redeem-response"), 32));

export async function sealRequest(family: E2eFamily, recipient: Uint8Array, fp: string, payload: unknown) {
  const label = E2E_LABELS[family].redeem;
  const session = await setupBaseS(recipient, lp(label, fp));
  const encrypted = await session.ctx.seal(utf8(label), json(payload));
  const body: SealedRedeem = { v: 1, suite: PEER_E2E_SUITE, enc: toB64url(session.enc), ct: toB64url(encrypted) };
  return { body, session: Object.freeze({ ...session, family }) };
}

/** The body comes from the verified request snapshot, never an untrusted family field. */
export async function openRequest(ctx: E2eContext, local: EcdhPair, fp: string): Promise<{ payload: unknown; session: FamilyRedeemSession } | null> {
  const raw = authenticatedBody(ctx, REDEEM_PATH) as Partial<SealedRedeem> | null;
  if (!raw || raw.v !== 1 || !raw.suite) return null;
  if (raw.suite.kem !== PEER_E2E_SUITE.kem || raw.suite.kdf !== PEER_E2E_SUITE.kdf || raw.suite.aead !== PEER_E2E_SUITE.aead) return null;
  const enc = bytes(raw.enc, 65), ct = bytes(raw.ct);
  if (!enc || !ct) return null;
  const label = E2E_LABELS[ctx.family].redeem;
  const hpke = await setupBaseR(enc, local, lp(label, fp));
  if (!hpke) return null;
  const payload = parseJson(await hpke.open(utf8(label), ct));
  return payload === null ? null : { payload, session: Object.freeze({ ctx: hpke, enc, family: ctx.family }) };
}

export async function sealResponse(session: FamilyRedeemSession, value: unknown) {
  const nonce = randomBytes(12);
  const aad = lp(E2E_LABELS[session.family].response, session.enc);
  const ciphertext = await gcmSeal(await responseKey(session), nonce, aad, json(value));
  return { v: 1 as const, nonce: toB64url(nonce), ct: toB64url(ciphertext) };
}

export async function openResponse(session: FamilyRedeemSession, raw: unknown): Promise<unknown | null> {
  const value = raw as { v?: unknown; nonce?: unknown; ct?: unknown } | null;
  if (!value || value.v !== 1) return null;
  const nonce = bytes(value.nonce, 12), ciphertext = bytes(value.ct);
  if (!nonce || !ciphertext) return null;
  const aad = lp(E2E_LABELS[session.family].response, session.enc);
  return parseJson(await gcmOpen(await responseKey(session), nonce, aad, ciphertext));
}
