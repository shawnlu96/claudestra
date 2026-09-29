/**
 * 邀请的持钥证明（docs/relay/protocol.md「协议新增字段」）：加入方兑换时带一个一次性随机数 nonce 和邀请串里的原始地址，
 * 邀请方核对地址就是这张邀请生成时的地址，兑换成功后用自己的实例钥匙签 [nonce, join 口令, 兑换方指纹, 邀请方实例 id, 邀请地址]，
 * 加入方核对「签名的钥匙就是邀请里说的那一把、签的地址就是自己连的那个」，才把这条联系人合进已有记录、记下指纹 / 公钥 / 实例 id。
 * 邀请串里的 fp、iid、url 都是自报的，谁都能抄或改；不绑地址的话，把兑换原样转给真邀请方也能换到真证明。
 * 签名带用途前缀，挪不成请求签名、也挪不到别的用途（lib/instance-key.ts signPurpose）。单测在 tests/invite-proof.test.ts。
 */
import { randomBytes } from "node:crypto";
import { isPublicKey, keyFingerprint, signPurpose, verifyPurpose, type InstanceKey, type SignPurpose } from "./instance-key.js";
import { relayPeerFingerprint } from "./peers.js";

export const INVITE_PROOF_PURPOSE: SignPurpose = "claudestra-invite-pop-v1";

/** 加入方每次兑换现生成一个：128 位随机数，只在这一次兑换里认 */
export function newInviteNonce(): string {
  return randomBytes(16).toString("base64url");
}

export interface InviteProof {
  key: string;
  sig: string;
}

/**
 * 邀请地址的比较口径：relay:// 取小写指纹；http(s) 取协议 + 主机（URL 解析已转小写、去掉默认端口）+ 去掉尾斜杠的路径；
 * 别的写法返回 ""（当没带）。邀请方比对和证明里签的都是这个值，两边写法不同（大小写、尾斜杠）不算被改过。
 */
export function inviteUrlKey(url: string): string {
  const fp = relayPeerFingerprint(url.trim());
  if (fp) return `relay://${fp}`;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}` : "";
  } catch {
    return ""; // 解析不了的地址：当没带，邀请方不签证明
  }
}

/** 证明覆盖的字段；redeemerFp 是兑换方指纹，inviteUrl 是邀请串里的原始地址 */
export interface ProofFields {
  nonce: string;
  join: string;
  redeemerFp: string;
  inviterIid: string;
  inviteUrl: string;
}

const fields = (f: ProofFields): string[] => [f.nonce, f.join, f.redeemerFp.toLowerCase(), f.inviterIid, inviteUrlKey(f.inviteUrl)];

/** 邀请方：兑换成功、而且知道兑换方是谁（签名核过的指纹）时才签；没有 nonce（老版本加入方）、指纹或邀请地址返回 null */
export function signInviteProof(f: ProofFields, key?: InstanceKey | null): InviteProof | null {
  if (!f.nonce || !f.redeemerFp || !inviteUrlKey(f.inviteUrl)) return null;
  return signPurpose(INVITE_PROOF_PURPOSE, fields(f), key); // key 不给 = 本机实例钥匙
}

/**
 * 加入方：回复里的证明对得上自己这次的 nonce、口令、自己的指纹（redeemerFp）、邀请串里的原始地址，返回邀请方的钥匙与指纹；
 * 不是证明的样子返回 null，形状对但签名不对返回 "bad"（有人在中间改过回复或邀请地址，或者对方不是它声称的那台）。
 */
export function checkInviteProof(proof: unknown, x: ProofFields): { key: string; fp: string } | "bad" | null {
  if (!proof || typeof proof !== "object") return null;
  const { key, sig } = proof as Record<string, unknown>;
  if (typeof key !== "string" || typeof sig !== "string") return "bad";
  if (!isPublicKey(key) || !verifyPurpose(key, INVITE_PROOF_PURPOSE, fields(x), sig)) return "bad";
  return { key, fp: keyFingerprint(key) };
}

export type JoinVerdict = { error: string; hint: string } | { fields: { fp?: string; publicKey?: string; instanceId?: string } };

const REDO = "对方升级后重新发一张邀请，或者删掉旧联系人再加入";

/**
 * 加入方兑换成功后：这次加入能不能落地、记录里写什么。
 *   - 证明签名不对、或签名的钥匙和邀请里写的指纹 / relay:// 地址里的指纹不是同一把 → 拒；
 *   - 合进已有记录、那条记录有期望指纹（anchor）：要么证明的钥匙就是它（记了完整公钥的比完整公钥），
 *     要么 relay:// 地址里的指纹就是它（中继按指纹投递）；都不成立 → 拒，老版本邀请方给不出证明也在这里；
 *   - 指纹、公钥、实例 id 只从证明里取；没有证明时 relay:// 地址记地址里的指纹，http 地址什么都不记（验签按老 peer 处理）；
 *     截止日后（legacyOpen 为假）老 peer 一律被拒，这样的记录对方永远进不来，直接拒绝加入、提示对方升级。
 * 调用方拒绝时要回滚本机记录（对方那边已经兑换成功，提示里说明）。
 */
export function judgeJoin(x: {
  before: { name: string; publicKey?: string } | null;
  anchor: string | null;
  claimedFp?: string;
  relayFp: string | null;
  proof: { key: string; fp: string } | "bad" | null;
  inviterIid: string;
  legacyOpen: boolean;
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
  if (x.relayFp) return { fields: { fp: x.relayFp } };
  if (!x.legacyOpen) return { error: "对方版本过旧，请先升级", hint: "对方的 Claudestra 给不出持钥证明，这样加上的联系人发来的请求都会被拒。请对方先升级（claudestra update）再重新生成一张邀请" };
  return { fields: {} };
}
