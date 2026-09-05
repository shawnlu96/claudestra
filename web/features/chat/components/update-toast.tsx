"use client";
/**
 * 新版本提示(2026-09-06):壳 / PWA 页面一旦常驻,服务端已部署的新 bundle 永远
 * 到不了手机——owner 的 iPhone 页面 17:30 启动后挂了一整夜,期间部署的三版前端
 * 修复全没生效(#185 探针升级也一直拿不到数据)。回到前台时对比烤入的 webCommit
 * 与 /api/version,不一致且当前空闲(没在流式 / 同步 / 浏览历史)就浮一个小胶囊,
 * 点一下 reload。不自动刷:回到 agent 时本来就在同步消息,再叠一次整页重载更糟。
 * 同一版本关掉一次就不再提示;每次回前台最多查一次(服务端还有 30s 缓存)。
 */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { CLIENT_WEB_COMMIT } from "@/lib/build-info";
import { useChatStore } from "../chat-store";

export function UpdateToast() {
  const t = useT();
  const streaming = useChatStore((s) => s.state.streaming);
  const syncState = useChatStore((s) => s.state.syncState);
  const streamDown = useChatStore((s) => s.state.streamDown);
  const browsing = useChatStore((s) => s.state.browsing);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const [serverCommit, setServerCommit] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!CLIENT_WEB_COMMIT) return;
    let alive = true;
    let lastCheck = 0;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastCheck < 60_000) return;
      lastCheck = Date.now();
      fetch("/api/version")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { webCommit?: string } | null) => {
          if (alive && j?.webCommit) setServerCommit(j.webCommit);
        })
        .catch(() => {});
    };
    check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
    };
  }, []);
  const stale = serverCommit && serverCommit !== CLIENT_WEB_COMMIT ? serverCommit : null;
  const busy = streaming || syncState != null || streamDown || browsing || loadingHistory;
  if (!stale || stale === dismissed || busy) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
      <span className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-base-300/70 bg-base-100/90 py-1.5 pl-4 pr-3 text-[12.5px] font-medium shadow-lg backdrop-blur-md">
        <button className="font-semibold text-primary" onClick={() => window.location.reload()}>
          {t("新版本已就绪 · 点击刷新")}
        </button>
        <button
          className="text-base-content/45"
          aria-label={t("关闭")}
          onClick={() => setDismissed(stale)}
        >
          ✕
        </button>
      </span>
    </div>
  );
}
