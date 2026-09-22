import { describe, expect, test } from "bun:test";
import {
  autoCompactOptions,
  fmtTokens,
  type AutoCompactState,
} from "@/features/chat/components/settings/auto-compact-options";

const defaults = { window: 750_000, idleHours: 3 };
const st = (p: Partial<AutoCompactState>): AutoCompactState => ({
  window: null,
  idleHours: null,
  defaults,
  ...p,
});

describe("autoCompactOptions（设置 · 自动存记忆 + Compact 的下拉选项）", () => {
  test("还没读到配置：当前值为 null，选项是预设表", () => {
    const o = autoCompactOptions(null);
    expect(o.acWindow).toBeNull();
    expect(o.acIdle).toBeNull();
    expect(o.acWindowOpts).toEqual([400_000, 500_000, 750_000, 1_000_000]);
    expect(o.acIdleOpts).toEqual([0, 1, 3, 6, 12]);
  });

  test("未设（null）→ 用默认值", () => {
    const o = autoCompactOptions(st({}));
    expect(o.acWindow).toBe(750_000);
    expect(o.acIdle).toBe(3);
  });

  test("手工改过的非标准值插进选项表并排序（否则 select 对不上任何 option）", () => {
    const o = autoCompactOptions(st({ window: 600_000, idleHours: 2 }));
    expect(o.acWindowOpts).toEqual([400_000, 500_000, 600_000, 750_000, 1_000_000]);
    expect(o.acIdleOpts).toEqual([0, 1, 2, 3, 6, 12]);
  });

  test("window=0（关闭）不插进阈值表——「关闭」是单独那一项", () => {
    const o = autoCompactOptions(st({ window: 0 }));
    expect(o.acWindow).toBe(0);
    expect(o.acWindowOpts).toEqual([400_000, 500_000, 750_000, 1_000_000]);
  });

  test("每次调用返回新数组，不污染预设表", () => {
    autoCompactOptions(st({ window: 123_000 }));
    expect(autoCompactOptions(null).acWindowOpts).toEqual([400_000, 500_000, 750_000, 1_000_000]);
  });

  test("fmtTokens：百万显示 M，其余四舍五入到 K", () => {
    expect(fmtTokens(1_000_000)).toBe("1M");
    expect(fmtTokens(750_000)).toBe("750K");
    expect(fmtTokens(123_456)).toBe("123K");
  });
});
