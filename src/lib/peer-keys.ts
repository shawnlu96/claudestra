/**
 * 对方实例公钥的钉住规则（纯逻辑；落盘与接线在 bridge/peer-signature.ts，单测 tests/instance-key.test.ts）。
 *
 * 首次见到对方带签名、且签名对得上 → 钉住这把公钥（TOFU，和 SSH 第一次连主机一样）；
 * 之后换了公钥 → key_changed（不替换，等人确认——这正是签名要防的情况）。
 * 现阶段只记录结果、不拦请求：老版本的 peer 还不会签名（unsigned），协作照常。
 */
import { isPublicKey, keyFingerprint, type SigCheck } from "./instance-key.js";

type SigResult = "ok" | "unsigned" | "bad" | "stale" | "key_changed";

export interface PinnedPeerKey {
  publicKey?: string;
  fingerprint?: string;
  pinnedAt?: string;
  lastCheck?: { at: string; result: SigResult };
}

export function judgeSignature(
  prev: PinnedPeerKey | undefined,
  hdr: { key: string | null; ts: string | null; sig: string | null },
  check: (publicKey: string) => SigCheck,
  now: string,
): PinnedPeerKey {
  const done = (result: SigResult, pin?: Pick<PinnedPeerKey, "publicKey" | "fingerprint" | "pinnedAt">): PinnedPeerKey => ({
    ...prev,
    ...pin,
    lastCheck: { at: now, result },
  });
  if (!hdr.key || !hdr.ts || !hdr.sig) return done("unsigned");
  if (!isPublicKey(hdr.key)) return done("bad");
  if (prev?.publicKey && prev.publicKey !== hdr.key) return done("key_changed");
  const r = check(prev?.publicKey ?? hdr.key);
  if (r !== "ok") return done(r);
  return prev?.publicKey ? done("ok") : done("ok", { publicKey: hdr.key, fingerprint: keyFingerprint(hdr.key), pinnedAt: now });
}
