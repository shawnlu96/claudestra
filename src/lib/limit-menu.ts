/**
 * CC 撞额度后弹的菜单（「What do you want to do?」+ 额度选项 + 「Enter to confirm · Esc to cancel」）的宽松识别：判「停在额度菜单、
 * 一个键都不发」用。纯函数、不 import 任何东西——tmux-helper（launcher 自动确认弹窗）和 quota-wall-text 都要用，放这里不成环。
 * 判「能不能发 Esc 关掉」用 quota-wall-text 里严格的 matchLimitMenu。单测 tests/quota-wall-text.test.ts、tests/tmux-helper*.test.ts。
 */
const MENU_HINT = /^Enter to confirm\s*·\s*Esc to cancel$/i;
const MENU_TITLE = "What do you want to do?";
/** 额度菜单里才有的项：新旧版本的文案都算；usage_based 计费时是「Stop」「Switch to usage」（CC 2.1.283 源码，adv3 P2-2） */
const LIMIT_OPTION_RE = /limit to reset|usage credits|Switch to usage|lower priority|continue automatically|Upgrade your plan|Add funds to continue/i;
const tailOf = (lines: string[]): string[] => lines.filter((l) => l.trim()).slice(-24);
/** 最后 1~3 行拼起来是提示行（≤34 列时「Enter to confirm · Esc to cancel」会折行）→ 占几行；不是 → 0 */
function hintRows(tail: string[]): number {
  for (let k = 1; k <= Math.min(3, tail.length); k++) if (MENU_HINT.test(tail.slice(-k).map((l) => l.trim()).join(" "))) return k;
  return 0;
}
/** 最后一个标题行（窄到折成两行也算）→ [标题起点, 标题之后第一行]；没有 → null */
function titleAt(tail: string[]): [number, number] | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.trim() === MENU_TITLE) return [i, i + 1];
    if (i + 1 < tail.length && `${tail[i]!.trim()} ${tail[i + 1]!.trim()}` === MENU_TITLE) return [i, i + 2];
  }
  return null;
}

/**
 * 画面底部是额度菜单：最后 1~3 行是提示行，往上 24 行内有标题，两者之间有一项是额度菜单才有的选项（按编号拆开逐项比，
 * 窄窗口的 Ink 折行、促销说明行都不影响）。不要求每一项都认得；中间夹着顶格的行就不是（菜单整块缩进）。
 */
export function limitMenuAtBottom(lines: string[]): boolean {
  const tail = tailOf(lines);
  const k = hintRows(tail);
  const t = k ? titleAt(tail) : null;
  const body = t ? tail.slice(t[1], -k) : [];
  if (!body.length || body.some((l) => !/^\s/.test(l))) return false;
  const opts = body.map((l) => l.trim()).join(" ").split(/(?:^|\s)(?:❯\s*)?\d+\.\s+/).map((o) => o.trim()).filter(Boolean);
  return opts.some((o) => LIMIT_OPTION_RE.test(o) || /^Stop$/i.test(o));
}

/**
 * 底部出现「What do you want to do?」、它下面没有输入框的边框：认不认得选项、提示行折成什么样都算停在菜单上。打字 / 回车 / Esc
 * 类入口据此一律不发键——认不出的额度菜单上打一行字再回车可能选中花钱的项（adv3 P2-2：实验开关打开时它排第 1 项）
 */
export function menuTitleShown(lines: string[]): boolean {
  const tail = tailOf(lines);
  const t = titleAt(tail);
  return !!t && !tail.slice(t[1]).some((l) => /^─{3,}\s*$/.test(l));
}

export const paneShowsLimitMenu = (pane: string): boolean => {
  const lines = pane.replace(/\s+$/, "").split("\n");
  return limitMenuAtBottom(lines) || menuTitleShown(lines);
};
