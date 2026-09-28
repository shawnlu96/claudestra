/**
 * 订阅额度请求（lib/quota-providers.ts）：固定地址、只 GET、拒绝重定向、响应体上限、每种失败的固定错误码。
 * 全部假 fetch，不发真实请求。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readClaudeCredential, readCodexCredential, type QuotaCredential } from "../src/lib/quota-credentials.js";
import { getQuota, parseRetryAfter, QUOTA_BODY_CAP, QUOTA_ENDPOINTS, readCappedBody, type QuotaEndpoint } from "../src/lib/quota-providers.js";
import { T0, claudeUsageBody, expectNoSentinel, fakeCredDeps, fakeFetch, jsonResponse, okRoutes } from "./quota-fixtures.js";

async function creds(): Promise<{ claude: QuotaCredential; codex: QuotaCredential }> {
  const d = fakeCredDeps();
  const a = await readClaudeCredential(d);
  const b = await readCodexCredential(d);
  if (!a.ok || !b.ok) throw new Error("fixture");
  return { claude: a.cred, codex: b.cred };
}

const deps = (f: ReturnType<typeof fakeFetch>, timeoutMs?: number) => ({ fetch: f, now: () => T0, timeoutMs, hashCreditId: (id: string) => `k${id.length}` });

describe("请求形状", () => {
  test("三个端点：地址固定、method GET、redirect manual、各自的鉴权头", async () => {
    const c = await creds();
    const f = fakeFetch(okRoutes);
    const plan: [QuotaEndpoint, QuotaCredential][] = [["claude_usage", c.claude], ["codex_usage", c.codex], ["codex_reset_credits", c.codex]];
    for (const [e, cred] of plan) expect((await getQuota(e, cred, deps(f))).ok).toBe(true);
    expect(f.calls.map((x) => [x.url, x.method, x.redirect])).toEqual([
      ["https://api.anthropic.com/api/oauth/usage", "GET", "manual"],
      ["https://chatgpt.com/backend-api/wham/usage", "GET", "manual"],
      ["https://chatgpt.com/backend-api/wham/rate-limit-reset-credits", "GET", "manual"],
    ]);
    expect(f.calls[0].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(f.calls[1].headers["ChatGPT-Account-Id"]).toBeDefined();
  });

  test("凭据与端点不同家 → 直接抛（编程错误），不发请求", async () => {
    const c = await creds();
    const f = fakeFetch(okRoutes);
    await expect(getQuota("codex_usage", c.claude, deps(f))).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  test("端点表逐条冻结：运行时改地址直接抛", () => {
    expect(() => {
      (QUOTA_ENDPOINTS.claude_usage as { url: string }).url = "https://evil.example/";
    }).toThrow(TypeError);
    expect(QUOTA_ENDPOINTS.claude_usage.url).toBe("https://api.anthropic.com/api/oauth/usage");
  });

  test("源码里没有兑换 / 购买接口，也没有非 GET 的 method", () => {
    const src = readFileSync(join(import.meta.dir, "../src/lib/quota-providers.ts"), "utf8");
    expect(src).not.toMatch(/consume|purchase/i);
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });
});

describe("失败分类（只给固定错误码）", () => {
  const cases: [string, () => Response | Promise<Response>, string][] = [
    ["3xx", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }), "redirect"],
    ["401", () => jsonResponse(401, { type: "authentication_error", message: "OAuth access token has been revoked." }), "http_401"],
    ["401 另一种文案", () => jsonResponse(401, { message: "Invalid bearer token" }), "http_401"],
    ["403", () => jsonResponse(403, "<html>forbidden</html>"), "http_403"],
    ["404", () => jsonResponse(404, {}), "http_404"],
    ["418", () => jsonResponse(418, {}), "http_4xx"],
    ["503", () => jsonResponse(503, {}), "http_5xx"],
    ["坏 JSON", () => new Response("<html>login</html>", { status: 200 }), "bad_json"],
    ["形状不对", () => jsonResponse(200, { hello: "world" }), "bad_shape"],
    ["网络错误", () => { throw new TypeError("fetch failed: secret-in-message"); }, "network"],
  ];
  test.each(cases)("%s", async (_n, respond, code) => {
    const c = await creds();
    const out = await getQuota("claude_usage", c.claude, deps(fakeFetch(respond)));
    expect(out).toEqual({ ok: false, code } as never);
  });

  test("429：Retry-After 秒数与 HTTP-date，钳在 [60s, 6h]", async () => {
    const c = await creds();
    const secs = await getQuota("codex_usage", c.codex, deps(fakeFetch(() => jsonResponse(429, {}, { "retry-after": "120" }))));
    expect(secs).toEqual({ ok: false, code: "http_429", retryAfterMs: 120_000 });
    const date = new Date(T0 + 600_000).toUTCString();
    const byDate = await getQuota("codex_usage", c.codex, deps(fakeFetch(() => jsonResponse(429, {}, { "retry-after": date }))));
    expect(byDate).toEqual({ ok: false, code: "http_429", retryAfterMs: 600_000 });
    expect(await getQuota("codex_usage", c.codex, deps(fakeFetch(() => jsonResponse(429, {}))))).toEqual({ ok: false, code: "http_429" });
    expect(parseRetryAfter("1", T0)).toBe(60_000);
    expect(parseRetryAfter("999999", T0)).toBe(6 * 3600_000);
    expect(parseRetryAfter("soon", T0)).toBeNull();
  });

  test("超时：fetch 挂住 → timeout", async () => {
    const c = await creds();
    const hang = fakeFetch((_u, signal) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))));
    expect(await getQuota("claude_usage", c.claude, deps(hang, 30))).toEqual({ ok: false, code: "timeout" });
  });

  test("响应体超过 256 KiB → too_large，流被中途取消（不读完）", async () => {
    const c = await creds();
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled++;
        ctrl.enqueue(new Uint8Array(64 * 1024).fill(32));
        if (pulled > 100) ctrl.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const out = await getQuota("claude_usage", c.claude, deps(fakeFetch(() => new Response(stream, { status: 200 }))));
    expect(out).toEqual({ ok: false, code: "too_large" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });

  test("刚好在上限内照常解析", async () => {
    const body = JSON.stringify(claudeUsageBody());
    const r = await readCappedBody(new Response(body), body.length);
    expect(r).toEqual({ ok: true, text: body });
    expect(QUOTA_BODY_CAP).toBe(262144);
  });

  test("结果里没有响应体、异常原文或 PII", async () => {
    const c = await creds();
    const outs = await Promise.all([
      getQuota("claude_usage", c.claude, deps(fakeFetch(() => jsonResponse(401, { email: "leak@example.com" })))),
      getQuota("claude_usage", c.claude, deps(fakeFetch(() => { throw new Error("leak@example.com"); }))),
      getQuota("codex_usage", c.codex, deps(fakeFetch(okRoutes))),
    ]);
    expectNoSentinel(JSON.stringify(outs));
  });
});
