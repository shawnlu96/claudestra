"use client";
import { useEffect, useState } from "react";
import type { SettingsPageId } from "./components/settings/nav";

/**
 * 从任何地方打开设置弹窗到指定页（owner 2026-09-28：Chat Guard 提示里「打开设置 → 集成」）。
 * 弹窗状态仍由 Sidebar 持有；这里只是一个请求信箱：openSettings(page) 写入，Sidebar 的 useSettingsPageState 收下。
 */
let pending: SettingsPageId | null = null;
const subs = new Set<() => void>();
export function openSettings(page: SettingsPageId): void {
  pending = page;
  subs.forEach((f) => f());
}
/** Sidebar 用：等价于 useState<SettingsPageId | null>(null)，外加响应 openSettings() */
export function useSettingsPageState(): [SettingsPageId | null, (p: SettingsPageId | null) => void] {
  const [page, setPage] = useState<SettingsPageId | null>(null);
  useEffect(() => {
    const on = () => {
      if (pending) {
        setPage(pending);
        pending = null;
      }
    };
    subs.add(on);
    on();
    return () => {
      subs.delete(on);
    };
  }, []);
  return [page, setPage];
}
