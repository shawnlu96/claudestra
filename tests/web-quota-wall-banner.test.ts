/**
 * web/features/quota-wall/wall-banner-model.ts：GET /api/v1/quota/wall → 横幅。没闸不显示；闸开着给种类、重置时刻、
 * 排队条数和「已恢复」按钮；恢复中换成提示、不给按钮；key 按「哪道闸 + 什么状态」，关掉后状态变了才再弹。
 */
import { describe, expect, test } from "bun:test";
import { wallBanner } from "../web/features/quota-wall/wall-banner-model";

const NOW = new Date(2026, 8, 28, 22, 0).getTime();
const wall = { kind: "weekly", resetsAt: NOW + 3 * 3_600_000, resetsText: "Sep 30 at 6am (Asia/Tokyo)", agents: ["agent-a"], enteredAt: NOW - 60_000 };

describe("wallBanner", () => {
  test("没闸 / 形状不对：不显示", () => {
    expect(wallBanner(null, NOW)).toBeNull();
    expect(wallBanner({ active: false, wall: null }, NOW)).toBeNull();
    expect(wallBanner({ active: false, wall }, NOW)).toBeNull(); // 出闸了、也不在恢复：不再挂着
  });

  test("闸开着：周额度标题、重置时刻与剩余时间、排队条数，可以手动出闸", () => {
    const b = wallBanner({ active: true, queued: 4, wall }, NOW)!;
    expect(b).toMatchObject({ key: `${wall.enteredAt}:active`, tone: "warning", title: "Claude Code 周额度已用完", canClear: true });
    expect(b.detail).toEqual([
      { text: "{when} 重置", vars: { when: "9/29 01:00" } },
      { text: "约 {h} 小时后", vars: { h: 3 } },
      { text: "排队 {n} 条 agent 消息，恢复后自动送达", vars: { n: 4 } },
    ]);
  });

  test("有重置次数：多一行提示在撞墙窗口里 /limit-reset；没有就不显示（T24 wf notify-web-rules-3）", () => {
    expect(wallBanner({ active: true, queued: 0, credits: 2, wall }, NOW)!.detail.at(-1)).toEqual({ text: "有 {n} 次重置可用：在撞墙窗口里 /limit-reset", vars: { n: 2 } });
    expect(wallBanner({ active: true, queued: 0, credits: 0, wall }, NOW)!.detail).toHaveLength(3);
  });

  test("session 墙、重置时间未知、不到一小时", () => {
    expect(wallBanner({ active: true, wall: { ...wall, kind: "session" } }, NOW)!.title).toBe("Claude Code 5 小时额度已用完");
    expect(wallBanner({ active: true, wall: { ...wall, resetsAt: null } }, NOW)!.detail[0]).toEqual({ text: "重置时间未知", vars: {} });
    expect(wallBanner({ active: true, wall: { ...wall, resetsAt: NOW + 20 * 60_000 } }, NOW)!.detail[1]).toEqual({ text: "约 {m} 分钟后", vars: { m: 20 } });
  });

  test("恢复中：换一个 key（关掉过的横幅会再弹一次），不给按钮", () => {
    const b = wallBanner({ active: false, wall: { ...wall, recovering: true } }, NOW)!;
    expect(b).toMatchObject({ key: `${wall.enteredAt}:recovering`, tone: "info", canClear: false, detail: [] });
  });
});
