import { describe, expect, test } from "bun:test";
// 纯模块（不带 next/server / api-auth）：authedLegacy / withAuth 包装的测试在 web-bff.test.ts
import { legacyErrorBody } from "@/lib/bff-legacy-body";

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
