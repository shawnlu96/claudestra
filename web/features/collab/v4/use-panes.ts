"use client";
/**
 * 两侧栏收起状态的 hook（存取规则在 panes.ts）。右栏收起时选中了东西（peekKey 非空）就临时浮出来显示详情，
 * 关掉详情 = 收回去；临时浮出不写存储。
 */
import { useState } from "react";
import { browser, browserStore, keepDismissed, readPanes, WIDE, writePanes, type Panes } from "./panes";

/**
 * right = 右栏此刻是否展开（含临时浮出）；peek = 这次展开是临时的（浮在画布上，不挤画布，也就不触发重排）。
 * 临时浮出时点收起 = 只把这一次收回去，选中换了再浮出
 */
export function usePanes(peekKey: string | null) {
  const [panes, setPanes] = useState<Panes>(() => readPanes(browserStore(), browser.innerWidth ?? WIDE));
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (keepDismissed(dismissed, peekKey) !== dismissed) setDismissed(null); // 渲染时对齐
  const peek = !panes.right && peekKey !== null && peekKey !== dismissed;
  const save = (p: Panes) => {
    setPanes(p);
    writePanes(browserStore(), p);
  };
  return {
    left: panes.left,
    right: panes.right || peek,
    peek,
    toggleLeft: () => save({ ...panes, left: !panes.left }),
    toggleRight: () => (peek ? setDismissed(peekKey) : save({ ...panes, right: !panes.right })),
  };
}
