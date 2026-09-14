/**
 * 频道对抢识别单测。
 *
 * 重点是**区分合法顶替与两实例内战**——两者在日志里长得一模一样，判据错了
 * 要么天天误报（合法的 MCP 重启也连着顶替好几次），要么永远不报（2026-09-15
 * 那次两个 master 抢了几小时、刷了 2359 行日志，零告警）。
 */

import { describe, test, expect } from "bun:test";
import {
  ContentionTracker,
  CONTENTION_COOLDOWN_MS,
  CONTENTION_LIVE_IDLE_MS,
  CONTENTION_WINDOW_MS,
} from "../src/lib/channel-contention.js";

const T0 = 1_757_000_000_000; // 固定基准，避免用 Date.now() 让测试不确定
const CH = "1494205949924348085";

/** 旧连接 1 秒前还在通信 = 活的 */
const live = (at: number, fromPid: number, toPid: number) => ({ at, fromPid, toPid, idleMs: 1_000 });

describe("ContentionTracker", () => {
  test("两实例来回抢 → 报警，且指出反复出现的 pid", () => {
    const t = new ContentionTracker();
    expect(t.note(CH, live(T0, 200, 100))).toBeNull(); // 第 1 次
    expect(t.note(CH, live(T0 + 3_000, 100, 200))).toBeNull(); // 第 2 次
    const a = t.note(CH, live(T0 + 9_000, 200, 100)); // 第 3 次：100 第二次拿到频道
    expect(a).not.toBeNull();
    expect(a!.channelId).toBe(CH);
    expect(a!.flips).toBe(3);
    expect(a!.repeatPids).toEqual([100]);
    expect(a!.pids).toEqual(expect.arrayContaining([100, 200]));
  });

  test("合法的 MCP 重启（每个 pid 只出现一次）不报警——这是最容易误报的一条", () => {
    const t = new ContentionTracker();
    // Claude Code 连着重启 MCP server：pid 一路递增，没有谁回来过
    expect(t.note(CH, live(T0, 100, 101))).toBeNull();
    expect(t.note(CH, live(T0 + 2_000, 101, 102))).toBeNull();
    expect(t.note(CH, live(T0 + 4_000, 102, 103))).toBeNull();
    expect(t.note(CH, live(T0 + 6_000, 103, 104))).toBeNull();
    expect(t.note(CH, live(T0 + 8_000, 104, 105))).toBeNull();
  });

  test("旧连接早就不说话（僵尸交接）不算对抢", () => {
    const t = new ContentionTracker();
    const dead = (at: number, fromPid: number, toPid: number) => ({
      at,
      fromPid,
      toPid,
      idleMs: CONTENTION_LIVE_IDLE_MS + 1,
    });
    expect(t.note(CH, dead(T0, 200, 100))).toBeNull();
    expect(t.note(CH, dead(T0 + 3_000, 100, 200))).toBeNull();
    expect(t.note(CH, dead(T0 + 6_000, 200, 100))).toBeNull();
    expect(t.note(CH, dead(T0 + 9_000, 100, 200))).toBeNull();
  });

  test("次数够但都在窗口外 → 不报警", () => {
    const t = new ContentionTracker();
    t.note(CH, live(T0, 200, 100));
    t.note(CH, live(T0 + 1_000, 100, 200));
    // 跨过窗口后再来两次：前面两条已被裁掉，凑不满 3 次
    expect(t.note(CH, live(T0 + CONTENTION_WINDOW_MS + 5_000, 200, 100))).toBeNull();
    expect(t.note(CH, live(T0 + CONTENTION_WINDOW_MS + 6_000, 100, 200))).toBeNull();
  });

  test("冷却期内不重复刷告警，过了冷却才再报一次", () => {
    const t = new ContentionTracker();
    t.note(CH, live(T0, 200, 100));
    t.note(CH, live(T0 + 1_000, 100, 200));
    expect(t.note(CH, live(T0 + 2_000, 200, 100))).not.toBeNull(); // 首报
    expect(t.note(CH, live(T0 + 3_000, 100, 200))).toBeNull(); // 冷却中
    expect(t.note(CH, live(T0 + 4_000, 200, 100))).toBeNull();
    // 冷却结束后，仍在对抢 → 再报一次（窗口内仍凑得满）。
    // ⚠ 冷却是从**首报时刻**（T0+2000）起算，不是从 T0，多留一截别踩边界。
    const t2 = T0 + 2_000 + CONTENTION_COOLDOWN_MS + 10_000;
    t.note(CH, live(t2 - 2_000, 100, 200));
    t.note(CH, live(t2 - 1_000, 200, 100));
    expect(t.note(CH, live(t2, 100, 200))).not.toBeNull();
  });

  test("频道之间互不串账", () => {
    const t = new ContentionTracker();
    const OTHER = "999";
    t.note(CH, live(T0, 200, 100));
    t.note(OTHER, live(T0 + 1_000, 400, 300));
    t.note(CH, live(T0 + 2_000, 100, 200));
    expect(t.note(OTHER, live(T0 + 3_000, 300, 400))).toBeNull(); // OTHER 才第 2 次
    expect(t.note(CH, live(T0 + 4_000, 200, 100))).not.toBeNull(); // CH 第 3 次且 100 重复
  });

  test("老版本 channel-server 不上报 pid → 不报警（宁可漏报也不瞎猜）", () => {
    const t = new ContentionTracker();
    const noPid = (at: number) => ({ at, idleMs: 1_000 });
    t.note(CH, noPid(T0));
    t.note(CH, noPid(T0 + 1_000));
    expect(t.note(CH, noPid(T0 + 2_000))).toBeNull();
    expect(t.note(CH, noPid(T0 + 3_000))).toBeNull();
  });

  test("forget 清账后重新计数", () => {
    const t = new ContentionTracker();
    t.note(CH, live(T0, 200, 100));
    t.note(CH, live(T0 + 1_000, 100, 200));
    t.forget(CH);
    expect(t.size()).toBe(0);
    expect(t.note(CH, live(T0 + 2_000, 200, 100))).toBeNull(); // 重新从 1 数起
  });
});
