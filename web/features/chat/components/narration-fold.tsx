"use client";
import { useSyncExternalStore } from "react";
import { useChatStore } from "../chat-store";
import { EMPTY_FOLD, getFold, isFolded, setFoldAll, setFoldOne, subscribeFold } from "../narration-fold";
import { useT } from "@/lib/i18n";

/**
 * 旁白块的收起 / 展开 UI（状态与规则在 ../narration-fold.ts）。
 * - 块右下角一行小字：【▴ 收起 / ▾ 展开】切当前块，【收起全部 / 展开全部】切会话级默认；
 * - 收起态只留第一行（line-clamp）当预览，点预览即展开。
 * 按钮都 stopPropagation：旁白块本身的单击是「切时间戳」，别连带触发。
 */
export function useNarrationFold(key?: string) {
  const agent = useChatStore((s) => s.state.activeAgent);
  const state = useSyncExternalStore(
    subscribeFold,
    () => getFold(agent),
    () => EMPTY_FOLD,
  );
  return { agent, all: state.all, folded: key ? isFolded(state, key) : false };
}

const BTN = "rounded px-1 py-0.5 text-[11px] text-base-content/50 transition-colors hover:bg-base-content/10 hover:text-base-content/80";

/** 绝对定位钉在块右下角、不占行高（owner 2026-09-24「否则会多出一行」），hover 才显；
 *  无 hover 的触摸设备常显（否则永远点不到）。父块要有 relative + group。 */
export function NarrationFoldBar({ foldKey }: { foldKey: string }) {
  const t = useT();
  const { agent, all, folded } = useNarrationFold(foldKey);
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div
      className={
        "absolute bottom-0 right-0 flex gap-0.5 select-none rounded-md bg-base-100/85 px-0.5 backdrop-blur-sm " +
        "opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      }
      onClick={stop}
    >
      <button type="button" className={BTN} onClick={() => setFoldOne(agent, foldKey, !folded)}>
        {folded ? t("▾ 展开") : t("▴ 收起")}
      </button>
      <button type="button" className={BTN} onClick={() => setFoldAll(agent, !all)}>
        {all ? t("展开全部") : t("收起全部")}
      </button>
    </div>
  );
}

/** 收起态的一行预览：取第一段非空文本，超出截断。 */
export function NarrationFolded({ text, foldKey }: { text: string; foldKey: string }) {
  const { agent } = useNarrationFold();
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
