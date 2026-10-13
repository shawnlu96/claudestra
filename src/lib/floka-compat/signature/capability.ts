/**
 * 切新发送的能力证明：对端用自己的实例钥匙签 [实例 id, 公钥, 协议版本, 签发时间, 过期时间]（毫秒），
 * 本机只在「签名过、钥匙和实例 id 等于已钉住的那台、协议版本是 FLOKA_SIGNATURE_PROTOCOL、在有效期内」时才对它发新族；
 * 其余（没有证明、形状不对、未知版本、过期、钥匙或实例对不上）一律发旧族——发旧族对端一定认。
 * 签名借 invite-pop 用途 + 专用标签：字段数与旧邀请证明不同、标签与新族邀请证明不同，三者互相挪不动。
 */
import { signPurpose, verifyPurpose, type InstanceKey } from "../../instance-signature.js";
import { FLOKA_SIGNATURE_PROTOCOL, type SignatureFamily } from "./families.js";

const PURPOSE = "claudestra-invite-pop-v1" as const;
const TAG = `${FLOKA_SIGNATURE_PROTOCOL}:capability`;
/** 证明最长有效期与可容忍的签发时钟超前：过长的证明等于永久切新，撤不回 */
export const CAPABILITY_MAX_TTL_MS = 7 * 24 * 3600_000;
const SKEW_MS = 300_000;

export interface SignatureCapability {
  instanceId: string; publicKey: string; protocol: string; issuedAt: number; expiresAt: number; sig: string;
}

const fields = (c: Omit<SignatureCapability, "sig">): string[] =>
  [TAG, c.instanceId, c.publicKey, c.protocol, String(c.issuedAt), String(c.expiresAt)];

export function issueSignatureCapability(
  instanceId: string, key: InstanceKey, now = Date.now(), ttlMs = CAPABILITY_MAX_TTL_MS,
): SignatureCapability | null {
  const c = { instanceId, publicKey: key.publicKey, protocol: FLOKA_SIGNATURE_PROTOCOL, issuedAt: now, expiresAt: now + Math.min(ttlMs, CAPABILITY_MAX_TTL_MS) };
  const s = signPurpose(PURPOSE, fields(c), key);
  return s ? { ...c, sig: s.sig } : null;
}

const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** 已钉住的对端（实例 id + 公钥）是调用方从自己的可信记录里拿的，不能用证明里自报的值 */
export function capabilityValid(cap: unknown, pinned: { instanceId: string; publicKey: string }, now = Date.now()): boolean {
  if (!cap || typeof cap !== "object") return false;
  const c = cap as Record<string, unknown>;
  if (![c.instanceId, c.publicKey, c.protocol, c.sig].every((v) => typeof v === "string") || !whole(c.issuedAt) || !whole(c.expiresAt)) return false;
  const v = c as unknown as SignatureCapability;
  if (v.protocol !== FLOKA_SIGNATURE_PROTOCOL || v.instanceId !== pinned.instanceId || v.publicKey !== pinned.publicKey) return false;
  if (v.issuedAt > now + SKEW_MS || v.expiresAt <= now || v.expiresAt - v.issuedAt > CAPABILITY_MAX_TTL_MS) return false;
  return verifyPurpose(pinned.publicKey, PURPOSE, fields(v), v.sig);
}

/** 发送族：缺省旧族；只有放行切新（allowNew，另行批准）且能力证明有效时才发新族 */
export function chooseSendFamily(
  opts: { allowNew?: boolean; capability?: unknown; pinned: { instanceId: string; publicKey: string } | null }, now = Date.now(),
): SignatureFamily {
  return opts.allowNew === true && opts.pinned && capabilityValid(opts.capability, opts.pinned, now) ? "floka" : "claudestra";
}
