"use client";
import { useState } from "react";
import { getLang, useT } from "@/lib/i18n";
import { inviteLink, inviteMessage } from "../invite-link";

/**
 * 生成邀请后的「发给对方」：复制的是一整段能直接转发的话（谁邀请、能找谁、链接、链接打不开时怎么办）。
 * 直连邀请：对方点链接到我方落地页，再回到他自己的 Claudestra 确认（src/bridge/invite-page.ts）；
 * 经中继的邀请：链接由 bridge 给（中继落地页 /i），对方点开就被送回他自己的 Claudestra。
 */
export function InviteShare({ code, agents, link: given }: { code: string; agents: string[]; link?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const msg = inviteMessage(code, agents, getLang(), given) ?? code;
  const link = inviteLink(code, given);
  return (
    <div className="space-y-1.5 rounded-lg bg-base-100 p-3">
      <button
        className="btn btn-primary btn-sm w-full"
        onClick={() => {
          void navigator.clipboard?.writeText(msg).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? t("已复制，发给对方就行") : t("复制邀请")}
      </button>
      <div className="text-[11px] leading-relaxed text-base-content/55">
        {t("对方点开链接，在他自己的 Claudestra 里点一下「加入」就完成。")}
      </div>
      {link && <div className="max-h-16 overflow-y-auto break-all font-mono text-[10px] leading-tight text-base-content/40">{link}</div>}
    </div>
  );
}
