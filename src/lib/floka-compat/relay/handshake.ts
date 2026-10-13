/**
 * 握手这一段的双认：子协议定族、握手签名按同一族验、发送方按对端能力选族。
 * 帧不变：hello / auth / welcome 的字段与 v 都是 canonical 的，族只体现在子协议名和签名原文的首行。
 * 一条连接从握手起只属于一族，后面盖的头（headers.ts）跟这一族；能力只在握手通过之后才收。
 */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { authSignature, verifyAuthSignature } from "../../relay-protocol.js";
import { CANONICAL_FAMILY, RELAY_FAMILIES, RELAY_FAMILY_IDS, isRelayFamilyId, type RelayFamilyId } from "./families.js";
import { staged, type RelayFail, type RelayGear, type RelayRename, type Staged } from "./gear.js";

const fail = (reason: RelayFail["reason"]): RelayFail => ({ ok: false, reason });

/**
 * 服务端：Sec-WebSocket-Protocol 头 → 这条连接的族。off / observe 与现行判定相同（列表里有旧子协议就收）；
 * on 档同时报两族的拒掉——客户端必须先定好族再连，否则它用哪一族的用途签名就成了服务端猜。
 */
export function acceptSubprotocol(offered: string | null, gear: RelayGear): Staged<{ family: RelayFamilyId; subprotocol: string }> {
  const protos = (offered ?? "").split(",").map((s) => s.trim());
  const accept = (family: RelayFamilyId) => ({ ok: true as const, family, subprotocol: RELAY_FAMILIES[family].subprotocol });
  return staged(
    gear,
    () => (protos.includes(RELAY_FAMILIES.legacy.subprotocol) ? accept("legacy") : fail("subprotocol_required")),
    () => {
      const named = RELAY_FAMILY_IDS.filter((id) => protos.includes(RELAY_FAMILIES[id].subprotocol));
      if (named.length > 1) return fail("illegal_combination");
      return named.length === 1 ? accept(named[0]) : fail("subprotocol_required");
    },
  );
}

export interface RelayAuthFields { key: string; nonce: string; name: string; slug: string }

function canonical(family: RelayFamilyId, a: RelayAuthFields): Buffer {
  return Buffer.from(`${RELAY_FAMILIES[family].authPurpose}\n${a.nonce}\n${a.key}\n${a.name}\n${a.slug}`);
}

/** 握手签名；旧族直接用 canonical 的实现，保证与现行客户端逐字节相同 */
export function signRelayAuth(family: RelayFamilyId, privateKey: KeyObject, a: RelayAuthFields): string {
  if (family === CANONICAL_FAMILY) return authSignature(privateKey, a.nonce, a.key, a.name, a.slug);
  return sign(null, canonical(family, a), privateKey).toString("base64url");
}

function verifies(family: RelayFamilyId, a: RelayAuthFields, sig: string): boolean {
  if (family === CANONICAL_FAMILY) return verifyAuthSignature(a.key, a.nonce, a.name, a.slug, sig);
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: a.key }, format: "jwk" });
    return verify(null, canonical(family, a), pub, Buffer.from(sig, "base64url"));
  } catch {
    return false; // 公钥或签名不是合法编码：和签名对不上是一回事
  }
}

/**
 * 只按连接握手的那一族验。签名在另一族的用途下成立 = 子协议与认证用途混搭，单独报出来，
 * 两种情况都拒；旧族连接上这个函数的放行条件与 verifyAuthSignature 相同。
 */
export function verifyRelayAuth(family: RelayFamilyId, a: RelayAuthFields, sig: string): { ok: true; family: RelayFamilyId } | RelayFail {
  if (verifies(family, a, sig)) return { ok: true, family };
  return fail(RELAY_FAMILY_IDS.some((other) => other !== family && verifies(other, a, sig)) ? "auth_family_mismatch" : "auth_failed");
}

/** 对端支持哪些族 */
export interface RelayCapability { families: readonly RelayFamilyId[] }

/**
 * 能力声明只在握手通过后才收：握手前的任何声明（hello 里的、响应头里的）中间人都能加，信了就会被引到新族上去。
 * 这一阶段每个对端都必须仍支持旧族，声明里没有旧族的不是合法组合。
 */
export function admitCapability(claim: unknown, ctx: { authenticated: boolean }): { ok: true; capability: RelayCapability } | RelayFail {
  if (!ctx.authenticated) return fail("unauthenticated_capability");
  const families = claim && typeof claim === "object" ? (claim as { families?: unknown }).families : undefined;
  if (!Array.isArray(families) || !families.every(isRelayFamilyId) || !families.includes(CANONICAL_FAMILY)) return fail("capability_invalid");
  return { ok: true, capability: { families: RELAY_FAMILY_IDS.filter((id) => families.includes(id)) } };
}

export interface SendPlan { family: RelayFamilyId; subprotocol: string; candidate: RelayFamilyId | null }

/**
 * 发送方选族。能力未知（null）一律旧族；发送档 on、接收档也 on、对端能力里有新族，才用新族。
 * observe 仍发旧族，candidate 报「条件齐了会发哪一族」。
 */
export function planSend(rename: RelayRename, capability: RelayCapability | null): SendPlan {
  const capable = capability?.families.includes("floka") === true;
  const family: RelayFamilyId = rename.send === "on" && rename.receive === "on" && capable ? "floka" : CANONICAL_FAMILY;
  const candidate = rename.send === "observe" && capable ? "floka" : null;
  return { family, subprotocol: RELAY_FAMILIES[family].subprotocol, candidate };
}
