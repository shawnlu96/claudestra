import { describe, expect, test } from "bun:test";
import { airFailureOf, classifyAirFailure, classifyPromptError, deliveryUnknownFailure, failureEntry, FailureDedup, type AcpFailure } from "../src/lib/acp/failures.ts";
import { RpcError } from "../src/lib/acp/rpc.ts";

/** codex-acp 2.0.0 声明了 AIR sessionFailure 时 prompt 的返回（CodexAcpServer.ts / CodexEventHandler.ts 的策略表） */
const airResult = (f: Record<string, unknown>) => ({
  stopReason: "end_turn",
  _meta: { quota: { token_count: null, model_usage: [] }, jetbrains: { air: { version: 1, sessionFailure: f } } },
});
const air = (category: string, actions: string[], title = "x", id = "turn-1:error", revision = 1) =>
  airFailureOf(airResult({ id, revision, category, severity: "error", title, actions }))!;

describe("AIR sessionFailure 形态", () => {
  test("额度用完：limit 且没有动作 → quota，key 按 id", () => {
    expect(classifyAirFailure(air("limit", [], "You've hit your usage limit."))).toEqual({
      kind: "quota",
      key: "air:turn-1:error",
      message: "You've hit your usage limit.",
    });
  });

  test("limit + retry = 限流、limit + new_session = 上下文耗尽：都不是额度卡", () => {
    expect(classifyAirFailure(air("limit", ["retry"], "Rate limit reached"))).toMatchObject({ kind: "error", retry: true });
    expect(classifyAirFailure(air("limit", ["new_session"], "Context window exceeded"))).toMatchObject({ kind: "error", retry: false, newSession: true });
  });

  test("标题写着 usage limit 的 limit 也算额度（策略表以后加了动作也认得出）", () => {
    expect(classifyAirFailure(air("limit", ["retry"], "You've hit your usage limit. Try again at 5pm")).kind).toBe("quota");
  });

  test("access / login → auth；service 等 → error，带上能否重试", () => {
    expect(classifyAirFailure(air("access", ["login"])).kind).toBe("auth");
    expect(classifyAirFailure(air("service", ["retry", "new_session"]))).toMatchObject({ kind: "error", retry: true, newSession: true });
    expect(classifyAirFailure(air("request", []))).toMatchObject({ kind: "error", retry: false });
  });

  test("没有 sessionFailure / 形状不对 → null", () => {
    expect(airFailureOf({ stopReason: "end_turn" })).toBeNull();
    expect(airFailureOf(airResult({ revision: 1 }))).toBeNull();
    expect(airFailureOf(null)).toBeNull();
  });

  test("同一横幅的后续 revision 不再出第二张卡；新 id 照出", () => {
    const d = new FailureDedup();
    expect(d.admit(classifyAirFailure(air("limit", [], "u", "t1:error", 1)))).toBe(true);
    expect(d.admit(classifyAirFailure(air("limit", [], "u", "t1:error", 2)))).toBe(false);
    expect(d.admit(classifyAirFailure(air("limit", [], "u", "t2:error", 1)))).toBe(true);
  });
});

describe("没声明 AIR 的 legacy 形态（JSON-RPC 错误）", () => {
  const usage = new RpcError(-32603, "Internal error", {
    message: "You've hit your usage limit. Upgrade to Pro…",
    codexErrorInfo: "usageLimitExceeded",
    additionalDetails: "You've hit your usage limit. Upgrade to Pro…",
  });

  test("codexErrorInfo=usageLimitExceeded → quota，key 按回合，同一回合只出一次", () => {
    const f = classifyPromptError(usage, "t7");
    expect(f).toEqual({ kind: "quota", key: "quota:t7", message: "You've hit your usage limit. Upgrade to Pro…" });
    const d = new FailureDedup();
    expect(d.admit(f)).toBe(true);
    expect(d.admit(classifyPromptError(usage, "t7"))).toBe(false);
    expect(d.admit(classifyPromptError(usage, "t8"))).toBe(true);
  });

  test("-32000 Authentication required → auth（session/new 与 prompt 同一种）", () => {
    expect(classifyPromptError(new RpcError(-32000, "Authentication required"), "t1")).toEqual({
      kind: "auth",
      key: "auth:t1",
      message: "Authentication required",
    });
  });

  test("别的 JSON-RPC 错误 / 普通异常 → error", () => {
    expect(classifyPromptError(new RpcError(-32602, "Invalid params"), "t1")).toEqual({ kind: "error", key: "rpc:t1", message: "Invalid params" });
    expect(classifyPromptError(new Error("acp 连接断了"), "t2")).toMatchObject({ kind: "error", message: "acp 连接断了" });
  });
});

describe("failureEntry（与 codex-session.ts codexTurnError 同形）", () => {
  const ts = "2026-09-29T00:00:00.000Z";
  test("额度原文照登、不标 API 错误（watcher 走 ⛔、不自动续跑）", () => {
    const e = failureEntry({ kind: "quota", key: "k", message: "You've hit your usage limit." }, ts);
    expect(e).toEqual({
      type: "assistant",
      timestamp: ts,
      rateLimited: true,
      isApiErrorMessage: false,
      error: "You've hit your usage limit.",
      message: { content: [{ type: "text", text: "You've hit your usage limit." }] },
    });
  });

  test("可重试 / 不知道能否重试的错误标 API 错误；适配器说不能重试的不标", () => {
    const legacy: AcpFailure = { kind: "error", key: "k", message: "boom" };
    expect(failureEntry(legacy, ts)).toMatchObject({ rateLimited: false, isApiErrorMessage: true, message: { content: [{ text: "API Error: boom" }] } });
    expect(failureEntry({ ...legacy, retry: true }, ts)).toMatchObject({ isApiErrorMessage: true });
    expect(failureEntry({ ...legacy, retry: false }, ts)).toMatchObject({ isApiErrorMessage: false });
  });

  test("没登录不出条目（只出卡）", () => {
    expect(failureEntry({ kind: "auth", key: "k", message: "Authentication required" }, ts)).toBeNull();
  });
});

describe("投递结果不明的卡（CX-H）", () => {
  test("原文附在卡上；太长时留尾（用户的消息在最后，前面可能是上下文前言）", () => {
    expect(deliveryUnknownFailure("unknown:s#1", "exit 1", "hi")).toEqual({
      kind: "error", key: "unknown:s#1", retry: false, deliveryUnknown: true, message: "这条消息可能已经被执行，没有自动重发，需要人决定要不要重发（exit 1）。消息原文：\nhi",
    });
    const long = `${"前".repeat(5_000)}<channel>真正的消息</channel>`;
    const m = deliveryUnknownFailure("k", "c", long).message;
    expect(m).toContain(`前面截掉了 ${long.length - 4_000} 字`);
    expect(m.endsWith("<channel>真正的消息</channel>")).toBe(true);
  });
});
