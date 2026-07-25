import { test, expect, describe } from "bun:test";
import {
  decideAfterReplaced,
  REPLACED_BASE_DELAY_MS,
  REPLACED_MAX_DELAY_MS,
} from "../src/lib/link-policy";

describe("decideAfterReplaced", () => {
  // 核心回归：channel-server 没有守护者，退出 = agent 永久失联。
  // 旧行为是收到 replaced 就无条件 exit，2026-07-25 因此掉线多次
  // （误启动的探针抢注册 → 正主自杀 → 探针 60s 后被杀 → 没人服务）。
  test("stdio 还连着 → 重连拿回频道，绝不退出", () => {
    const d = decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 1 });
    expect(d.action).toBe("reconnect");
  });

  test("stdio 关了 → 这才是唯一正当的退出理由", () => {
    const d = decideAfterReplaced({ mcpClosed: true, consecutiveReplaced: 1 });
    expect(d.action).toBe("exit");
  });

  // 曾写过 5 次上限，但那会让「两个都握过手的实例互抢」时双方先后退出，
  // 把可恢复的抖动变成彻底失联。次数只影响退避，永远不影响是否退出。
  test("连续被顶替很多次也不退出（只要 stdio 还在）", () => {
    for (const n of [5, 6, 20, 500]) {
      expect(decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: n }).action).toBe(
        "reconnect",
      );
    }
  });

  test("退避指数增长并封顶 60s", () => {
    const d1 = decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 1 });
    const d2 = decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 2 });
    const d3 = decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 3 });
    expect(d1.delayMs).toBe(REPLACED_BASE_DELAY_MS);
    expect(d2.delayMs).toBe(REPLACED_BASE_DELAY_MS * 2);
    expect(d3.delayMs).toBe(REPLACED_BASE_DELAY_MS * 4);
    expect(decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 99 }).delayMs).toBe(
      REPLACED_MAX_DELAY_MS,
    );
  });

  test("首次退避是 3s —— 短命抢占者走后要尽快拿回频道", () => {
    // 实测：squatter 占用 → 正主 3s 后重新注册把它赶走。太长会拉长掉线窗口。
    expect(decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 1 }).delayMs).toBe(3_000);
  });

  test("计数为 0 或负数时按第 1 次算，不产生 0 延迟忙循环", () => {
    expect(decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 0 }).delayMs).toBe(3_000);
    expect(decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: -3 }).delayMs).toBe(3_000);
  });

  test("退出决策优先于次数 —— stdio 关了就走，不管被顶替几次", () => {
    expect(decideAfterReplaced({ mcpClosed: true, consecutiveReplaced: 0 }).action).toBe("exit");
    expect(decideAfterReplaced({ mcpClosed: true, consecutiveReplaced: 99 }).action).toBe("exit");
  });

  test("每个决策都带可写进日志的原因", () => {
    expect(decideAfterReplaced({ mcpClosed: true, consecutiveReplaced: 1 }).reason).toContain("stdio");
    expect(decideAfterReplaced({ mcpClosed: false, consecutiveReplaced: 1 }).reason).toContain("stdio");
  });
});
