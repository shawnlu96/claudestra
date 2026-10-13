/**
 * 签名族双认的口径（rename-floka-SIGN1）：旧族 claudestra、新族 floka 的用途逐项映射、开关解析、族标签。
 * 新族不另写密码学：用途签名 = 同一旧用途下首字段多一个族标签（与 shared-ledger-join-protocol.ts 的 JOIN 标签同法），
 * 请求签名 = 同一 claudestra-req-v1 原文、方法位带族标签。字段数 +1 / 方法位含小写与冒号，两族签名互相挪不动。
 * 这里不读配置文件也不读本机钥匙；钥匙一律由调用方显式给。单测在 tests/floka-signature.test.ts。
 */
import type { SignPurpose } from "../../instance-signature.js";

export type SignatureFamily = "claudestra" | "floka";
export type RenameSignatureMode = "off" | "observe" | "on";
export type SignatureUse = "invite-pop" | "shared-ledger" | "lend-receipt" | "lend-review-ticket";

/** 新族协议版本：能力证明必须声明这个值才允许切新发送 */
export const FLOKA_SIGNATURE_PROTOCOL = "floka-sig-v1";

/** 逐项登记，不由字符串替换推导：新增用途要在这里显式加一行，两族名字各自写全 */
export const PURPOSE_MAP: Readonly<Record<SignatureUse, { claudestra: SignPurpose; floka: string }>> = {
  "invite-pop": { claudestra: "claudestra-invite-pop-v1", floka: "floka-invite-pop-v1" },
  "shared-ledger": { claudestra: "claudestra-shared-ledger-v1", floka: "floka-shared-ledger-v1" },
  "lend-receipt": { claudestra: "claudestra-lend-receipt-v1", floka: "floka-lend-receipt-v1" },
  "lend-review-ticket": { claudestra: "claudestra-lend-review-ticket-v1", floka: "floka-lend-review-ticket-v1" },
};

export const REQUEST_SIGNATURE = { claudestra: "claudestra-req-v1", floka: "floka-req-v1" } as const;

/** 两族请求签名头；同一请求只许整套出现，不许拆开拼 */
export const REQUEST_HEADERS: Readonly<Record<SignatureFamily, { key: string; ts: string; sig: string }>> = {
  claudestra: { key: "x-claudestra-key", ts: "x-claudestra-ts", sig: "x-claudestra-sig" },
  floka: { key: "x-floka-key", ts: "x-floka-ts", sig: "x-floka-sig" },
};

/** rename.signature：缺省、写错、非字符串一律 off（不扩展接受范围） */
export function parseRenameSignatureMode(config: unknown): RenameSignatureMode {
  const rename = config && typeof config === "object" ? (config as { rename?: unknown }).rename : undefined;
  const v = rename && typeof rename === "object" ? (rename as { signature?: unknown }).signature : undefined;
  return v === "observe" || v === "on" ? v : "off";
}

/** 用途名 → (族, 用途)；没登记的名字返回 null */
export function purposeFamily(name: string): { family: SignatureFamily; use: SignatureUse } | null {
  for (const use of Object.keys(PURPOSE_MAP) as SignatureUse[]) {
    const m = PURPOSE_MAP[use];
    if (m.claudestra === name) return { family: "claudestra", use };
    if (m.floka === name) return { family: "floka", use };
  }
  return null;
}

/**
 * 新族用途签名的首字段。含小写和冒号：旧请求字段首位是大写方法、旧 JOIN 首位是 "JOIN"，都撞不上；
 * 各旧用途字段数固定，新族多一个字段，旧签名的行数对不上新族原文。
 */
export const familyTag = (floka: string): string => `${FLOKA_SIGNATURE_PROTOCOL}:${floka}`;

/** 新族请求签名放在方法位的前缀：真实 HTTP 方法不含冒号，旧发送方签不出这个原文，新签名也过不了旧验签 */
export const requestMethodTag = (method: string): string => `${REQUEST_SIGNATURE.floka}:${method.toUpperCase()}`;
