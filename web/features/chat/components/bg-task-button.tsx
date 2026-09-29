"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useChatStore } from "../chat-store";
import { bgTaskBadge } from "../bg-task-badge";
import { BgTaskList } from "./bg-task-panel";
import { useT } from "@/lib/i18n";
import { useKeepInViewport } from "@/lib/keep-in-viewport";
import { useBackSwipe } from "@/lib/use-back-swipe";
import { focusInto, restoreFocus, trapTab } from "@/lib/dialog-focus";

/** lucide layers（仓库不装 lucide-react，路径照抄；stroke 跟随文字色） */
function LayersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </svg>
  );
}

const NARROW = "(max-width: 639.98px)"; // 与 Tailwind sm 断点对齐：窄屏底部弹层，sm+ 下拉
function subscribeNarrow(cb: () => void) {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
const useNarrow = () => useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);

/**
 * 弹层的开关与焦点：Esc / 关闭 / 遮罩 / 右滑 / 任务没了 → 关并把焦点还给触发按钮（按钮已卸载就还给顶栏，lib/dialog-focus.ts）；
 * 点桌面下拉外面 → 关，焦点留在用户点的地方。手机弹层打开时焦点移进去。
 */
function useBgPopup(show: boolean, narrow: boolean) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const headerRef = useRef<HTMLElement | null>(null); // 按钮卸载后的备用焦点目标：打开时记下所在的顶栏
  const wasOpen = useRef(false);
  const restoreOnClose = useRef(true); // 只在事件处理里改
  useKeepInViewport(popRef, open && !narrow);
  const close = (restore: boolean) => {
    restoreOnClose.current = restore;
    setOpen(false);
  };
  const toggle = () => {
    headerRef.current = btnRef.current?.closest("header") ?? null;
    setOpen((v) => !v);
  };

  // 任务全被收起 / 切了会话（store 清空 bgTasks）→ 跟着关，免得下个任务一来弹层自己冒出来（渲染期按 props 改 state）
  if (open && !show) setOpen(false);

  // 开 → 关：提交后再还焦点（按钮这时可能已卸载，restoreFocus 会退到顶栏）
  useEffect(() => {
    if (wasOpen.current && !open && restoreOnClose.current) restoreFocus(btnRef.current, headerRef.current);
    wasOpen.current = open;
    restoreOnClose.current = true;
  }, [open]);

  useEffect(() => {
    if (open && narrow) focusInto(sheetRef.current);
  }, [open, narrow]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(true);
    // 桌面下拉：点面板外关（与 CtxBadge 同款）；手机弹层有自己的遮罩
    const onDown = (e: PointerEvent) => {
      if (!narrow && wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, narrow]);

  return { open, close, toggle, wrapRef, popRef, sheetRef, btnRef };
}

/**
 * 手机底部弹层（portal 到 body：横滑 transform 容器里 fixed 会飞出屏，同 responsive-shell.tsx）。
 * 触摸事件截住冒泡（同 AsksDrawer 的 useBackSwipe stop）：不截的话在弹层里右滑会冒到会话壳、把背后切回会话列表；
 * 右滑在这里只关弹层。role=dialog + aria-modal，Tab 在弹层内循环。
 */
function BgTaskSheet({ sheetRef, head, onClose }: { sheetRef: React.RefObject<HTMLDivElement | null>; head: React.ReactNode; onClose: () => void }) {
  const t = useT();
  const swipe = useBackSwipe({ back: onClose }, true);
  return createPortal(
    <div className="overlay-in fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={onClose} onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("后台任务")}
        tabIndex={-1}
        onKeyDown={(e) => trapTab(e, sheetRef.current)}
        className="panel-pop flex max-h-[75dvh] flex-col rounded-t-2xl bg-base-100 px-3 pt-2 shadow-xl outline-none"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div aria-hidden className="mx-auto mb-2 h-1 w-9 shrink-0 rounded-full bg-base-content/15" />
        {head}
        <div className="min-h-0 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: "touch" }}>
          <BgTaskList />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 会话顶栏的「后台任务」按钮（T57：原来的面板挂在消息流末尾，占地方）。徽标规则见 bg-task-badge.ts；
 * 一个任务都没有就不渲染。点开：桌面贴按钮右对齐的下拉，手机底部弹层（BgTaskSheet）。列表本身沿用 BgTaskList。
 */
export function BgTaskButton() {
  const t = useT();
  const tasks = useChatStore((s) => s.state.bgTasks);
  const badge = bgTaskBadge(tasks);
  const narrow = useNarrow();
  const { open, close, toggle, wrapRef, popRef, sheetRef, btnRef } = useBgPopup(badge.show, narrow);
  if (!badge.show) return null;
  const label = badge.running ? `${t("后台任务")} · ${t("运行中")} ${badge.running}` : `${t("后台任务")} · ${t("{n} 个已完成", { n: badge.done })}`;
  const head = (
    <div className="flex items-center gap-1.5 px-1 pb-2 text-[12px] font-semibold">
      <span>{t("后台任务")}</span>
      <span className="font-normal tabular-nums text-base-content/45">{tasks.length}</span>
      {narrow && (
        <button className="btn btn-ghost btn-xs ml-auto font-normal text-base-content/60" onClick={() => close(true)}>
          {t("关闭")}
        </button>
      )}
    </div>
  );
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        className={`btn btn-ghost btn-sm relative px-2 ${badge.muted ? "text-base-content/35 hover:text-base-content/60" : "text-base-content/60 hover:text-base-content"}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={toggle}
      >
        <LayersIcon />
        {badge.count > 0 && (
          <span className="absolute right-0 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-warning px-1 text-[10px] font-semibold leading-none tabular-nums text-warning-content">
            {badge.count}
          </span>
        )}
      </button>
      {open && !narrow && (
        <div
          ref={popRef}
          className="panel-pop absolute right-0 top-full z-30 mt-1.5 flex max-h-[70dvh] w-[26rem] max-w-[92vw] flex-col rounded-xl border border-base-content/10 bg-base-100 p-2 shadow-lg"
        >
          {head}
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            <BgTaskList />
          </div>
        </div>
      )}
      {open && narrow && <BgTaskSheet sheetRef={sheetRef} head={head} onClose={() => close(true)} />}
    </div>
  );
}
