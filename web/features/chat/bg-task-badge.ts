import type { BgTaskView } from "./type";

/**
 * 顶栏「后台任务」按钮的显示规则（tests/web-bg-task-badge.test.ts）：
 * 有在跑的 → 数字 = 在跑数；只剩已完成的 → 按钮弱化、不带数字；一个都没有 → 不显示。
 * 「最近完成」就是 store 里还留着的 done 卡（最多 8 张，✕ 收起即移除），这里不另设时限。
 */
export interface BgTaskBadge {
  show: boolean;
  running: number;
  done: number;
  /** 徽标上的数字；0 = 不画徽标 */
  count: number;
  muted: boolean;
}

export function bgTaskBadge(tasks: readonly Pick<BgTaskView, "status">[]): BgTaskBadge {
  const running = tasks.filter((t) => t.status === "running").length;
  const done = tasks.length - running;
  return { show: tasks.length > 0, running, done, count: running, muted: running === 0 };
}
