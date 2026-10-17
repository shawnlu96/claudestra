"use client";
/**
 * 新版「我的」页（NAVV2-SHELLA1 骨架，只在手机；电脑「我的」仍是图标栏底部菜单）：同一张 me-entries 表、同一组原回调（MePage），
 * 只有「设置」改成在宿主里进设置页（那页再分到原设置弹窗各页），下面是用量插槽。
 */
import { MePage } from "./me-menu";
import MineUsageSection from "./mine-usage-section";
import type { V2PageProps } from "./nav-v2";

export function MineV2Page(p: V2PageProps) {
  const items = p.items.map((it) => (it.id === "settings" ? { ...it, run: () => p.open("settings") } : it));
  return (
    <div className="flex min-h-full flex-col" data-v2-page="me">
      <MePage items={items} ver={p.version} />
      <MineUsageSection {...p} />
    </div>
  );
}
