/**
 * 消息列表「吸底 / 回到底部」的两个纯判据（v2.24+，owner 2026-09-21：
 * 「不要刷出一个新消息就自动回到底部，加一个回到底部的按钮，跟 Telegram 一样」）。
 * 单测 tests/web-scroll-follow.test.ts。
 */

/** 离底多少像素以内算「在底部」——与吸底(follow)判据同一个阈值。 */
export const NEAR_BOTTOM_PX = 90;

export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = NEAR_BOTTOM_PX,
): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

/**
 * 距上次记录的尾部之后又追加了几条 —— 回到底部按钮的角标。
 *
 * 规则由这两个坑决定：
 * - **流式**把同一个助手气泡越写越长时 id 不变 ⇒ 尾部还是它 ⇒ 记 0（不该因为
 *   对方还在打字就把角标一直往上堆）；
 * - **向上翻页**是在头部 prepend，尾部 id 仍在末尾 ⇒ 记 0（加载历史不是新消息）。
 *
 * 找不到旧尾部（被合并/换会话/窗口裁掉）时只能保守记 1，不去猜差了多少。
 */
export function tailAppendedCount(prevTailId: string | null, ids: readonly string[]): number {
  if (!ids.length) return 0;
  const lastId = ids[ids.length - 1];
  if (!prevTailId || prevTailId === lastId) return 0;
  const idx = ids.lastIndexOf(prevTailId);
  if (idx < 0) return 1;
  return ids.length - 1 - idx;
}
