/**
 * 按框形状认真输入框（纯函数、零依赖）：押后 / 抢占（lib/turn-state.ts）、撞墙判定（lib/quota-wall-text.ts）、launcher 自动确认
 * （lib/modal-confirm.ts）共用同一套。放叶子模块是因为 modal-confirm 被 runtimes/claude-code 引用，经 turn-state 引会成环。
 */

/** 输入框边框：顶格、整行只有 ─（去掉行尾空白后至少 3 个）。对话里「─── 小标题」这类混了文字的行不算，窄窗口里短的整行边框算 */
const isBoxRule = (l: string | undefined): boolean => l !== undefined && /^─{3,}$/.test(l.replace(/\s+$/, ""));

/**
 * 真输入框在画面里的上下边框行号，按框的形状认、不看 ❯ 后面的字（草稿首行可以是「1. 先修测试」「2.1.283 …」）：
 * 顶格整行边框正下方是顶格的 ❯（shell 模式是 !），到下一条顶格整行边框之间只有缩进的续行或空行，下边框以下没有顶格文字
 * （状态栏都缩进；权限框、AskUserQuestion 的「Enter to select」提示行、额度菜单都是顶格）。从下往上找，草稿多长都行；
 * 找不到 = null。对话里贴进来的输入框都有缩进，认不成。90 张真 / 合成画面见 tests/turn-zone.test.ts、额度判定 lib/quota-wall-text.ts。
 */
export function inputBox(lines: string[]): { top: number; bottom: number } | null {
  for (let i = lines.length - 1; i > 0; i--) {
    if (!/^[❯!](\s|$)/.test(lines[i]!) || !isBoxRule(lines[i - 1])) continue;
    let j = i + 1;
    while (j < lines.length && !isBoxRule(lines[j]) && (lines[j] === "" || /^\s/.test(lines[j]!))) j++;
    if (j < lines.length && isBoxRule(lines[j]) && !lines.slice(j + 1).some((l) => /^\S/.test(l))) return { top: i - 1, bottom: j };
  }
  return null;
}
