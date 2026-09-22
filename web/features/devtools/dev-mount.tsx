"use client";
/**
 * 开发者模式挂载点:订阅总开关,开着才 next/dynamic 加载面板本体——stats.js / lil-gui /
 * 面板代码都不进普通用户的 bundle。放在 chat.tsx 里横滑容器 **之外**(与 Splash 并列),
 * 面板自己再 portal 到 body。
 *
 * 同时把 html[data-dev] 打上,CSS 侧可按它加调试样式;window.__cstraDev 暴露事件环 /
 * 计数器 / 注册接口,控制台里能直接用。
 */
import dynamic from "next/dynamic";
import { useEffect, useSyncExternalStore } from "react";
import { getDevModeServerSnapshot, getDevModeSnapshot, isDevMode, setDevMode, subscribeDevMode } from "./dev-mode";
import { allCounters, bumpCounter, clearDevEvents, devEvent, recentDevEvents, resetCounters } from "./dev-events";
import { registerDevSection } from "./dev-registry";

const DevOverlay = dynamic(() => import("./dev-overlay"), { ssr: false });

export function useDevMode(): boolean {
  return useSyncExternalStore(subscribeDevMode, getDevModeSnapshot, getDevModeServerSnapshot);
}

export function DevToolsMount() {
  const on = useDevMode();
  useEffect(() => {
    document.documentElement.toggleAttribute("data-dev", on);
    const w = window as unknown as { __cstraDev?: unknown };
    if (!on) {
      delete w.__cstraDev;
      return;
    }
    w.__cstraDev = { isDevMode, setDevMode, devEvent, recentDevEvents, clearDevEvents, allCounters, resetCounters, registerDevSection };
    // layout.tsx 的内联钩子每次 React 提交突发都派发这个事件;这里只在开着时计数,
    // 开之前的突发不补(client.log 那条上报不受影响)
    const onBurst = () => bumpCounter("commit-burst");
    window.addEventListener("cstra:commit-burst", onBurst);
    return () => window.removeEventListener("cstra:commit-burst", onBurst);
  }, [on]);
  return on ? <DevOverlay /> : null;
}
