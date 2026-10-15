/**
 * 中心的新族能力：中心在 welcome 里发给刚认证过的那台实例，实例据此决定下次连接是否提议新族。
 * 能力绑定三样：认证身份（这条连接认证出来的指纹）、协议版本与新族子协议名、有效期。
 * 只在握手通过之后收（welcome 之前的任何声明都不信）；形状不对、未知族、版本不对、过期、指纹对不上一律当没有——
 * 没有能力就发旧族，旧族两边一定都认，所以拒掉能力既不会切新也不会断线。
 */
import { PROTOCOL_VERSION } from "../relay-protocol.js";
import { RELAY_FAMILIES, type RelayFamilyId } from "../floka-compat/relay/families.js";
import { admitCapability } from "../floka-compat/relay/handshake.js";

/** 能力的最长有效期：中心撤回新族后，旧能力最多再被用这么久（用了也只是被中心按旧族接下） */
export const CENTER_CAPABILITY_TTL_MS = 24 * 3600_000;
const SKEW_MS = 300_000;

export interface CenterCapability {
  families: readonly RelayFamilyId[];
  fp: string;
  v: number;
  subprotocol: string;
  issuedAt: number;
  expiresAt: number;
}

export function issueCenterCapability(fp: string, now = Date.now()): CenterCapability {
  return {
    families: ["legacy", "floka"], fp, v: PROTOCOL_VERSION, subprotocol: RELAY_FAMILIES.floka.subprotocol,
    issuedAt: now, expiresAt: now + CENTER_CAPABILITY_TTL_MS,
  };
}

const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** 收能力：不合格返回拒的理由，合格返回规整后的副本（不留对方多塞的字段） */
export function admitCenterCapability(
  raw: unknown, ctx: { fp: string; authenticated: boolean }, now = Date.now(),
): { ok: true; capability: CenterCapability } | { ok: false; reason: string } {
  const fam = admitCapability(raw, ctx);
  if (!fam.ok) return { ok: false, reason: fam.reason };
  const c = raw as Record<string, unknown>;
  if (!fam.capability.families.includes("floka")) return { ok: false, reason: "capability_no_new_family" };
  if (c.fp !== ctx.fp) return { ok: false, reason: "capability_identity" };
  if (c.v !== PROTOCOL_VERSION || c.subprotocol !== RELAY_FAMILIES.floka.subprotocol) return { ok: false, reason: "capability_version" };
  if (!whole(c.issuedAt) || !whole(c.expiresAt)) return { ok: false, reason: "capability_invalid" };
  if (c.issuedAt > now + SKEW_MS || c.expiresAt <= now || c.expiresAt - c.issuedAt > CENTER_CAPABILITY_TTL_MS) {
    return { ok: false, reason: "capability_expired" };
  }
  const capability = { ...fam.capability, fp: ctx.fp, v: c.v, subprotocol: c.subprotocol, issuedAt: c.issuedAt, expiresAt: c.expiresAt };
  return { ok: true, capability };
}
