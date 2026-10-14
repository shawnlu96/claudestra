/** Optional compatibility entry points; production routing stays unchanged until explicitly wired and enabled. */
import { timingSafeEqual } from "node:crypto";
import { inviteExpired, parsePeerInviteV2, type PeerInviteV2, type PendingInvite } from "../../peers.js";
import { checkInviteProof, inviteUrlKey, newInviteNonce } from "../../invite-proof.js";
import { verifyE2eKey, compareE2eKey } from "../../e2e-machine-key.js";
import { keyFingerprint, type InstanceKey } from "../../instance-key.js";
import type { EcdhPair } from "../../e2e/primitives.js";
import { signRequestFamily } from "../signature/request.js";
import { type E2eContext } from "./context.js";
import { planE2eSend, type E2ePin } from "./capability.js";
import type { E2eFamily, E2eRename } from "./families.js";
import { openRequest, openResponse, sealRequest, sealResponse, REDEEM_PATH } from "./redeem.js";

export interface RedeemState { invite: PendingInvite; revoked: boolean; used: boolean }
export interface RedeemDeps {
  /** Read-only lookup from the canonical pending invitation and its original token principal. */
  lookup: (join: string) => Promise<RedeemState | null>;
  /** Under one lock/transaction recheck join, TTL, token revocation and unused state, then consume and write peer once.
   * Reuse the invitation's original token. Null means the state changed; never retry or generate a replacement token. */
  redeemAtomic: (expected: RedeemState, payload: Record<string, unknown>, ctx: E2eContext, now: number) => Promise<Record<string, unknown> | null>;
}
interface Observation { family: E2eFamily | null; wouldAccept: boolean }
type Refused = { ok: false; reason: string; observed?: Observation };
type Accepted = { ok: true; family: E2eFamily; body: Awaited<ReturnType<typeof sealResponse>> };
const refuse = (reason: string): Refused => ({ ok: false, reason });
const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function candidate(ctx: E2eContext, payload: unknown, deps: RedeemDeps, now: () => number) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.join !== "string" || p.join.length < 16 || p.idk !== ctx.pin.idk || p.iid !== ctx.pin.instanceId) return null;
  const key = await verifyE2eKey(ctx.pin.idk, p.ek);
  if (!key || compareE2eKey(ctx.pin.ek, key) !== "same") return null;
  const state = await deps.lookup(p.join);
  if (!state || state.used || state.revoked || !state.invite.e2e || inviteExpired(state.invite, now())) return null;
  if (!sameSecret(state.invite.joinSecret, p.join)) return null;
  if (typeof p.inviteUrl !== "string" || !inviteUrlKey(p.inviteUrl) || inviteUrlKey(p.inviteUrl) !== inviteUrlKey(state.invite.url)) return null;
  return { state, payload: p };
}

/** observe decrypts and reports only; off does not even call the read-only lookup. */
export async function receiveRedeem(
  rename: E2eRename, ctx: E2eContext, local: EcdhPair, myFp: string, deps: RedeemDeps, now?: number,
): Promise<Accepted | Refused> {
  if (rename.receive !== "on" && rename.receive !== "observe") return refuse("disabled");
  const decrypted = await openRequest(ctx, local, myFp);
  const verdict = decrypted ? await candidate(ctx, decrypted.payload, deps, () => now ?? Date.now()) : null;
  if (rename.receive === "observe") return { ...refuse("observe"), observed: { family: decrypted ? ctx.family : null, wouldAccept: !!verdict } };
  if (!decrypted || !verdict) return refuse("invalid_redeem");
  const result = await deps.redeemAtomic(verdict.state, verdict.payload, ctx, now ?? Date.now());
  if (!result || result.ok !== true) return refuse("invite_changed");
  return { ok: true, family: ctx.family, body: await sealResponse(decrypted.session, result) };
}

export interface JoinDeps {
  /** Called only in on; integrations may read/generate local keys here, never in observe. */
  local: () => { key: InstanceKey; pair: EcdhPair; fp: string; pin: E2ePin; name?: string } | null
    | Promise<{ key: InstanceKey; pair: EcdhPair; fp: string; pin: E2ePin; name?: string } | null>;
  /** One encrypted POST, signed over its exact body. No plaintext fallback callback exists. */
  post: (body: string, headers: Record<string, string>, url: string) => Promise<{ status: number; body: unknown }>;
  savePeer: (invite: PeerInviteV2, value: unknown) => Promise<void>;
}
interface JoinOptions { code: string; rename: E2eRename; pin: E2ePin; capability?: unknown; now?: number }

async function pinnedInvite(code: string, pin: E2ePin) {
  const invite = parsePeerInviteV2(code);
  if (!invite || invite.idk !== pin.idk || invite.fp !== keyFingerprint(pin.idk) || (invite.iid && invite.iid !== pin.instanceId)) return null;
  const ek = await verifyE2eKey(pin.idk, invite.ek);
  return ek && compareE2eKey(pin.ek, ek) === "same" ? { invite, ek } : null;
}

/** Legacy invites use their existing fields/TTL/single-use grant. The capability is separate, not added to the invite. */
export async function joinInvite(opts: JoinOptions, deps: JoinDeps): Promise<{ ok: true; family: E2eFamily } | Refused> {
  if (opts.rename.receive !== "on" && opts.rename.receive !== "observe") return refuse("disabled");
  const input = await pinnedInvite(opts.code, opts.pin);
  if (opts.rename.receive === "observe") return { ...refuse("observe"), observed: { family: "claudestra", wouldAccept: !!input } };
  if (!input) return refuse("invite_pin");
  const local = await deps.local();
  if (!local || local.key.publicKey !== local.pin.idk || local.fp !== keyFingerprint(local.pin.idk)) return refuse("local_key");
  const signedLocal = await verifyE2eKey(local.pin.idk, local.pin.ek);
  if (!signedLocal || signedLocal.pub !== Buffer.from(local.pair.pub).toString("base64url")) return refuse("local_key");
  const now = opts.now ?? Date.now(), { invite, ek } = input;
  const family = planE2eSend(opts.rename, opts.pin, opts.capability, now);
  const nonce = newInviteNonce();
  const payload = { join: invite.join, name: local.name ?? "peer", iid: local.pin.instanceId, idk: local.pin.idk, ek: local.pin.ek, nonce, inviteUrl: invite.url };
  const sealed = await sealRequest(family, ek.pubBytes, invite.fp!, payload);
  const body = JSON.stringify(sealed.body);
  const target = new URL(`${invite.url}${REDEEM_PATH}`), path = target.pathname + target.search;
  let answer: Awaited<ReturnType<JoinDeps["post"]>>;
  try { answer = await deps.post(body, signRequestFamily(family, { method: "POST", path, body }, local.key, now), invite.url); }
  catch { return refuse("transport_failed"); /* A failed encrypted attempt has unknown state; never send another request or downgrade. */ }
  const result = answer.status === 200 ? await openResponse(sealed.session, answer.body) : null;
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) return refuse("response_auth");
  const value = result as Record<string, unknown>;
  const iid = typeof value.iid === "string" ? value.iid : "";
  const proof = checkInviteProof(value.proof, { nonce, join: invite.join, redeemerFp: local.fp, inviterIid: iid, inviteUrl: invite.url });
  if (!proof || proof === "bad" || proof.key !== opts.pin.idk || iid !== opts.pin.instanceId) return refuse("response_pin");
  await deps.savePeer(invite, result);
  return { ok: true, family };
}
