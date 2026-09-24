"use client";
import { useT } from "@/lib/i18n";

/**
 * Peer 面板里的实例签名状态（桥接 GET /peers：每个 peer 的 signature + 本机 self.fingerprint，
 * 见 src/bridge/peer-signature.ts）。现阶段只记录不拦截：老版本的对方不签名，协作照常。
 */

export interface PeerSignatureInfo {
  publicKey?: string;
  fingerprint?: string;
  pinnedAt?: string;
  lastCheck?: { at: string; result: "ok" | "unsigned" | "bad" | "stale" | "key_changed" };
}

/** 「他 → 我」下面一行：对方最近一次请求验签的结果 */
export function SignatureLine({ sig }: { sig?: PeerSignatureInfo | null }) {
  const t = useT();
  const r = sig?.lastCheck?.result;
  if (!r) return null;
  const view: Record<string, [string, string]> = {
    ok: ["text-success/80", `✓ ${t("签名已验证")} · ${sig?.fingerprint ?? ""}`],
    unsigned: ["text-base-content/40", t("对方版本还不会签名")],
    bad: ["text-error", `⚠ ${t("签名对不上")}`],
    stale: ["text-warning", `⚠ ${t("签名时间戳过期（两边时钟差太多？）")}`],
    key_changed: ["text-error", `⚠ ${t("对方换了密钥——先确认是他本人换的")}`],
  };
  const [tone, text] = view[r] ?? view.unsigned;
  return <div className={`mt-0.5 truncate font-mono text-[10.5px] ${tone}`}>{text}</div>;
}

/** 面板顶部：本机指纹，给对方核对（他面板里看到的你的指纹应该一样） */
export function SelfFingerprint({ fingerprint }: { fingerprint?: string | null }) {
  const t = useT();
  if (!fingerprint) return null;
  return (
    <div className="text-[11px] text-base-content/45">
      {t("本机指纹")} <span className="font-mono text-base-content/70">{fingerprint}</span>
      <span className="ml-1">{t("（对方面板里显示的应该一样）")}</span>
    </div>
  );
}
