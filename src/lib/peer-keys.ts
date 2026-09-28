/**
 * 对方实例公钥的钉住规则（纯逻辑；落盘与接线在 bridge/peer-signature.ts，单测 tests/instance-key.test.ts）。
 *
 * 首次见到对方带签名、且签名对得上 → 钉住这把公钥（TOFU，和 SSH 第一次连主机一样）；
 * 之后换了公钥 → key_changed（不替换，等人确认——这正是签名要防的情况）。
 * peers.json 记了对方指纹（recordFp，邀请 / 兑换得来）时以它为准：指纹不符 = key_changed，
 * 指纹相符而钉住的是别的钥匙（对方重装后重新邀请）就改钉。放不放行由 lib/peer-trust.ts 按结果定。
 */
import { isPublicKey, keyFingerprint, type SigCheck } from "./instance-key.js";

type SigResult = "ok" | "unsigned" | "bad" | "stale" | "key_changed";

export interface PinnedPeerKey {
  publicKey?: string;
  fingerprint?: string;
  pinnedAt?: string;
  lastCheck?: { at: string; result: SigResult };
  /** 最近一次验签通过的时刻：doctor 据此分辨「一直不通过」和「有人拿 token 乱签了一次」 */
  lastOkAt?: string;
}

export function judgeSignature(
  prev: PinnedPeerKey | undefined,
  hdr: { key: string | null; ts: string | null; sig: string | null },
  check: (publicKey: string) => SigCheck,
  now: string,
  recordFp: string | null = null,
): PinnedPeerKey {
  const done = (result: SigResult, pin?: Pick<PinnedPeerKey, "publicKey" | "fingerprint" | "pinnedAt">): PinnedPeerKey => ({
    ...prev,
    ...pin,
    lastCheck: { at: now, result },
    ...(result === "ok" ? { lastOkAt: now } : {}),
  });
  if (!hdr.key || !hdr.ts || !hdr.sig) return done("unsigned");
  if (!isPublicKey(hdr.key)) return done("bad");
  if (recordFp ? keyFingerprint(hdr.key) !== recordFp.toLowerCase() : prev?.publicKey && prev.publicKey !== hdr.key) return done("key_changed");
  const r = check(hdr.key);
  if (r !== "ok") return done(r);
  return prev?.publicKey === hdr.key ? done("ok") : done("ok", { publicKey: hdr.key, fingerprint: keyFingerprint(hdr.key), pinnedAt: now });
}
