import { describe, expect, test } from "bun:test";
import { bridgeErrorStatus, bridgeErrorResponse } from "@/lib/bff";

function berr(status?: number, retryable = false, body?: Record<string, unknown>) {
  const e = new Error("x") as Error & { status?: number; retryable?: boolean; body?: Record<string, unknown> };
  e.status = status;
  e.retryable = retryable;
  e.body = body;
  return e;
}

describe("bridgeErrorStatus（BFF 错误映射口径）", () => {
  test("bridge 的 4xx 原样透传", () => {
    expect(bridgeErrorStatus(berr(404))).toBe(404);
    expect(bridgeErrorStatus(berr(409))).toBe(409);
    expect(bridgeErrorStatus(berr(400))).toBe(400);
  });
  test("bridge 401/403 绝不透传（前端遇 401 跳登录页，那是 BFF token 的问题）", () => {
    expect(bridgeErrorStatus(berr(401))).toBe(502);
    expect(bridgeErrorStatus(berr(403))).toBe(502);
  });
  test("retryable / 503 → 503；网络错误、5xx → 502", () => {
    expect(bridgeErrorStatus(berr(500, true))).toBe(503);
    expect(bridgeErrorStatus(berr(503))).toBe(503);
    expect(bridgeErrorStatus(berr(500))).toBe(502);
    expect(bridgeErrorStatus(new Error("fetch failed"))).toBe(502);
    expect(bridgeErrorStatus("weird")).toBe(502);
  });
});

describe("bridgeErrorResponse", () => {
  test("409 带上 bridge 的字段（restart-all 进行中那一轮的 runId）", async () => {
    const r = bridgeErrorResponse(berr(409, false, { ok: false, error: "x", runId: "123" }));
    expect(r.status).toBe(409);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.runId).toBe("123");
    expect(j.ok).toBe(false);
  });
  test("401 映射成 502 时不带 bridge body", async () => {
    const r = bridgeErrorResponse(berr(401, false, { secret: "token-layer" }), "代理失败: ");
    expect(r.status).toBe(502);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.secret).toBeUndefined();
    expect(j.error).toBe("代理失败: x");
    expect(j.upstream).toBe(401);
  });
});
