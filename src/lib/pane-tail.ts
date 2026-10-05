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

/** 弹窗的收尾行。窄窗口里尾注会折行，最后一行只剩半截（「cancel」「to cancel」），也算 */
const MODAL_END_RE = [
  /\b(?:enter|esc) to (?!interrupt\b)\w/i, // 尾注；忙碌行的 esc to interrupt 不算
  /^\s*(?:(?:·|to|confirm|select|continue|accept|cancel|exit|go|back)\s*)+$/i, // 折行后的尾注下半截
  /^\s*❯?\s*\d{1,2}\.\s+\S/, // 编号选项
  /^\s*[╰└][─━]/, // 框底边
];

/**
 * 最后一行有字的行是弹窗的收尾行 = 框还活着、正等着按键。框后面还有 shell 提示符或别的输出 = 那是退出前留在上方的残留，
 * 剪掉尾部空行后它会落进「末尾 N 行」的窗口，不拦就会对着 shell 按 Enter。自动按 Enter 的判定（detectDevChannelsModal、
 * isAutoConfirmableModal）都先过这一关。用例见 tests/modal-confirm.test.ts。
 */
export const endsInModal = (pane: string): boolean => {
  const last = paneTail(pane, 1)[0] ?? "";
  return MODAL_END_RE.some((re) => re.test(last));
};
