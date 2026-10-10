/**
 * Claude Code TUI 数字选项 modal 的纯解析（从 tmux-helper.ts 原样迁出）。
 * 只依赖 pane-tail 叶子模块，不碰 tmux / 网络 / 磁盘 / 环境；tmux-helper 以原名 re-export，调用方不迁移。
 */
import { paneTail } from "./pane-tail.js";

/**
 * 解析 Claude Code TUI 里的数字选项 modal（/model 选择器、/mcp 菜单等）。
 * 返回所有可见选项 + 它们对应的按键。超过 25 项会截断（Discord select menu 上限）。
 * 没有检测到选项 modal 返回 null。
 */
export interface ModalOption {
  key: string;       // 发给 tmux 的字符（通常是 "1" / "2" ...）
  label: string;     // ≤80 字符，喂给 Discord button/select 的显示文本
  selected: boolean; // 是否当前高亮（❯ 前缀）
}

export function parseModalOptions(pane: string): ModalOption[] | null {
  // 只看 pane 最后 30 行（modal 总在底部）
  const tail = paneTail(pane, 30);
  const seen = new Set<string>();
  const options: ModalOption[] = [];
  for (const raw of tail) {
    // 匹配 "❯ 1. 文本" 或 "  1. 文本"
    const m = raw.match(/^\s*(❯)?\s*(\d{1,2})\.\s+(.+?)\s*$/);
    if (!m) continue;
    const key = m[2];
    if (seen.has(key)) continue;
    const label = m[3].replace(/\s+/g, " ").trim().slice(0, 80);
    if (!label) continue;
    seen.add(key);
    options.push({ key, label, selected: !!m[1] });
  }
  if (options.length < 2) return null;
  // 关键：真 modal 一定有一个选中标记 ❯，否则就是 Claude 回复里普通的编号列表
  if (!options.some((o) => o.selected)) return null;
  return options.slice(0, 25);
}
