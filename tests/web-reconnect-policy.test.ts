import { describe, expect, test } from "bun:test";
import { decideReconnect, type ReconnectInput } from "@/features/chat/reconnect-policy";

const NOW = 1_000_000_000;

/** 默认：流已断、没进过后台、有断点锚、有历史游标 */
function input(over: Partial<ReconnectInput> = {}): ReconnectInput {
  return {
    now: NOW,
    name: "a",
    lastReconnectAt: 0,
    historyLoad: null,
    browsing: false,
    stream: { hasReader: false, agent: null, lastByteAt: 0 },
    hiddenAt: 0,
    lastEvent: { agent: "a", seq: 42 },
    cursorLastSeq: 100,
    ...over,
  };
}
const healthyStream = { hasReader: true, agent: "a", lastByteAt: NOW - 1000 };

describe("decideReconnect", () => {
  test("风暴地板：900ms 内只放行一次；force 只挡 300ms 内的双派发（09-07）", () => {
    expect(decideReconnect(input({ lastReconnectAt: NOW - 500 }))).toEqual({ kind: "skip", why: "floor" });
    expect(decideReconnect(input({ lastReconnectAt: NOW - 500, force: true })).kind).not.toBe("skip");
    expect(decideReconnect(input({ lastReconnectAt: NOW - 200, force: true }))).toEqual({ kind: "skip", why: "floor" });
  });

  test("同 agent 历史请求在飞 <25s：让路，force 也让（慢中继上别把下载作废重来）", () => {
    const hl = { agent: "a", at: NOW - 5000 };
    expect(decideReconnect(input({ historyLoad: hl }))).toEqual({ kind: "skip", why: "history-inflight", inflightMs: 5000 });
    expect(decideReconnect(input({ historyLoad: hl, force: true })).kind).toBe("skip");
    // 别的 agent 的 / 过期的不让
    expect(decideReconnect(input({ historyLoad: { agent: "b", at: NOW - 5000 } })).kind).not.toBe("skip");
    expect(decideReconnect(input({ historyLoad: { agent: "a", at: NOW - 26_000 } })).kind).not.toBe("skip");
  });

  test("历史浏览模式不打扰", () => {
    expect(decideReconnect(input({ browsing: true }))).toEqual({ kind: "skip", why: "browsing" });
  });

  test("流健康且后台 <12s：不重连，只布判活探针（07-24）", () => {
    expect(decideReconnect(input({ stream: healthyStream, hiddenAt: NOW - 5000 }))).toEqual({ kind: "probe" });
    expect(decideReconnect(input({ stream: healthyStream }))).toEqual({ kind: "probe" });
  });

  test("后台 ≥12s 且期间一个字节都没到 = iOS 挂起的死流，直接重连", () => {
    const p = decideReconnect(
      input({ stream: { hasReader: true, agent: "a", lastByteAt: NOW - 20_000 }, hiddenAt: NOW - 15_000 }),
    );
    expect(p.kind).toBe("fast");
    expect(p.kind === "fast" && p.deadStreamHiddenMs).toBe(15_000);
  });

  test("fast（断流自动重连）恒走快路径并带 since", () => {
    expect(decideReconnect(input({ fast: true }))).toEqual({ kind: "fast", since: 42, deadStreamHiddenMs: undefined });
  });

  test("短暂离开（<5min）且有断点锚：快路径", () => {
    expect(decideReconnect(input({ hiddenAt: NOW - 60_000 })).kind).toBe("fast");
  });

  test("force 必走全量：不走快路径（07-25 点推送看不到回复）、不走差量（09-16）", () => {
    expect(decideReconnect(input({ force: true, hiddenAt: NOW - 60_000 })).kind).toBe("full");
    expect(decideReconnect(input({ force: true, fast: true })).kind).toBe("full");
    expect(decideReconnect(input({ force: true, stream: healthyStream })).kind).toBe("full");
  });

  test("断点锚属于别的 agent / 没有锚：不走快路径，有游标走差量", () => {
    expect(decideReconnect(input({ fast: true, lastEvent: { agent: "b", seq: 42 } }))).toEqual({
      kind: "delta", after: 100, deadStreamHiddenMs: undefined,
    });
    expect(decideReconnect(input({ fast: true, lastEvent: { agent: "a", seq: 0 } })).kind).toBe("delta");
  });

  test("长时间后台（≥5min）：有游标走差量，没游标走全量", () => {
    expect(decideReconnect(input({ hiddenAt: NOW - 6 * 60_000 })).kind).toBe("delta");
    expect(decideReconnect(input({ hiddenAt: NOW - 6 * 60_000, cursorLastSeq: null })).kind).toBe("full");
  });
});
