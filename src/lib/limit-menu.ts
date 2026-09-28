/**
 * CC 撞额度后弹的菜单（「What do you want to do?」+ 额度选项 + 「Enter to confirm · Esc to cancel」）的宽松识别：判「停在额度菜单、
 * 一个键都不发」用。纯函数、不 import 任何东西——tmux-helper（launcher 自动确认弹窗）和 quota-wall-text 都要用，放这里不成环。
 * 判「能不能发 Esc 关掉」用 quota-wall-text 里严格的 matchLimitMenu。单测 tests/quota-wall-text.test.ts、tests/tmux-helper*.test.ts。
 */
const MENU_HINT_LINE = /^\s*Enter to confirm\s*·\s*Esc to cancel\s*$/i;
/** 额度菜单里才有的项：新旧版本的文案都算 */
const LIMIT_OPTION_RE = /limit to reset|usage credits|lower priority|continue automatically|Upgrade your plan|Add funds to continue/i;

/**
 * 画面底部是额度菜单：最后一行是提示行，往上 20 行内有标题，两者之间出现额度菜单才有的选项文字（行拼起来再比，窄窗口的
 * Ink 折行、促销说明行都不影响）。不要求每一项都认得、也不要求每行都是编号项；中间夹着顶格的行就不是（菜单整块缩进）。
 */
export function limitMenuAtBottom(lines: string[]): boolean {
  const tail = lines.filter((l) => l.trim()).slice(-20);
  if (!tail.length || !MENU_HINT_LINE.test(tail[tail.length - 1]!)) return false;
  const head = tail.findLastIndex((l) => /^\s*What do you want to do\?\s*$/.test(l));
  const body = tail.slice(head + 1, -1);
  if (head < 0 || !body.length || body.some((l) => !/^\s/.test(l))) return false;
  return LIMIT_OPTION_RE.test(body.map((l) => l.trim()).join(" "));
}

export const paneShowsLimitMenu = (pane: string): boolean => limitMenuAtBottom(pane.replace(/\s+$/, "").split("\n"));
