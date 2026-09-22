"use client";
import { createPortal } from "react-dom";

/**
 * 居中弹窗的外壳（设置 / 定时任务 / 项目 / Peer / 用量看板共用）。
 *
 * 以前五个弹窗各抄一份，projects 修过的「手机上弹窗歪」（owner 2026-09-02 截图）没同步
 * 到另外四个（D8-11）。统一在这里保证：
 *  - portal 到 body：移动端会话页在 transform 横滑容器里，不 portal 的 fixed 会定位到
 *    屏幕外（web/CLAUDE.md 规则 5b）；
 *  - grid-cols-[minmax(0,1fr)] + 盒子 min-w-0：默认 auto 列会被盒内 nowrap 长内容（任务名、
 *    目录、URL）撑到 max-content，再被 max-w-md 截成 448px——比手机视口宽，盒子向右溢出；
 *  - 遮罩点击 stopPropagation：弹窗可能从另一个弹窗里 portal 出来，React 合成事件沿组件树
 *    冒泡，不拦会连外层一起关。
 * 标题栏和滚动区由各弹窗自己写（形状不一），这里只管外壳。
 */
export function CenteredModal({
  onClose,
  children,
  layer = "top",
  tall = true,
}: {
  onClose: () => void;
  children: React.ReactNode;
  /** base = z-80（从侧栏直接打开的），top = z-90（可能叠在 base 之上的） */
  layer?: "base" | "top";
  /** 最大高度 88dvh；false = 85dvh（用量看板） */
  tall?: boolean;
}) {
  return createPortal(
    <div
      className={`overlay-in fixed inset-0 ${layer === "base" ? "z-[80]" : "z-[90]"} grid grid-cols-[minmax(0,1fr)] place-items-center bg-black/50 p-4`}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className={`panel-pop flex ${tall ? "max-h-[88dvh]" : "max-h-[85dvh]"} w-full min-w-0 max-w-md flex-col rounded-2xl bg-base-100 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
