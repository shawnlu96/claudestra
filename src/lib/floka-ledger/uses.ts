/**
 * 台账四用途（shared-ledger、invite-pop、lend-receipt、lend-review-ticket）的按档收发，复用 SIGN1 的用途族
 * （floka-compat/signature）：这里只加三件事——
 *   1. 历史载荷没有 purpose 字段：一律当旧族、原字节照旧验，不重签不改写；新族载荷必须自报 purpose；
 *   2. 接收档 → 用途族的 mode，observe 的新族验签结论交给调用方的 report，结论本身与 off 相同；
 *   3. 发送档 + 对端能力证明 → 发哪一族；缺省旧族。
 * 纯函数：不读配置、不读钥匙文件、不写任何台账；钥匙与钉住的对端由调用方显式给。单测 tests/floka-ledger.test.ts。
 */
import { signPurpose, type InstanceKey } from "../instance-signature.js";
import { chooseSendFamily } from "../floka-compat/signature/capability.js";
import { PURPOSE_MAP, purposeFamily, type SignatureFamily, type SignatureUse } from "../floka-compat/signature/families.js";
import { signPurposeFamily, verifyPurposeFamilies } from "../floka-compat/signature/purpose.js";
import type { LedgerGear } from "./gear.js";

/** 载荷里的签名三件；purpose 缺省 = 旧族（历史载荷的原样） */
export interface LedgerSigned { key: string; sig: string; purpose?: string }

/** observe 档的报告：这份新族签名若开到 on 会不会被认 */
export interface LedgerObservation { use: SignatureUse; family: SignatureFamily; wouldAccept: boolean }

export type LedgerCheck =
  | { ok: true; family: SignatureFamily }
  | { ok: false; reason: string; observed?: LedgerObservation };

export function verifyLedgerUse(
  use: SignatureUse, signed: LedgerSigned, fields: string[], gear: LedgerGear, pinnedKey?: string,
): LedgerCheck {
  const purpose = signed.purpose === undefined ? PURPOSE_MAP[use].claudestra : signed.purpose;
  // 自报的族只来自登记表；没登记的名字交给 classify 判 unknown_purpose，非字符串判 partial
  const family = (typeof purpose === "string" && purposeFamily(purpose)?.family) || "claudestra";
  if (pinnedKey !== undefined && signed.key !== pinnedKey) return { ok: false, reason: "wrong_key" };
  const c = verifyPurposeFamilies([{ family, purpose, key: signed.key, sig: signed.sig }], use, fields, gear);
  if (c.status === "ok") return { ok: true, family: c.family };
  if (c.status === "unsigned") return { ok: false, reason: "unsigned" };
  return { ok: false, reason: c.reason, ...(c.observed !== undefined ? { observed: { use, family, wouldAccept: c.observed } } : {}) };
}

/** 旧族走原来的 signPurpose，产出与改动前逐字节相同、不带 purpose；新族带上自报的 purpose */
export function signLedgerUse(use: SignatureUse, fields: string[], key: InstanceKey | null, family: SignatureFamily = "claudestra"): LedgerSigned | null {
  if (family === "claudestra") return signPurpose(PURPOSE_MAP[use].claudestra, fields, key);
  const e = signPurposeFamily("floka", use, fields, key);
  return e ? { key: e.key, sig: e.sig, purpose: e.purpose } : null;
}

/**
 * 发送族：off 恒旧族；observe 恒旧族并报告 on 会选哪族；on 只在钉住的对端有有效能力证明时发新族。
 * 对端撤销（调用方不再给 pinned）或证明过期，一律回到旧族——旧族对端一定认。
 */
export function ledgerSendFamily(
  gear: LedgerGear, peer: { capability?: unknown; pinned: { instanceId: string; publicKey: string } | null }, now = Date.now(),
): { family: SignatureFamily; observed?: SignatureFamily } {
  const wouldSend = chooseSendFamily({ allowNew: true, capability: peer.capability, pinned: peer.pinned }, now);
  if (gear === "on") return { family: wouldSend };
  return gear === "observe" ? { family: "claudestra", observed: wouldSend } : { family: "claudestra" };
}
