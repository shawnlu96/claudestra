"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { isNativeShell } from "@/lib/native";

/**
 * 「添加到主屏幕」引导横幅（2026-07-14 owner：要一个引导入口）。
 * - iOS 没有 beforeinstallprompt,只能教学式引导(分享 → 添加到主屏幕);
 * - Chromium 系有该事件 → 给真「安装」按钮直接调 prompt();
 * - 已安装(standalone)不显示;点 ✕ 记 localStorage 永久不再提示。
 */
export function InstallBanner() {
  const t = useT();
  const [show, setShow] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [deferred, setDeferred] = useState<{ prompt: () => Promise<void> } | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem("cstra_a2hs_dismissed")) return;
    } catch {
      return;
    }
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true ||
      isNativeShell(); // v2.22+ 原生壳里没有「添加到主屏幕」这回事
    if (standalone) return;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    setIsIOS(ios);
    if (ios) setShow(true);
    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as unknown as { prompt: () => Promise<void> });
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem("cstra_a2hs_dismissed", "1");
    } catch {
      /* 隐私模式 */
    }
  };

  return (
    <div className="mx-4 mb-2 flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/[0.07] px-3 py-2.5 text-xs">
      <span className="text-base leading-none">📲</span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("安装到主屏幕")}</div>
        {deferred ? (
          <button
            className="btn btn-primary btn-xs mt-1"
            onClick={() => {
              void deferred.prompt().finally(dismiss);
            }}
          >
            {t("安装")}
          </button>
        ) : isIOS ? (
          <div className="mt-0.5 leading-relaxed text-base-content/60">
            {t("点浏览器的分享按钮")}
            <svg className="mx-0.5 inline-block align-[-2px]" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v13M8 7l4-4 4 4" />
              <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
            </svg>
            {t("→ 选「添加到主屏幕」")}
          </div>
        ) : (
          <div className="mt-0.5 text-base-content/60">{t("用浏览器菜单里的「安装应用」")}</div>
        )}
      </div>
      <button className="shrink-0 px-1 opacity-40 hover:opacity-80" aria-label={t("不再提示")} onClick={dismiss}>
        ✕
      </button>
    </div>
  );
}
