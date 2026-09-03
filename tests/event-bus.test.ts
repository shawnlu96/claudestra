/**
 * v2.6.0+ event-bus 测试：emit / subscribe / replay / 环形淘汰 / 过滤。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  emitEvent,
  subscribeEvents,
  replayEventsSince,
  subscriberCount,
  getAgentStatus,
  RING_LIMIT,
  __resetEventBusForTest,
  markChannelExternallyBusy,
  unmarkChannelExternallyBusy,
  isChannelExternallyBusy,
  getAgentDoneAt,
  isPostTurnActivity,
  forgetAgent,
  type BridgeEvent,
} from "../src/bridge/event-bus.js";

function mk(agent: string, type: BridgeEvent["type"] = "assistant_text", data: Record<string, unknown> = {}) {
  return emitEvent({ agent, chatId: `chan-${agent}`, type, data });
}

beforeEach(() => {
  __resetEventBusForTest();
});

describe("emitEvent", () => {
  test("seq 单调递增，ts 自动补齐", () => {
    const a = mk("alpha");
    const b = mk("alpha");
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.ts).toBeTruthy();
    expect(Date.parse(a.ts)).toBeGreaterThan(0);
  });

  test("字段原样保留", () => {
    const e = emitEvent({ agent: "x", chatId: "api:tok_1", type: "chat_message", data: { direction: "out", text: "hi" } });
    expect(e.agent).toBe("x");
    expect(e.chatId).toBe("api:tok_1");
    expect(e.data.direction).toBe("out");
  });
});

describe("subscribeEvents", () => {
  test("实时收到 + 取消后不再收", () => {
    const got: number[] = [];
    const unsub = subscribeEvents({}, (e) => got.push(e.seq));
    mk("a");
    mk("b");
    expect(got).toEqual([1, 2]);
    unsub();
    mk("a");
    expect(got).toEqual([1, 2]);
    expect(subscriberCount()).toBe(0);
  });

  test("agent 过滤", () => {
    const got: string[] = [];
    subscribeEvents({ agent: "alpha" }, (e) => got.push(e.agent));
    mk("alpha");
    mk("bravo");
    mk("alpha");
    expect(got).toEqual(["alpha", "alpha"]);
  });

  test("agents 白名单过滤（token scope）", () => {
    const got: string[] = [];
    subscribeEvents({ agents: ["a1", "a2"] }, (e) => got.push(e.agent));
    mk("a1");
    mk("a3");
    mk("a2");
    expect(got).toEqual(["a1", "a2"]);
  });

  test("订阅者回调抛异常不影响后续订阅者与主流程", () => {
    const got: number[] = [];
    subscribeEvents({}, () => { throw new Error("boom"); });
    subscribeEvents({}, (e) => got.push(e.seq));
    expect(() => mk("a")).not.toThrow();
    expect(got).toEqual([1]);
  });
});

describe("replayEventsSince", () => {
  test("按 seq 补发，跨 agent 合并有序", () => {
    mk("a"); // 1
    mk("b"); // 2
    mk("a"); // 3
    const replay = replayEventsSince(1);
    expect(replay.map((e) => e.seq)).toEqual([2, 3]);
  });

  test("since=0 拿全部缓冲；filter 生效", () => {
    mk("a");
    mk("b");
    expect(replayEventsSince(0).length).toBe(2);
    expect(replayEventsSince(0, { agent: "b" }).length).toBe(1);
  });

  test("环形淘汰：每 agent 只留最近 RING_LIMIT 条", () => {
    for (let i = 0; i < RING_LIMIT + 50; i++) mk("a");
    const replay = replayEventsSince(0, { agent: "a" });
    expect(replay.length).toBe(RING_LIMIT);
    // 最早的 50 条被淘汰，第一条 seq = 51
    expect(replay[0].seq).toBe(51);
    expect(replay[replay.length - 1].seq).toBe(RING_LIMIT + 50);
  });

  test("淘汰是 per-agent 的，不互相挤占", () => {
    for (let i = 0; i < RING_LIMIT + 10; i++) mk("big");
    mk("small");
    expect(replayEventsSince(0, { agent: "small" }).length).toBe(1);
    expect(replayEventsSince(0, { agent: "big" }).length).toBe(RING_LIMIT);
  });
});

describe("getAgentStatus（[fork] 回合进行态追踪，web composer 刷新同步用）", () => {
  test("无事件 → undefined", () => {
    expect(getAgentStatus("nobody")).toBeUndefined();
  });

  test("thinking / done 事件更新状态，最后一次为准", () => {
    mk("a", "agent_status", { status: "thinking" });
    expect(getAgentStatus("a")).toBe("thinking");
    mk("a", "agent_status", { status: "done" });
    expect(getAgentStatus("a")).toBe("done");
    mk("a", "agent_status", { status: "thinking" });
    expect(getAgentStatus("a")).toBe("thinking");
  });

  test("非 agent_status 事件不影响状态", () => {
    mk("b", "agent_status", { status: "thinking" });
    mk("b", "assistant_text", { text: "hi" });
    mk("b", "tool_start", { name: "Read" });
    expect(getAgentStatus("b")).toBe("thinking");
  });

  test("未知 status 值被忽略（只认 thinking/done）", () => {
    mk("c", "agent_status", { status: "thinking" });
    mk("c", "agent_status", { status: "weird" });
    expect(getAgentStatus("c")).toBe("thinking");
  });

  test("跨 agent 互不干扰 + reset 清空", () => {
    mk("x", "agent_status", { status: "thinking" });
    mk("y", "agent_status", { status: "done" });
    expect(getAgentStatus("x")).toBe("thinking");
    expect(getAgentStatus("y")).toBe("done");
    __resetEventBusForTest();
    expect(getAgentStatus("x")).toBeUndefined();
  });
});

describe("externallyBusy 计数(ask_codex 期间豁免 thinking 对账)", () => {
  test("mark/unmark 计数平衡,并发多路归零才闲", () => {
    __resetEventBusForTest();
    expect(isChannelExternallyBusy("c1")).toBe(false);
    markChannelExternallyBusy("c1");
    markChannelExternallyBusy("c1"); // 同 channel 并发两路 codex
    expect(isChannelExternallyBusy("c1")).toBe(true);
    unmarkChannelExternallyBusy("c1");
    expect(isChannelExternallyBusy("c1")).toBe(true); // 还有一路在跑
    unmarkChannelExternallyBusy("c1");
    expect(isChannelExternallyBusy("c1")).toBe(false); // 归零 = 真闲
  });
  test("多减不为负,空 channelId 安全", () => {
    __resetEventBusForTest();
    unmarkChannelExternallyBusy("c2"); // 未 mark 先 unmark
    expect(isChannelExternallyBusy("c2")).toBe(false);
    markChannelExternallyBusy(""); // 空 id 不记
    expect(isChannelExternallyBusy("")).toBe(false);
  });
})

import { isBusyStatus } from "../src/bridge/event-bus.js";

describe("v2.21.2 compacting 回合态", () => {
  test("compacting 被记录为独立状态,对外 busy 语义同 thinking", () => {
    __resetEventBusForTest();
    emitEvent({ agent: "c", chatId: "1", type: "agent_status", data: { status: "done" } });
    expect(getAgentStatus("c")).toBe("done");
    expect(isBusyStatus(getAgentStatus("c"))).toBe(false);
    emitEvent({ agent: "c", chatId: "1", type: "agent_status", data: { status: "compacting", trigger: "pane" } });
    expect(getAgentStatus("c")).toBe("compacting");
    expect(isBusyStatus(getAgentStatus("c"))).toBe(true);
    emitEvent({ agent: "c", chatId: "1", type: "agent_status", data: { status: "thinking", trigger: "compact_done" } });
    expect(getAgentStatus("c")).toBe("thinking");
    expect(isBusyStatus(undefined)).toBe(false);
  });
  test("未知 status 值不改状态", () => {
    __resetEventBusForTest();
    emitEvent({ agent: "d", chatId: "1", type: "agent_status", data: { status: "compacting" } });
    emitEvent({ agent: "d", chatId: "1", type: "agent_status", data: { status: "bogus" } });
    expect(getAgentStatus("d")).toBe("compacting");
  });
});

// ─────────────────────────────────────────────────────────────
// v2.21.3+ 回合后活动判定:done 前写的记录不得把状态重新点亮
// ─────────────────────────────────────────────────────────────
describe("isPostTurnActivity:jsonl 记录能否补 thinking", () => {
  beforeEach(() => __resetEventBusForTest());

  test("从未 done 过:30s 内新鲜即可", () => {
    const now = 1_000_000_000;
    expect(getAgentDoneAt("a")).toBe(0);
    expect(isPostTurnActivity("a", now - 5_000, now)).toBe(true);
    expect(isPostTurnActivity("a", now - 31_000, now)).toBe(false);
    expect(isPostTurnActivity("a", NaN, now)).toBe(false);
  });

  test("done 之后:Stop 前 0.1s 写的尾巴不算,done 之后的新记录才算", () => {
    const before = Date.now();
    emitEvent({ agent: "a", chatId: "c", type: "agent_status", data: { status: "done" } });
    const doneAt = getAgentDoneAt("a");
    expect(doneAt).toBeGreaterThanOrEqual(before);
    // 回合尾巴:比 done 早 100ms,虽然「新鲜」但不能重点亮
    expect(isPostTurnActivity("a", doneAt - 100, doneAt + 2_000)).toBe(false);
    // 自发新回合:比 done 晚 → 照常点亮
    expect(isPostTurnActivity("a", doneAt + 500, doneAt + 2_000)).toBe(true);
    // 晚于 done 但已经不新鲜(30s 外)→ 回放,不点
    expect(isPostTurnActivity("a", doneAt + 500, doneAt + 40_000)).toBe(false);
  });

  test("thinking / compacting 不刷新 doneAt;forgetAgent 清掉", () => {
    emitEvent({ agent: "a", chatId: "c", type: "agent_status", data: { status: "done" } });
    const d = getAgentDoneAt("a");
    emitEvent({ agent: "a", chatId: "c", type: "agent_status", data: { status: "thinking" } });
    emitEvent({ agent: "a", chatId: "c", type: "agent_status", data: { status: "compacting" } });
    expect(getAgentDoneAt("a")).toBe(d);
    forgetAgent("a");
    expect(getAgentDoneAt("a")).toBe(0);
  });
});
