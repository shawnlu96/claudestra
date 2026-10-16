/**
 * web/features/quota-wall/wall-banner-model.ts（QUOTA1 起是顶部额度卡里 Claude 用完那一行）：GET /api/v1/quota/wall → 那一行写什么。
 * 没闸不出；闸开着：标题「Claude 本周 / 5 小时额度用完，{时间} 重置」，明细是剩余时间、排队条数、人发的消息、探测不可用、重置次数，给「已恢复」；
 * 恢复中换成提示、不给按钮；id 按「哪道闸」，关掉记录据此认。
 */
import { describe, expect, test } from "bun:test";
import { wallLine } from "../web/features/quota-wall/wall-banner-model";

const NOW = new Date(2026, 8, 28, 22, 0).getTime();
const wall = { kind: "weekly", resetsAt: NOW + 3 * 3_600_000, resetsText: "Sep 30 at 6am (Asia/Tokyo)", agents: ["agent-a"], enteredAt: NOW - 60_000 };

describe("wallLine", () => {
  test("没闸 / 形状不对：不出", () => {
    expect(wallLine(null, NOW)).toBeNull();
    expect(wallLine({ active: false, wall: null }, NOW)).toBeNull();
    expect(wallLine({ active: false, wall }, NOW)).toBeNull(); // 出闸了、也不在恢复：不再挂着
  });

  test("周额度用完：标题带重置时刻，明细是剩余时间与排队条数，可以手动出闸", () => {
    const b = wallLine({ active: true, queued: 4, wall }, NOW)!;
    expect(b).toMatchObject({ id: `wall:${wall.enteredAt}`, level: "out", resetsAt: wall.resetsAt, canClear: true });
    expect(b.title).toEqual({ text: "{family} 本周额度用完，{when} 重置", vars: { family: "Claude", when: "9/29 01:00" } });
    expect(b.detail).toEqual([
      { text: "约 {h} 小时后", vars: { h: 3 } },
      { text: "排队 {n} 条 agent 消息，恢复后自动送达", vars: { n: 4 } },
    ]);
  });

  test("有重置次数：多一行「有 N 次重置可用，在会话里发 /limit-reset」；没有就不显示", () => {
    expect(wallLine({ active: true, queued: 0, credits: 2, wall }, NOW)!.detail.at(-1)).toEqual({ text: "有 {n} 次重置可用，在会话里发 /limit-reset", vars: { n: 2 } });
    expect(wallLine({ active: true, queued: 0, credits: 0, wall }, NOW)!.detail).toHaveLength(2);
  });

  test("5 小时额度、重置时间未知、不到一小时、人发的消息与探测不可用", () => {
    expect(wallLine({ active: true, wall: { ...wall, kind: "session" } }, NOW)!.title.text).toBe("{family} 5 小时额度用完，{when} 重置");
    expect(wallLine({ active: true, wall: { ...wall, kind: "other" } }, NOW)!.title.text).toBe("{family} 额度用完，{when} 重置");
    const both = wallLine({ active: true, queued: 2, queuedHuman: 1, wall: { ...wall, probeDown: true } }, NOW)!.detail.map((d) => d.text);
    expect(both).toContain("排队 {n} 条 agent 消息，恢复后自动送达");
    expect(both).toContain("人发的消息 {n} 条押在停着菜单 / 倒计时的窗口上，恢复后送达");
    expect(both).toContain("用量探测不可用：只能等重置回显、到点，或点「已恢复」");
    const unknown = wallLine({ active: true, wall: { ...wall, resetsAt: null } }, NOW)!;
    expect([unknown.title.text, unknown.detail[0]]).toEqual(["{family} 本周额度用完", { text: "重置时间未知", vars: {} }]);
    expect(wallLine({ active: true, wall: { ...wall, resetsAt: NOW + 20 * 60_000 } }, NOW)!.detail[0]).toEqual({ text: "约 {m} 分钟后", vars: { m: 20 } });
  });

  test("恢复中：另一级（关掉过「用完」的会再出一次），不给按钮", () => {
    const b = wallLine({ active: false, wall: { ...wall, recovering: true } }, NOW)!;
    expect(b).toMatchObject({ id: `wall:${wall.enteredAt}`, level: "recovering", canClear: false, detail: [] });
    expect(b.title.text).toBe("额度已恢复，正在关菜单、补投消息、续跑");
  });
});
