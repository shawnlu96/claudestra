/**
 * bridge/codex-turn-failure.ts：哪些事件算「回合以错误结束」（Codex 不发 hook，bridge 替它补 StopFailure）。
 */
import { describe, expect, test } from "bun:test";
import { isTurnFailureEvent } from "../src/bridge/codex-turn-failure.js";

describe("isTurnFailureEvent", () => {
  test("额度用完的 ⛔ 文本、API 错误回合 → 是", () => {
    expect(isTurnFailureEvent("assistant_text", { text: "You've hit your usage limit.", rateLimited: true })).toBe(true);
    expect(isTurnFailureEvent("api_error_turn", { error: "stream disconnected" })).toBe(true);
  });
  test("普通文字、状态事件 → 不是", () => {
    expect(isTurnFailureEvent("assistant_text", { text: "好了" })).toBe(false);
    expect(isTurnFailureEvent("assistant_text", { text: "x", rateLimited: "true" })).toBe(false);
    expect(isTurnFailureEvent("agent_status", { status: "done" })).toBe(false);
  });
});
