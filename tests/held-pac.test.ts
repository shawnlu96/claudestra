/**
 * v2.23.1+ pendingAgentCalls 失效判定：押后期间不清（2026-09-17 master→claudestra 回程丢失）。
 */
import { describe, test, expect } from "bun:test";
import { pacStillHeld, requestExpired, requestStillHeld } from "../src/lib/held-pac.ts";

const STALE = 10 * 60_000;
const now = 1_000_000_000;
const oldPac = { ts: now - STALE - 1, callerChannelId: "master-ch" };
const freshPac = { ts: now - 1_000, callerChannelId: "master-ch" };

describe("requestExpired：老数据（请求没记送达时刻）回落槽级 ts", () => {
  test("超 10 分钟、无押后 → 清", () => {
    expect(requestExpired({}, oldPac, undefined, now, STALE)).toBe(true);
    expect(requestExpired({}, oldPac, [], now, STALE)).toBe(true);
  });

  test("超 10 分钟、但该 caller 的消息还押着 → 不清（失效钟从投递起算）", () => {
    const held = [{ fromKind: "local", fromChannelId: "master-ch" }];
    expect(requestExpired({}, oldPac, held, now, STALE)).toBe(false);
  });

  test("押着的是别的 caller / 人类消息 → 照常清", () => {
    expect(requestExpired({}, oldPac, [{ fromKind: "local", fromChannelId: "other-ch" }], now, STALE)).toBe(true);
    expect(requestExpired({}, oldPac, [{ fromKind: "user", fromChannelId: undefined }], now, STALE)).toBe(true);
  });

  test("未超时 → 不清（与押后无关）", () => {
    expect(requestExpired({}, freshPac, undefined, now, STALE)).toBe(false);
  });
});

describe("requestExpired：逐条请求按自己的送达时刻、按 message_id 判押着（T6c1）", () => {
  const held = [{ fromKind: "local", fromChannelId: "master-ch", messageId: "q2" }];
  test("q1 早已送到、q2 还押着：q1 过期，q2 不过期（同一 caller 押着的后一条不挡前一条，也不被它带走）", () => {
    expect(requestExpired({ messageId: "q1", deliveredAt: now - STALE - 1 }, freshPac, held, now, STALE)).toBe(true);
    expect(requestExpired({ messageId: "q2", deliveredAt: now - STALE - 1 }, oldPac, held, now, STALE)).toBe(false);
  });
  test("记了送达时刻就不看槽级 ts：槽很旧、这条刚送到 → 不过期", () => {
    expect(requestExpired({ messageId: "q2", deliveredAt: now - 1_000 }, oldPac, [], now, STALE)).toBe(false);
  });
});

describe("pacStillHeld", () => {
  test("空队列 false；命中同 caller 的 local 消息 true", () => {
    expect(pacStillHeld("a", undefined)).toBe(false);
    expect(pacStillHeld("a", [{ fromKind: "local", fromChannelId: "a" }, { fromKind: "user" }])).toBe(true);
  });
});

describe("requestStillHeld：单条请求按 message_id 判", () => {
  const held = [{ fromKind: "local", fromChannelId: "c-me", messageId: "q2" }];
  test("这条押着 / 同一 caller 的另一条押着但这条送到了 / 老数据按发送方", () => {
    expect(requestStillHeld({ messageId: "q2", callerChannelId: "c-me" }, held)).toBe(true);
    expect(requestStillHeld({ messageId: "q1", callerChannelId: "c-me" }, held)).toBe(false);
    expect(requestStillHeld({ callerChannelId: "c-me" }, held)).toBe(true);
  });
});
