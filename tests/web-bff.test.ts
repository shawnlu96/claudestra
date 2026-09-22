import { describe, expect, mock, test } from "bun:test";

// 鉴权结果由测试控制（isAuthed 真实实现要读 cookie + SQLite）；mock 必须先于 import bff
let authed = true;
mock.module("@/lib/api-auth", () => ({ isAuthed: async () => authed }));

const { authedLegacy, bridgeErrorResponse, bridgeErrorStatus, withAuth } = await import("@/lib/bff");

const req = () => new Request("http://x/api/t", { method: "POST", body: "{}" });

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

describe("authedLegacy / withAuth", () => {
  test("未登录 → 401 {error:未登录}，handler 不执行", async () => {
    authed = false;
    let ran = false;
    const h = authedLegacy(async () => {
      ran = true;
      return new Response("x");
    });
    const r = await h(req());
    expect(r.status).toBe(401);
    expect(await r.text()).toBe(JSON.stringify({ error: "未登录" }));
    expect(ran).toBe(false);
    const w = await withAuth(async () => new Response("x"))(req());
    expect(w.status).toBe(401);
    authed = true;
  });

  test("handler 抛错 → 一律 502（bridge 的 4xx 也不透传——那是 authed 的口径）", async () => {
    const err = Object.assign(new Error("回合中"), { status: 409 });
    const r = await authedLegacy(
      async () => {
        throw err;
      },
      { okFalse: true },
    )(req());
    expect(r.status).toBe(502);
    expect(await r.text()).toBe(JSON.stringify({ ok: false, error: "回合中" }));
  });

  test("handler 自己返回的响应原样回（含 400 校验）", async () => {
    const r = await authedLegacy(async () => Response.json({ error: "agent 不能为空" }, { status: 400 }))(req());
    expect(r.status).toBe(400);
    expect(await r.text()).toBe(JSON.stringify({ error: "agent 不能为空" }));
  });

  test("onError 收到原始错误（迁移前 catch 里的日志）", async () => {
    const seen: unknown[] = [];
    const err = new Error("x");
    await authedLegacy(
      async () => {
        throw err;
      },
      { onError: (e) => seen.push(e) },
    )(req());
    expect(seen).toEqual([err]);
  });

  test("withAuth 不吞错：handler 抛出原样向上（交给 Next 回 500，同迁移前）", async () => {
    const h = withAuth(async () => {
      throw new Error("db down");
    });
    await expect(h(req())).rejects.toThrow("db down");
  });

  test("路由参数透传给 handler", async () => {
    const h = authedLegacy(async (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
      Response.json({ id: (await ctx.params).id }),
    );
    const r = await h(req(), { params: Promise.resolve({ id: "a1" }) });
    expect(await r.json()).toEqual({ id: "a1" });
  });
});
