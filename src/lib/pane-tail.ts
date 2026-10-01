/**
 * capture-pane 把可见区的尾部空行原样输出：TUI 实绘区比 pane 矮时（CC 把启动确认框画在屏幕顶部、窗口 resize 后没重绘底部），
 * 49 行高的 pane 只有前 6 行有字，输出照样 49 行。「看最后 N 行」的判定不先剪掉这些空行，内容就被挤出窗口、判定静默落空。
 * 纯函数、零依赖：tmux-helper、auq-pane、turn-state 都用它，放叶子模块不成环。用例见 tests/pane-tail.test.ts。
 */

/** 剪掉尾部的空白行（只剪整行空白；最后一行有字时行尾空格原样保留） */
export function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  return lines.slice(0, end);
}

/** pane 剪掉尾部空白行之后的最后 n 行 */
export const paneTail = (pane: string, n: number): string[] => trimTrailingBlank(pane.split("\n")).slice(-n);
