"use client";
import { createPortal } from "react-dom";

/**
 * 双形态浮层外壳（owner 2026-07-24「桌面端不该全屏弹窗」）：
 * - 窄屏(<sm)：fixed inset-0 不透明全屏页——iOS 视口缩放/平移下居中 modal 会
 *   整体歪出屏幕（manage-panel 2026-07-14 实锤），手机必须保持全屏页形态。
 * - 桌面(sm+)：遮罩 + 居中卡片，点遮罩关闭。
 * children 自排 flex-col（shrink-0 头部 + flex-1 滚动区），两形态共用。
 * portal 到 body（规则 5.5：横滑 transform 容器内 fixed 会飞出屏）。
 */
export function ResponsiveShell({
  z = "z-50",
  panelClass = "sm:max-w-lg",
  onClose,
  children,
}: {
  /** 层级类（保持与原全屏形态一致，如 "z-[80]"） */
  z?: string;
  /** 桌面形态的卡片尺寸类（宽/高） */
  panelClass?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return createPortal(
    <div
      className={`overlay-in fixed inset-0 ${z} max-sm:flex max-sm:flex-col max-sm:bg-base-100 sm:grid sm:place-items-center sm:bg-black/50 sm:p-4`}
      onClick={(e) => {
        // 桌面点遮罩关闭；移动端整屏都是内容，点不到这层。
        // stopPropagation:从别的浮层里 portal 出来时不把宿主一起关掉
        e.stopPropagation();
        if (window.matchMedia("(min-width: 640px)").matches) onClose();
      }}
    >
      <div
        className={`panel-pop flex min-h-0 flex-col overflow-hidden max-sm:h-full max-sm:w-full sm:max-h-[85dvh] sm:w-full sm:rounded-2xl sm:bg-base-100 sm:shadow-xl ${panelClass}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
