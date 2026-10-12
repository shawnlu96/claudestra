/**
 * 按用途签名（邀请持钥证明、共享账本、出借回执、审查票据）的双族签发与验签。
 * 信封自报用途名，用途名必须登记在 families.ts PURPOSE_MAP、属于信封自报的族、并且是调用方期望的那个用途；
 * 新族原文 = 旧用途下首字段多一个族标签，旧族原文一字不变（旧签名字节照旧可验）。
 * 失败不换族、不换用途重试；off / observe 不认新族，observe 只把新族验签结果放进 observed。
 */
import { signPurpose, verifyPurpose, type InstanceKey } from "../../instance-signature.js";
import { familyTag, PURPOSE_MAP, purposeFamily, type RenameSignatureMode, type SignatureFamily, type SignatureUse } from "./families.js";

export interface PurposeEnvelope { family: SignatureFamily; purpose: string; key: string; sig: string }

type PurposeReject = "unknown_purpose" | "mixed_family" | "wrong_use" | "conflict" | "family_off" | "bad";

export type PurposeCheck =
  | { status: "unsigned" }
  | { status: "ok"; family: SignatureFamily; publicKey: string; observed?: boolean }
  | { status: "reject"; reason: PurposeReject; observed?: boolean };

const message = (family: SignatureFamily, use: SignatureUse, fields: string[]): string[] =>
  family === "floka" ? [familyTag(PURPOSE_MAP[use].floka), ...fields] : fields;

/** 只按信封自报的那一族验一次 */
function verifyOne(env: PurposeEnvelope, use: SignatureUse, fields: string[]): boolean {
  return verifyPurpose(env.key, PURPOSE_MAP[use].claudestra, message(env.family, use, fields), env.sig);
}

/** 信封形状与用途归属；不对返回拒绝原因 */
function classify(env: PurposeEnvelope, use: SignatureUse): PurposeReject | null {
  const owner = purposeFamily(env.purpose);
  if (!owner) return "unknown_purpose";
  if (owner.family !== env.family) return "mixed_family";
  return owner.use === use ? null : "wrong_use";
}

function checkOne(env: PurposeEnvelope, use: SignatureUse, fields: string[], mode: RenameSignatureMode): PurposeCheck {
  const problem = classify(env, use);
  if (problem) return { status: "reject", reason: problem };
  if (env.family === "floka" && mode !== "on") {
    return mode === "observe" ? { status: "reject", reason: "family_off", observed: verifyOne(env, use, fields) } : { status: "reject", reason: "family_off" };
  }
  return verifyOne(env, use, fields) ? { status: "ok", family: env.family, publicKey: env.key } : { status: "reject", reason: "bad" };
}

/**
 * 一份数据可带一个信封，或新旧各一个（同一把钥匙）。两个时：同族两份、钥匙不同按冲突拒；
 * on 下两份都得过（任何一份不对就拒，不挑能过的那份）；off / observe 只认旧族那份，新族那份不扩展接受范围。
 */
export function verifyPurposeFamilies(
  envs: readonly PurposeEnvelope[], use: SignatureUse, fields: string[], mode: RenameSignatureMode,
): PurposeCheck {
  if (envs.length === 0) return { status: "unsigned" };
  if (envs.length === 1) return checkOne(envs[0]!, use, fields, mode);
  const old = envs.find((e) => e.family === "claudestra");
  const neu = envs.find((e) => e.family === "floka");
  if (envs.length > 2 || !old || !neu || old.key !== neu.key) return { status: "reject", reason: "conflict" };
  const a = checkOne(old, use, fields, mode);
  if (a.status !== "ok") return a;
  const b = checkOne(neu, use, fields, mode);
  if (mode !== "on") return b.status === "reject" && b.reason === "family_off" ? { ...a, ...(b.observed !== undefined ? { observed: b.observed } : {}) } : b;
  return b.status === "ok" ? a : b;
}

/** 发送：只出指定一族的信封；钥匙必须显式给，没有钥匙或字段含换行返回 null */
export function signPurposeFamily(family: SignatureFamily, use: SignatureUse, fields: string[], key: InstanceKey | null): PurposeEnvelope | null {
  const s = signPurpose(PURPOSE_MAP[use].claudestra, message(family, use, fields), key);
  return s ? { family, purpose: PURPOSE_MAP[use][family], key: s.key, sig: s.sig } : null;
}
