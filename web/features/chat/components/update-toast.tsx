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
import { reloadShell } from "@/lib/shell-url";

export function UpdateToast() {
  const t = useT();
  const streaming = useChatStore((s) => s.state.streaming);
  const syncState = useChatStore((s) => s.state.syncState);
  const streamDown = useChatStore((s) => s.state.streamDown);
  const browsing = useChatStore((s) => s.state.browsing);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const [serverCommit, setServerCommit] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // 关掉就**记住**（owner 2026-09-14「这个按钮一直消不掉」）：原先只是内存态，
  // 一刷新就忘 —— 配上「旧 HTML 被长缓存」的循环就是永远弹（点刷新→拿到的还是
  // 那份旧 HTML→commit 依旧不一致→又弹）。按 commit 记 localStorage，出现更新的
  // commit 才再提示一次。
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem("update-toast-dismissed"));
    } catch { /* 隐私模式等取不到 localStorage：退回内存态，行为如旧 */ }
  }, []);
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
        <button className="font-semibold text-primary" onClick={() => void hardReload(stale)}>
          {t("新版本已就绪 · 点击刷新")}
        </button>
        <button
          className="text-base-content/45"
          aria-label={t("关闭")}
          onClick={() => {
            setDismissed(stale);
            try {
              localStorage.setItem("update-toast-dismissed", stale);
            } catch { /* 同上 */ }
          }}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/**
 * 真正能拿到新 bundle 的刷新（owner 2026-09-15「点了也没有消失」）。
 *
 * `window.location.reload()` **不是** cache buster：文档命中本地 HTTP 缓存时它照样
 * 把那份旧 HTML 交回来，于是 commit 依旧对不上、提示再弹——点多少次都一样。
 * 服务端那边的兜底（/api/version 每进程发一次 `Clear-Site-Data: "cache"`）在 **WebKit
 * 上是空操作**（该端点注释里已写明 Safari 不实现），而 iOS 壳就是 WKWebView，
 * 恰好是最需要这条的那一端。
 *
 * 两步，第二步保底：
 *  ① `fetch(cache: "reload")` 强制走网络并**改写**文档在 HTTP 缓存里的那一份 ——
 *     修好的是无参 URL 的缓存项，以后普通刷新也能拿到新的；
 *  ② 带上 `?_v=<新 commit>` 导航 —— 没见过的 URL 不可能命中任何缓存，①失败也稳。
 *     参数取 commit 而不是时间戳：同一版本只产生一个 URL，拿到新 bundle 后
 *     commit 就对上了、不会再弹，自然收敛；下个版本自动换成新值。
 *
 * ⚠ 原生壳里 ② 和普通 `location.reload()` 都不行：壳按「保存的服务器地址」字符串前缀判站外，页面里的任何导航
 *   都可能被踢去系统浏览器（见 lib/shell-url-match.ts）。壳里 ① 照做后交给原生侧重建 WebView 重载。
 */
async function hardReload(commit: string): Promise<void> {
  try {
    await fetch(window.location.href, { cache: "reload", credentials: "same-origin" });
  } catch { /* 网络抖动等：直接走下面，它本身就不依赖缓存被刷新 */ }

  // 原生壳：不碰地址，避免被壳判成站外导航后踢去系统浏览器
  // 原生壳：交给原生侧重载，页面里的任何导航（哪怕 location.reload()）都可能被判站外、踢去系统浏览器（lib/shell-url-match.ts）
  try {
    if (await reloadShell()) return;
  } catch {
    window.location.reload(); // 插件调用失败：退回页面刷新，最坏和修之前一样
    return;
  }

  try {
    const u = new URL(window.location.href);
    u.searchParams.set("_v", commit);
    window.location.replace(u.toString());
  } catch {
    window.location.reload(); // URL 构造不出来（极端情况）：退回老行为，好过什么都不做
  }
}
