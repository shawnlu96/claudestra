/**
 * v2.23.1+ pendingAgentCalls 失效判定：押后期间不清（2026-09-17 master→claudestra 回程丢失）。
 */
import { describe, test, expect } from "bun:test";
import { pacStillHeld, shouldSweepPac } from "../src/lib/held-pac.ts";

const STALE = 10 * 60_000;
const now = 1_000_000_000;
const oldPac = { ts: now - STALE - 1, callerChannelId: "master-ch" };
const freshPac = { ts: now - 1_000, callerChannelId: "master-ch" };

describe("shouldSweepPac", () => {
  test("超 10 分钟、无押后 → 清", () => {
    expect(shouldSweepPac(oldPac, undefined, now, STALE)).toBe(true);
    expect(shouldSweepPac(oldPac, [], now, STALE)).toBe(true);
  });

  test("超 10 分钟、但该 caller 的消息还押着 → 不清（失效钟从投递起算）", () => {
    const held = [{ fromKind: "local", fromChannelId: "master-ch" }];
    expect(shouldSweepPac(oldPac, held, now, STALE)).toBe(false);
  });

  test("押着的是别的 caller / 人类消息 → 照常清", () => {
    expect(shouldSweepPac(oldPac, [{ fromKind: "local", fromChannelId: "other-ch" }], now, STALE)).toBe(true);
    expect(shouldSweepPac(oldPac, [{ fromKind: "user", fromChannelId: undefined }], now, STALE)).toBe(true);
  });

  test("未超时 → 不清（与押后无关）", () => {
    expect(shouldSweepPac(freshPac, undefined, now, STALE)).toBe(false);
  });
});

describe("pacStillHeld", () => {
  test("空队列 false；命中同 caller 的 local 消息 true", () => {
    expect(pacStillHeld("a", undefined)).toBe(false);
    expect(pacStillHeld("a", [{ fromKind: "local", fromChannelId: "a" }, { fromKind: "user" }])).toBe(true);
  });
});
