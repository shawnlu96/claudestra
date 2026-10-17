"use client";
/**
 * 桌面详情的右侧抽屉：没有选中时不渲染、不占位，画布和内容用满宽度；选中任务 / 边 / 折叠组 / 成员 / 节点 / 版本 / 差异时从右侧滑入
 * （宽 440px、transform 220ms、带遮罩）。点遮罩、按 Esc = 调用方的 close；里面就是原右栏那几页，各页自带关闭按钮。
 * esc=false：里面那页自己管 Esc（任务详情 collab-detail.tsx 已监听），这里不再叠一个。手机不走这里，仍是整屏页。
 */
import { useEffect, type ReactNode } from "react";
import p from "./project-tabs.module.css";

export function TaskDrawer({ open, onClose, esc = true, label, children }: { open: boolean; onClose: () => void; esc?: boolean; label: string; children: ReactNode }) {
  useEffect(() => {
    if (!open || !esc) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, esc, onClose]);
  if (!open) return null;
  return (
    <div className={p.drawerWrap} data-task-drawer>
      <div className={p.scrim} data-drawer-scrim onClick={onClose} aria-hidden />
      <div className={p.drawer} role="dialog" aria-label={label}>{children}</div>
    </div>
  );
}
