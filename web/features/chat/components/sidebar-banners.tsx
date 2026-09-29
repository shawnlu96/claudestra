"use client";
import { AsksEntry } from "../../asks/components/asks-entry";
import { InstallBanner } from "./install-banner";
import { PairApprovalBanner } from "./pair-approval-banner";
import { PushBanner } from "./push-banner";
import { useMachines } from "../../machines/use-machines";
import { useFullScope } from "../contacts-data";

/**
 * 侧栏顶部的引导 / 提醒横幅，各自决定显不显示：
 *   InstallBanner       添加到主屏幕（浏览器标签页访问且未 dismiss）
 *   PushBanner          开启推送（已具备推送能力且没问过权限，与安装引导天然互斥；/push/* 要全权，guest 不出）
 *   PairApprovalBanner  有设备手输了配对短码，等这边允许（有管理权限的设备才显示）
 *   AsksEntry           「待你处理」入口（有事才亮）+ 抽屉 + 新来一件时的横幅
 */
export function SidebarBanners() {
  // 切机器就整个重挂：旧机器的待批行和「没权限就停」的状态都不能带到新机器上
  const { current } = useMachines();
  const full = useFullScope() === true;
  return (
    <>
      <InstallBanner />
      {full && <PushBanner />}
      <PairApprovalBanner key={current?.fp ?? "direct"} />
      <AsksEntry machineKey={current?.fp ?? "direct"} />
    </>
  );
}
