"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { t, useT } from "@/lib/i18n";

/** dynamic loading fallback——用 useT 订阅而非模块级 t():chunk 加载窗口里切语言也能跟上 */
function TermLoading() {
  const t = useT();
  return (
    <div className="grid flex-1 place-items-center bg-[#1e1e2e] text-sm text-[#cdd6f4]/60">
      {t("加载终端…")}
    </div>
  );
}

const TerminalView = dynamic(
  () => import("./terminal-view").then((m) => m.TerminalView),
  {
    ssr: false,
    loading: () => <TermLoading />,
  }
);

/**
 * 移动端终端页（hash 伪路由 #terminal，owner 2026-07-11：不再给模态框打补丁）。
 *
 * - 结构上消灭「键盘弹起露出背面/背面可滚」：本层是 fixed inset-0 的不透明
 *   全屏页，chat 完全被盖住；iOS 键盘挤压/平移布局视口时露出的也是本层自己
 *   的深色底。
 * - 左滑退出：入口处 pushState("#terminal")，iOS 左缘滑 = history.back →
 *   popstate 关页（与 #chat 会话页同一套导航，prin-0372d5）。
 * - 软键盘：visualViewport 缩小时内容层钉在 (top=vv.offsetTop, h=vv.height)，
 *   控制键条始终贴键盘上沿；键盘在场时底部安全区垫归零。
 * - createPortal 到 body：按钮在 transform 横滑容器内（规则 5.5）。
 */
export function TerminalPage({
  agent,
  displayName,
  onClose,
}: {
  agent: string;
  displayName: string;
  onClose: () => void;
}) {
  const t = useT();
  const [vp, setVp] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      // iOS 露出 focused input 时有两条路：平移 visualViewport（offsetTop>0）
      // 或直接滚 document（scrollY>0，fixed 层跟着被顶出屏）。document 滚动
      // 强制归零（页面本无可滚内容），vv 平移用 offsetTop 钉层补偿。
      if ((window.scrollY || 0) > 0) window.scrollTo(0, 0);
      const keyboardUp = window.innerHeight - vv.height > 40 || vv.offsetTop > 1;
      setVp(keyboardUp ? { h: vv.height, top: vv.offsetTop } : null);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
    };
  }, []);

  // 左缘滑返回(owner 2026-07-16 二版:「滑到一半闪变聊天页,体验很差」)——
  // 一版在 touchmove 过 56px 阈值就立即 onClose,手指还在屏上页面已经切了,
  // 体感即「闪烁」。改成 iOS 原生语义三段式:
  //   拖动中:页面跟手 translateX(直接写 DOM style,不 setState——xterm 在树里,
  //           每 move 重渲染会卡);
  //   松手:位移 > max(90px, 25vw) 才提交(滑出动画 0.2s 后 onClose),否则弹回;
  //   方向裁决:首次位移横向主导才进入拖动,竖向主导则放弃(让给终端滚动);
  //           进入拖动后 stopPropagation,别让 xterm 同时收到触摸当滚动处理。
  // capture 阶段监听,xterm 自己的触摸处理拦不到左缘起始的这一段。
  const edgeRef = useRef<{ x: number; y: number; dragging: boolean; dead: boolean } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  return createPortal(
    <div
      ref={pageRef}
      className="fixed inset-0 z-50 bg-[#1e1e2e]"
      onTouchStartCapture={(e) => {
        const t = e.touches[0];
        edgeRef.current =
          t && t.clientX < 28 ? { x: t.clientX, y: t.clientY, dragging: false, dead: false } : null;
      }}
      onTouchMoveCapture={(e) => {
        const s = edgeRef.current;
        const el = pageRef.current;
        if (!s || s.dead || !el) return;
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - s.x;
        const dy = Math.abs(t.clientY - s.y);
        if (!s.dragging) {
          // 方向裁决:横向主导才接管;竖向先动则整个手势让给终端
          if (dy > 12 && dy > dx) {
            s.dead = true;
            return;
          }
          if (!(dx > 12 && dx > dy * 1.2)) return;
          s.dragging = true;
        }
        e.stopPropagation();
        el.style.transition = "none";
        el.style.transform = `translateX(${Math.max(0, dx)}px)`;
      }}
      onTouchEndCapture={(e) => {
        const s = edgeRef.current;
        const el = pageRef.current;
        edgeRef.current = null;
        if (!s?.dragging || !el) return;
        const t = e.changedTouches[0];
        const dx = t ? t.clientX - s.x : 0;
        const commit = dx > Math.max(90, window.innerWidth * 0.25);
        el.style.transition = "transform 0.2s ease-out";
        if (commit) {
          el.style.transform = "translateX(100%)";
          setTimeout(onClose, 190);
        } else {
          el.style.transform = "translateX(0)";
        }
      }}
    >
      <div
        className="absolute inset-x-0 flex flex-col"
        style={
          vp !== null
            ? ({
                top: vp.top,
                height: vp.h,
                // home 条在键盘后面，控制键条不再垫底部安全区
                ["--term-safe-bottom" as string]: "0px",
              } as React.CSSProperties)
            : { top: 0, height: "100%" }
        }
      >
        <header
          className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-[#181825] px-1.5 py-2 text-[#cdd6f4]"
          style={{ paddingTop: "max(env(safe-area-inset-top), 8px)" }}
        >
          <button
            className="btn btn-ghost btn-sm px-2 text-[#cdd6f4]/80"
            aria-label={t("返回会话")}
            onClick={onClose}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <span className="truncate text-sm font-medium">
            {t(displayName)} · {t("终端")}
          </span>
        </header>
        <TerminalView agent={agent} mobile />
      </div>
    </div>,
    document.body
  );
}
