"use client";
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useChatStore } from "../chat-store";
import { getFold, isFolded, setFoldAll, setFoldOne, subscribeFold } from "../narration-fold";
import { useT } from "@/lib/i18n";

/**
 * 旁白块的收起 / 展开 UI（状态与规则在 ../narration-fold.ts）。
 * - 块右下角一行小字：【▴ 收起 / ▾ 展开】切当前块，【收起全部 / 展开全部】切会话级默认；
 * - 收起态只留第一行（truncate）当预览，点预览即展开。
 * 按钮都 stopPropagation：旁白块本身的单击是「切时间戳」，别连带触发。
 *
 * 快照一律是 boolean（peer review #40）：早先返回整个 agent 的状态对象，点一块收起，
 * 几百个旁白块全部重渲，iPhone 上长对话一点就卡。现在只有值翻转的块才重渲。
 */

/** 本块是否收起——只在这个 boolean 翻转时重渲 */
export function useNarrationFold(key?: string): boolean {
  const agent = useChatStore((s) => s.state.activeAgent);
  return useSyncExternalStore(
    subscribeFold,
    () => (key ? isFolded(getFold(agent), key) : false),
    () => false,
  );
}

const BTN = "rounded px-1 py-0.5 text-[11px] text-base-content/50 transition-colors hover:bg-base-content/10 hover:text-base-content/80";
/** 滚动容器（message-list.tsx 的消息区） */
const SCROLLER_ID = "cstra-msgs";

/** 绝对定位钉在块右下角、不占行高（owner 2026-09-24「否则会多出一行」），hover 才显；
 *  无 hover 的触摸设备常显（否则永远点不到）。父块要有 relative + group。 */
export function NarrationFoldBar({ foldKey }: { foldKey: string }) {
  const t = useT();
  const agent = useChatStore((s) => s.state.activeAgent);
  const folded = useNarrationFold(foldKey);
  const all = useSyncExternalStore(subscribeFold, () => getFold(agent).all, () => false);
  const ref = useRef<HTMLDivElement>(null);
  // 「收起 / 展开全部」会让上方的块一起变高矮，iOS Safari 没有滚动锚定，阅读位置
  // 会跳走（peer review #40）：点击前记下本块的视口 top，提交后在 layout effect 里把
  // 滚动容器补回同样的 delta——paint 之前完成，肉眼看不到跳。
  const pending = useRef<{ el: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const scroller = document.getElementById(SCROLLER_ID);
    if (scroller) scroller.scrollTop += p.el.getBoundingClientRect().top - p.top;
  }, [all, folded]);
  const toggleAll = () => {
    const el = ref.current?.parentElement;
    if (el) pending.current = { el, top: el.getBoundingClientRect().top };
    setFoldAll(agent, !all);
  };
  return (
    <div
      ref={ref}
      className={
        "absolute bottom-0 right-0 flex gap-0.5 select-none rounded-md bg-base-100/85 px-0.5 backdrop-blur-sm " +
        "opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      }
      onClick={(e) => e.stopPropagation()}
    >
      <button type="button" className={BTN} onClick={() => setFoldOne(agent, foldKey, !folded)}>
        {folded ? t("▾ 展开") : t("▴ 收起")}
      </button>
      <button type="button" className={BTN} onClick={toggleAll}>
        {all ? t("展开全部") : t("收起全部")}
      </button>
    </div>
  );
}

/** 收起态的一行预览：取第一段非空文本，超出截断。 */
export function NarrationFolded({ text, foldKey }: { text: string; foldKey: string }) {
  const agent = useChatStore((s) => s.state.activeAgent);
  const first = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return (
    <div
      className="cursor-pointer truncate text-[12.5px] italic opacity-70"
      onClick={(e) => {
        e.stopPropagation();
        setFoldOne(agent, foldKey, false);
      }}
    >
      {first}
    </div>
  );
}
