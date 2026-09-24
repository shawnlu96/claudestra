"use client";
/**
 * /join：加入确认页。两种进来法——
 *   /join#<邀请码>：邀请落地页（src/bridge/invite-page.ts）或 iOS App 链接送过来；
 *   /join?i=web+claudestra:<邀请码>：浏览器登记过的链接（invite-intake.tsx），能进来就说明登记已生效。
 * 邀请码只在浏览器里读（# 不上服务器）；没登录时 proxy 送去 /login?next=，登录后原样回来。
 */
import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n";
import { JoinConfirm } from "@/features/chat/components/peers-join-confirm";
import { findInviteCode } from "@/features/chat/invite-link";
import { setHandlerState } from "@/features/chat/invite-intake";

const noopSubscribe = () => () => {};
const readLocation = () => `${new URLSearchParams(window.location.search).get("i") || ""}#${window.location.hash.slice(1)}`;

export default function JoinPage() {
  const t = useT();
  // 服务端渲染时没有地址栏：null = 还没读到（先不显示「链接不完整」）
  const raw = useSyncExternalStore(noopSubscribe, readLocation, () => null);
  const via = raw?.split("#")[0] ?? "";
  const code = raw === null ? undefined : findInviteCode(decodeURIComponent(raw));
  useEffect(() => {
    if (via) setHandlerState("confirmed");
  }, [via]);
  return (
    <main className="flex min-h-screen items-start justify-center bg-base-200 px-4 pb-8 pt-[calc(env(safe-area-inset-top)+48px)]">
      <div className="w-full max-w-md rounded-2xl bg-base-100 p-5 shadow-sm">
        <div className="mb-3 text-xs font-medium tracking-wide text-base-content/50">{t("Claudestra 协作邀请")}</div>
        {code === undefined ? null : code ? (
          <JoinConfirm code={code} />
        ) : (
          <div className="text-sm text-error">{t("链接里的邀请码缺了或被截断了。请让对方重新复制整条链接发给你。")}</div>
        )}
        <Link href="/" className="btn btn-ghost btn-sm mt-4 w-full">
          {t("回到 Claudestra")}
        </Link>
      </div>
    </main>
  );
}
