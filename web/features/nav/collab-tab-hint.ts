/**
 * 团队页「成员与位子」「规划与提案」要直达协作视图的团队标签（NAVBAR1）：标签状态都在协作视图内部，这里只放一次性的「下次打开落在哪」。
 * 协作视图挂载时 peek 决定是不是先开团队标签（桌面中区标签 / 手机团队整屏），团队标签挂载时 take 决定子标签并清掉。
 * 5 秒没人取就作废：团队标签没出现（例如这台机器读不到成员）时，不让下一次随手打开的协作视图也跳过去。
 */
export type CollabTabHint = "members" | "ops";

const TTL_MS = 5_000;
let hint: { tab: CollabTabHint; at: number } | null = null;

export function hintCollabTab(tab: CollabTabHint): void {
  hint = { tab, at: Date.now() };
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
