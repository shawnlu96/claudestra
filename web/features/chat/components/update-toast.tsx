"use client";
/**
 * 新版本提示(2026-09-06):壳 / PWA 页面一旦常驻,托管方已发布的新 bundle 永远到不了手机——owner 的 iPhone 页面
 * 挂了一整夜,期间部署的三版前端修复全没生效。回到前台时比对烤入的 commit 与托管方报的版本（lib/version-check.ts），
 * 不一致且当前空闲(没在流式 / 同步 / 浏览历史)就浮一个小胶囊,点一下 reload。不自动刷:回到 agent 时本来就在同步消息。
 * 同一版本关掉一次就不再提示（按 commit 记 localStorage——只记内存态时配上「旧 HTML 被长缓存」就是永远弹）。
 * 另一种情况：当前机器的 bridge 太老（apiVersion 低于前端要求）→ 「这台机器需要升级」，与前端刷新无关，不给刷新按钮。
 */
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { useChatStore } from "../chat-store";
import { useVersionCheck } from "../../machines/use-version-check";

export function UpdateToast() {
  const t = useT();
  const streaming = useChatStore((s) => s.state.streaming);
  const syncState = useChatStore((s) => s.state.syncState);
  const streamDown = useChatStore((s) => s.state.streamDown);
  const browsing = useChatStore((s) => s.state.browsing);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const { stale, machineOld } = useVersionCheck(true);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem("update-toast-dismissed"));
    } catch {
      /* 隐私模式等取不到 localStorage：退回内存态，行为如旧 */
    }
  }, []);
  const busy = streaming || syncState != null || streamDown || browsing || loadingHistory;
  if (busy) return null;
  if (machineOld) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
        <span className="pointer-events-auto rounded-full bg-warning px-4 py-1.5 text-[12.5px] font-semibold text-warning-content shadow-lg">
          ⚠️ {t("这台机器需要升级 Claudestra 才能配合这个版本的网页")}
        </span>
      </div>
    );
  }
  if (!stale || stale === dismissed) return null;
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
            } catch {
              /* 同上：记不住就只在本次页面存活期内不再弹 */
            }
          }}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/**
 * 真正能拿到新 bundle 的刷新（owner 2026-09-15「点了也没有消失」）：`location.reload()` 不是 cache buster，文档命中本地
 * HTTP 缓存时照样交回旧 HTML。两步，第二步保底：① `fetch(cache:"reload")` 强制走网络并改写文档的缓存项；
 * ② 带 `?_v=<新 commit>` 导航——没见过的 URL 不可能命中缓存；参数取 commit 而不是时间戳，同一版本只产生一个 URL，自然收敛。
 */
async function hardReload(commit: string): Promise<void> {
  try {
    await fetch(window.location.href, { cache: "reload", credentials: "same-origin" });
  } catch {
    /* 网络抖动等：直接走下面，它本身就不依赖缓存被刷新 */
  }
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("_v", commit);
    window.location.replace(u.toString());
  } catch {
    window.location.reload(); // URL 构造不出来（极端情况）：退回老行为，好过什么都不做
  }
}
