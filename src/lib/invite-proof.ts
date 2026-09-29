/**
 * 邀请的持钥证明（docs/relay/protocol.md「协议新增字段」）：加入方兑换时带一个一次性随机数 nonce，邀请方兑换成功后
 * 用自己的实例钥匙签 [nonce, join 口令, 兑换方指纹, 邀请方实例 id]，加入方核对「签名的钥匙就是邀请里说的那一把」，
 * 才把这条联系人合进已有记录、记下指纹 / 公钥 / 实例 id。邀请串里的 fp、iid 都是自报的，谁都能抄。
 * 签名带用途前缀，挪不成请求签名、也挪不到别的用途（lib/instance-key.ts signPurpose）。单测在 tests/invite-proof.test.ts。
 */
import { randomBytes } from "node:crypto";
import { isPublicKey, keyFingerprint, signPurpose, verifyPurpose, type InstanceKey } from "./instance-key.js";

export const INVITE_PROOF_PURPOSE = "claudestra-invite-pop-v1";

/** 加入方每次兑换现生成一个：128 位随机数，只在这一次兑换里认 */
export function newInviteNonce(): string {
  return randomBytes(16).toString("base64url");
}

export interface InviteProof {
  key: string;
  sig: string;
}

const fields = (nonce: string, join: string, redeemerFp: string, inviterIid: string): string[] => [nonce, join, redeemerFp.toLowerCase(), inviterIid];

/** 邀请方：兑换成功、而且知道兑换方是谁（签名核过的指纹）时才签；没有 nonce（老版本加入方）或没有指纹返回 null */
export function signInviteProof(nonce: string, join: string, redeemerFp: string, inviterIid: string, key?: InstanceKey | null): InviteProof | null {
  if (!nonce || !redeemerFp) return null;
  return signPurpose(INVITE_PROOF_PURPOSE, fields(nonce, join, redeemerFp, inviterIid), key); // key 不给 = 本机实例钥匙
}

/**
 * 加入方：回复里的证明对得上自己这次的 nonce、口令、自己的指纹，返回邀请方的钥匙与指纹；不是证明的样子返回 null，
 * 形状对但签名不对返回 "bad"（有人在中间改过回复，或者对方不是它声称的那台）。
 */
export function checkInviteProof(
  proof: unknown,
  x: { nonce: string; join: string; myFp: string; inviterIid: string },
): { key: string; fp: string } | "bad" | null {
  if (!proof || typeof proof !== "object") return null;
  const { key, sig } = proof as Record<string, unknown>;
  if (typeof key !== "string" || typeof sig !== "string") return "bad";
  if (!isPublicKey(key) || !verifyPurpose(key, INVITE_PROOF_PURPOSE, fields(x.nonce, x.join, x.myFp, x.inviterIid), sig)) return "bad";
  return { key, fp: keyFingerprint(key) };
}

export type JoinVerdict = { error: string; hint: string } | { fields: { fp?: string; publicKey?: string; instanceId?: string } };

const REDO = "对方升级后重新发一张邀请，或者删掉旧联系人再加入";

/**
 * 加入方兑换成功后：这次加入能不能落地、记录里写什么。
 *   - 证明签名不对、或签名的钥匙和邀请里写的指纹 / relay:// 地址里的指纹不是同一把 → 拒；
 *   - 合进已有记录、那条记录有期望指纹（anchor）：要么证明的钥匙就是它（记了完整公钥的比完整公钥），
 *     要么 relay:// 地址里的指纹就是它（中继按指纹投递）；都不成立 → 拒，老版本邀请方给不出证明也在这里；
 *   - 指纹、公钥、实例 id 只从证明里取；没有证明时 relay:// 地址记地址里的指纹，http 地址什么都不记（验签按老 peer 处理）。
 * 调用方拒绝时要回滚本机记录（对方那边已经兑换成功，提示里说明）。
 */
export function judgeJoin(x: {
  before: { name: string; publicKey?: string } | null;
  anchor: string | null;
  claimedFp?: string;
  relayFp: string | null;
  proof: { key: string; fp: string } | "bad" | null;
  inviterIid: string;
}): JoinVerdict {
  const p = x.proof;
  if (p === "bad") return { error: "对方回复里的持钥证明对不上", hint: "回复在路上被改过，或者回你的不是邀请里那台机器。确认邀请来源后请对方重新生成一张。" };
  if (p && ((x.claimedFp && p.fp !== x.claimedFp.toLowerCase()) || (x.relayFp && p.fp !== x.relayFp))) {
    return { error: "邀请里写的指纹和对方签名的钥匙不是同一把", hint: "这张邀请可能被改过：请对方重新生成一张，经可信的渠道发给你。" };
  }
  if (x.before && x.anchor) {
    const byProof = !!p && p.fp === x.anchor && (!x.before.publicKey || x.before.publicKey === p.key);
    if (!byProof && x.relayFp !== x.anchor) return { error: `没法确认对方就是已有联系人「${x.before.name}」`, hint: REDO };
  }
  if (p) return { fields: { fp: p.fp, publicKey: p.key, ...(x.inviterIid ? { instanceId: x.inviterIid } : {}) } };
  return { fields: x.relayFp ? { fp: x.relayFp } : {} };
}
