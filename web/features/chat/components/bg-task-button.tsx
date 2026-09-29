"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useChatStore } from "../chat-store";
import { bgTaskBadge } from "../bg-task-badge";
import { BgTaskList } from "./bg-task-panel";
import { useT } from "@/lib/i18n";
import { useKeepInViewport } from "@/lib/keep-in-viewport";

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
 * 会话顶栏的「后台任务」按钮（T57：原来的面板挂在消息流末尾，占地方）。徽标规则见 bg-task-badge.ts；
 * 一个任务都没有就不渲染。点开：桌面贴按钮右对齐的下拉，手机 portal 到 body 的底部弹层
 * （横滑 transform 容器里 fixed 会飞出屏，同 responsive-shell.tsx）。列表本身沿用 BgTaskList。
 */
export function BgTaskButton() {
  const t = useT();
  const tasks = useChatStore((s) => s.state.bgTasks);
  const badge = bgTaskBadge(tasks);
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useKeepInViewport(popRef, open && !narrow);

  // 任务全被收起 / 切了会话（store 清空 bgTasks）→ 跟着关，免得下个任务一来弹层自己冒出来
  if (open && !badge.show) setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // 桌面下拉：点面板外关（与 CtxBadge 同款）；手机弹层有自己的遮罩
    const onDown = (e: PointerEvent) => {
      if (!narrow && wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open, narrow]);

  if (!badge.show) return null;
  const label = badge.running ? `${t("后台任务")} · ${t("运行中")} ${badge.running}` : `${t("后台任务")} · ${t("{n} 个已完成", { n: badge.done })}`;
  const head = (
    <div className="flex items-center gap-1.5 px-1 pb-2 text-[12px] font-semibold">
      <span>{t("后台任务")}</span>
      <span className="font-normal tabular-nums text-base-content/45">{tasks.length}</span>
      {narrow && (
        <button className="btn btn-ghost btn-xs ml-auto font-normal text-base-content/60" onClick={() => setOpen(false)}>
          {t("关闭")}
        </button>
      )}
    </div>
  );
  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        className={`btn btn-ghost btn-sm relative px-2 ${badge.muted ? "text-base-content/35 hover:text-base-content/60" : "text-base-content/60 hover:text-base-content"}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
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
      {open &&
        narrow &&
        createPortal(
          <div className="overlay-in fixed inset-0 z-50 flex flex-col justify-end bg-black/40" onClick={() => setOpen(false)}>
            <div
              className="panel-pop flex max-h-[75dvh] flex-col rounded-t-2xl bg-base-100 px-3 pt-2 shadow-xl"
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
          document.body
        )}
    </div>
  );
}
