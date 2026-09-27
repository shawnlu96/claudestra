"use client";
import { InstallBanner } from "./install-banner";
import { PairApprovalBanner } from "./pair-approval-banner";
import { PushBanner } from "./push-banner";

/**
 * 侧栏顶部的引导 / 提醒横幅，各自决定显不显示：
 *   InstallBanner       添加到主屏幕（浏览器标签页访问且未 dismiss）
 *   PushBanner          开启推送（已具备推送能力且没问过权限，与安装引导天然互斥）
 *   PairApprovalBanner  有设备手输了配对短码，等这边允许（有管理权限的设备才显示）
 */
export function SidebarBanners() {
  return (
    <>
      <InstallBanner />
      <PushBanner />
      <PairApprovalBanner />
    </>
  );
}
