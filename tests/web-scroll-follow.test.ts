/**
 * 消息列表吸底 / 回到底部判据（owner 2026-09-21 报「刷出一条新消息就被拉回底部」）。
 * 根 tsconfig 把 "@/*" 映到 web/*，所以 tests/ 能直接测 web 的纯逻辑。
 */
import { describe, test, expect } from "bun:test";
import { NEAR_BOTTOM_PX, isNearBottom, tailAppendedCount } from "@/features/chat/scroll-follow";

describe("isNearBottom", () => {
  test("正好贴底 / 阈值内算在底部", () => {
    expect(isNearBottom(1000, 800, 200)).toBe(true);
    expect(isNearBottom(1000, 800 - (NEAR_BOTTOM_PX - 1), 200)).toBe(true);
  });

  test("离底超过阈值不算", () => {
    expect(isNearBottom(1000, 800 - NEAR_BOTTOM_PX, 200)).toBe(false);
    expect(isNearBottom(10000, 0, 200)).toBe(false);
  });

  test("内容不足一屏（橡皮筋导致 scrollTop 为负）仍算在底部", () => {
    expect(isNearBottom(200, 0, 200)).toBe(true);
    expect(isNearBottom(200, -30, 200)).toBe(true);
  });
});

describe("tailAppendedCount", () => {
  test("尾部新增几条就记几条", () => {
    expect(tailAppendedCount("c", ["a", "b", "c", "d", "e"])).toBe(2);
  });

  test("流式把同一个气泡写长：尾部 id 没变 ⇒ 不计数", () => {
    expect(tailAppendedCount("c", ["a", "b", "c"])).toBe(0);
  });

  test("向上翻页 prepend：尾部 id 仍在末尾 ⇒ 不计数", () => {
    expect(tailAppendedCount("c", ["x", "y", "a", "b", "c"])).toBe(0);
  });

  test("旧尾部找不到了（合并/换会话）⇒ 保守记 1，不瞎猜", () => {
    expect(tailAppendedCount("gone", ["a", "b"])).toBe(1);
  });

  test("没有旧尾部（首次/切会话后）不计数", () => {
    expect(tailAppendedCount(null, ["a", "b"])).toBe(0);
  });

  test("空列表不计数", () => {
    expect(tailAppendedCount("c", [])).toBe(0);
  });
});
