// 自研 Codex 适配器的失败映射（B32–B36、B55）：codexErrorInfo → AIR 策略、可读标题、终态信封；三条出口在宿主那头得到同一个分类。
import { describe, expect, test } from "bun:test";
import { deliveryUnknownError, envelopeFailure, failureOf, promptFailureResult, protocolFailure, transportLost } from "../src/lib/acp/codex-adapter/failures.ts";
import { airFailureOf, classifyAirFailure, classifyTurnEndFailure, deliveryUnknownCause } from "../src/lib/acp/failures.ts";
import { RpcError } from "../src/lib/acp/rpc.ts";

/** codexErrorInfo → [AIR category, actions]（2.1.1 SESSION_FAILURE_POLICY） */
const TABLE: [unknown, string, string[]][] = [
  ["usageLimitExceeded", "limit", []],
  ["rateLimitExceeded", "limit", ["retry"]],
  ["contextWindowExceeded", "limit", ["new_session"]],
  ["sessionBudgetExceeded", "limit", ["new_session"]],
  ["serverOverloaded", "service", ["retry"]],
  ["internalServerError", "service", ["retry", "new_session"]],
  ["cyberPolicy", "request", []],
  ["badRequest", "request", []],
  ["unauthorized", "access", ["login"]],
  ["other", "service", ["retry"]],
  [{ httpConnectionFailed: { httpStatusCode: 502 } }, "connection", ["retry", "new_session"]],
  [{ responseStreamDisconnected: { httpStatusCode: 429 } }, "limit", ["retry"]],
  [{ httpConnectionFailed: { httpStatusCode: 401 } }, "access", ["login"]],
  ["brandNewInfo", "service", ["retry"]],
  [null, "service", ["retry"]],
];

describe("映射表（B32、B35）", () => {
  for (const [info, category, actions] of TABLE) {
    test(`${JSON.stringify(info)} → ${category} ${JSON.stringify(actions)}；AIR 和信封在宿主那头同一个分类、同一个键`, () => {
      const f = failureOf({ message: "m", codexErrorInfo: info });
      const air = airFailureOf(promptFailureResult("T1", f, true))!;
      expect([air.category, air.actions, air.id, air.severity]).toEqual([category, actions, "T1:error", "error"]);
      expect(classifyTurnEndFailure(envelopeFailure("T1", f), "status:x", "m")).toEqual(classifyAirFailure(air));
    });
  }
});

describe("标题与合成失败（B33、B36）", () => {
  test("provider 的错误信封取出 message；别的文字原样；空文字给兜底", () => {
    const envelope = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "bad tool schema", code: null } });
    expect(failureOf({ message: envelope }).title).toBe("bad tool schema");
    expect(failureOf({ message: JSON.stringify({ type: "error", status: 200, error: {} }) }).title).toContain("status");
    expect(failureOf({ message: "We’re currently experiencing high demand" }).title).toBe("We’re currently experiencing high demand");
    expect(failureOf({ message: "" }).title).toBe("Codex 回合失败");
  });

  test("transport_lost 可重试 + 新会话；主动停掉本地执行时不许续跑；协议错误不可重试", () => {
    expect(envelopeFailure("T", transportLost("exit 1"))).toMatchObject({ kind: "error", retry: true, newSession: true });
    expect(envelopeFailure("T", transportLost("x", true))).toEqual({ kind: "error", message: expect.stringContaining("连接断了"), id: "T:error", retry: false });
    expect(envelopeFailure("T", protocolFailure("坏行"))).toEqual({ kind: "error", message: "坏行", id: "T:error", retry: false });
  });

  test("没声明 AIR：额度用完是 -32603 带 codexErrorInfo（B34），其余 end_turn", () => {
    expect(() => promptFailureResult("T", failureOf({ message: "limit", codexErrorInfo: "usageLimitExceeded" }), false)).toThrow(RpcError);
    expect(promptFailureResult("T", failureOf({ message: "x", codexErrorInfo: "other" }), false)).toEqual({ stopReason: "end_turn" });
  });

  test("投递结果不明的错误：宿主按 CX-H 契约认出来", () => {
    expect(deliveryUnknownCause(deliveryUnknownError("拿不到确认"))).toBe("拿不到确认");
  });
});
