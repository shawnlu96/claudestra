import { describe, expect, mock, test } from "bun:test";

// 鉴权结果由测试控制（isAuthed 真实实现要读 cookie + SQLite）
let authed = true;
mock.module("@/lib/api-auth", () => ({ isAuthed: async () => authed }));

const { authedLegacy, legacyErrorBody, withAuth } = await import("@/lib/bff");

const req = () => new Request("http://x/api/t", { method: "POST", body: "{}" });

/**
 * D8-10 第二批：只去样板，不改对外响应。这里把迁移前每种 catch 写法的 body 逐字节钉住——
 * 期望值就是迁移前的原表达式，JSON.stringify 比较（键序也算）。
 */
describe("legacyErrorBody（迁移前各路由 catch 的 body 形状）", () => {
  const e = new Error("boom");
  test("{ error: message }", async () => {
    expect(JSON.stringify(await legacyErrorBody(e))).toBe(JSON.stringify({ error: e.message }));
  });
  test("{ ok: false, error: message }（键序 ok 在前）", async () => {
    expect(JSON.stringify(await legacyErrorBody(e, { okFalse: true }))).toBe(
      JSON.stringify({ ok: false, error: e.message }),
    );
  });
  test("固定前缀：{ ok: false, error: `打断失败: ${message}` }", async () => {
    expect(JSON.stringify(await legacyErrorBody(e, { okFalse: true, errorPrefix: "打断失败: " }))).toBe(
      JSON.stringify({ ok: false, error: `打断失败: ${e.message}` }),
    );
  });
  test("异步前缀（按语言取文案）", async () => {
    const st = async () => "Bridge 不可达";
    expect(JSON.stringify(await legacyErrorBody(e, { errorPrefix: async () => `${await st()}: ` }))).toBe(
      JSON.stringify({ error: `${await st()}: ${e.message}` }),
    );
  });
  test("抛的不是 Error：无前缀时 error 键被 JSON 省掉，同迁移前", async () => {
    const weird = { nope: 1 };
    expect(JSON.stringify(await legacyErrorBody(weird))).toBe(
      JSON.stringify({ error: (weird as unknown as Error).message }),
    );
    expect(JSON.stringify(await legacyErrorBody(weird, { okFalse: true, errorPrefix: "p: " }))).toBe(
      JSON.stringify({ ok: false, error: `p: ${(weird as unknown as Error).message}` }),
    );
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
