/**
 * 输入框上方候选面板（slash 命令、@ 提及）共用的桌面键盘接管：↑↓ 移动、Enter / Tab 选中、Esc 关闭。
 * 返回 true = 这个键被面板吃掉了，调用方直接 return。IME 组字中的键由调用方先挡掉（composer onKeyDown 开头）。
 */
export interface PickerKeyHandlers {
  move: (delta: 1 | -1) => void;
  pick: () => void;
  close: () => void;
}

export function handlePickerKey(e: { key: string; shiftKey: boolean; preventDefault: () => void }, h: PickerKeyHandlers): boolean {
  const act =
    e.key === "ArrowDown" ? () => h.move(1)
    : e.key === "ArrowUp" ? () => h.move(-1)
    : (e.key === "Enter" && !e.shiftKey) || e.key === "Tab" ? h.pick
    : e.key === "Escape" ? h.close
    : null;
  if (!act) return false;
  e.preventDefault();
  act();
  return true;
}

/** 选中下标在 [0, n-1] 内移动 */
export const clampSel = (v: number, delta: number, n: number) => Math.min(Math.max(v + delta, 0), Math.max(n - 1, 0));
