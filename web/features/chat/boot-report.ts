import { isNativeShell, hideNativeSplash } from "@/lib/native";

/**
 * v2.21.3+ 启动计时(owner 2026-09-04「性能会更好吗」——拿数字答,不靠感觉):agents 首次
 * 就绪时记一条 [boot] shell|pwa|browser ttfb/dcl/ready,每次页面加载一条。壳里同时
 * 收掉原生启动图(此前 500ms 自动收,跨境链路上用户先看一屏深色空白)。
 */
let bootReported = false;
export function reportBootAndHideSplash() {
  if (bootReported) return;
  bootReported = true;
  const shell = isNativeShell();
  if (shell) hideNativeSplash();
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const kind = shell ? "shell" : window.matchMedia("(display-mode: standalone)").matches ? "pwa" : "browser";
    const ms = (v: number | undefined) => (typeof v === "number" ? Math.round(v) : -1);
    // kb=:壳里 Keyboard 插件的 resize 模式(layout.tsx 内联脚本设置;iPad 为 none)
    const kb = shell ? ` kb=${(window as unknown as { __cstraKbMode?: string }).__cstraKbMode ?? "?"}` : "";
    const msg = `[boot] ${kind} ttfb=${ms(nav?.responseStart)}ms dcl=${ms(nav?.domContentLoadedEventEnd)}ms ready=${Math.round(performance.now())}ms nav=${nav?.type ?? "?"}${kb}`;
    void fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg }) }).catch(() => {});
  } catch { /* ignore */ }
}

