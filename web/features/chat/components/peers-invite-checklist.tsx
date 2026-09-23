"use client";
import { useT } from "@/lib/i18n";

/**
 * 邀请串下面的「对方要做的准备」。邀请失败几乎都卡在网络：对方的机器到不到我方地址、
 * 我方 bridge 端口的防火墙放没放行对方——这两步都在 Claudestra 之外，所以生成邀请时就说清楚，
 * 而不是等对方粘贴后看到一句「timed out」。
 */
export function InviteChecklist({ myUrl }: { myUrl?: string }) {
  const t = useT();
  const tailnet = !!myUrl && (/\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(myUrl) || /\.ts\.net(:\d+)?\/?$/.test(myUrl));
  // HTTPS 入口经反代进本机的 peer 专用入口，不经 bridge 端口，也就没有端口防火墙这一关
  const https = !!myUrl?.startsWith("https://");
  return (
    <div className="rounded-lg bg-base-100 p-2 text-[11px] leading-relaxed text-base-content/70">
      <div className="mb-1 font-medium text-base-content/80">{t("发给对方之前，确认这几件事：")}</div>
      <ol className="list-decimal space-y-0.5 pl-4">
        <li>
          {t("对方要能连到")} <span className="font-mono">{myUrl || "—"}</span>
          {tailnet ? t("：把本机共享给对方（Tailscale 后台 → Machines → 本机 → Share），或让对方加入你的 tailnet。共享是单向的，对方共享给你不算。") : "。"}
        </li>
        {!https && <li>{t("如果你给 bridge 端口加了防火墙白名单，要放行对方的地址（对方加入失败时，报错里会显示他的地址）。")}</li>}
        <li>{t("默认单向：对方只能访问你勾选的 agent，你的 agent 能回复他；要你也能主动找他，让他加入时勾选「同时向对方开放」。")}</li>
      </ol>
    </div>
  );
}
