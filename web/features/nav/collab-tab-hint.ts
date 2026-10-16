/**
 * 团队页「成员与位子」「规划与提案」要直达协作视图的团队标签（NAVBAR1）：标签状态都在协作视图内部，这里只放一次性的「落在哪」。
 * 协作视图挂载时 peek 决定是不是先开团队标签（桌面中区标签 / 手机团队整屏），团队标签挂载时 take 决定子标签并清掉。
 * 点的正是已开着的项目（live）时视图不会重挂，就经 useCollabTabHint 通知已挂着的那几处当场切；不是 live 就不通知，
 * 免得旧项目的团队标签在换项目前把提示取走。5 秒没人取就作废：团队标签没出现时，不让下一次随手打开的协作视图也跳过去。
 */
import { useEffect, useRef } from "react";

export type CollabTabHint = "members" | "ops";

const TTL_MS = 5_000;
let hint: { tab: CollabTabHint; at: number } | null = null;
const subs = new Set<(tab: CollabTabHint) => void>();

export function hintCollabTab(tab: CollabTabHint, live = false): void {
  hint = { tab, at: Date.now() };
  if (live) for (const cb of [...subs]) cb(tab);
}

export function peekCollabTab(): CollabTabHint | null {
  if (hint && Date.now() - hint.at > TTL_MS) hint = null;
  return hint?.tab ?? null;
}

export function takeCollabTab(): CollabTabHint | null {
  const tab = peekCollabTab();
  hint = null;
  return tab;
}

/** 已挂着的协作视图跟着 live 提示切标签；apply 拿到的是这次的标签（团队标签会 take 掉，别的订阅者不能再 peek） */
export function useCollabTabHint(apply: (tab: CollabTabHint) => void): void {
  const ref = useRef(apply);
  useEffect(() => {
    ref.current = apply;
  });
  useEffect(() => {
    const cb = (tab: CollabTabHint) => ref.current(tab);
    subs.add(cb);
    return () => {
      subs.delete(cb);
    };
  }, []);
}
