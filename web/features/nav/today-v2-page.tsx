"use client";
/**
 * 新版「今天」页（NAVV2-SHELLA1 骨架）：挂原 TODAY1 整页（NowPage 自带标题，宿主不再画页头），底部是快捷输入插槽。
 * 手机 openToday（「看额度」等）带了 section 时滚到那一块，同 NAVBAR1 的规则：每次 showToday 取一次。
 */
import { useEffect, useRef } from "react";
import { NowPage } from "../now/now-home";
import { scrollToSection } from "../now/today-nav";
import TodayQuickInput from "../now/today-quick-input";
import { takeTodaySection, useTodaySeq } from "./nav-tab";
import type { V2PageProps } from "./nav-v2";

export function TodayV2Page(p: V2PageProps) {
  const box = useRef<HTMLDivElement>(null);
  const seq = useTodaySeq();
  useEffect(() => {
    const target = takeTodaySection();
    const raf = target ? requestAnimationFrame(() => scrollToSection(box.current, target)) : 0;
    return () => cancelAnimationFrame(raf);
  }, [seq]);
  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col" data-v2-page="today"
      style={p.narrow ? { paddingTop: "var(--cstra-quota-pane-safe-top, env(safe-area-inset-top))" } : undefined}>
      <NowPage />
      <TodayQuickInput {...p} />
    </div>
  );
}
