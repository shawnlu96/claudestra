/**
 * 模型目录的前端加载：一次失败不能把切换器永远卡在「加载中…」（2026-09-23 新用户报）。
 * 失败要带原因、不缓存（下次调用重拉）；成功才缓存，之后不再发请求。
 * 现在直接打 bridge（GET /api/v1/claude-models → {ok, models}）；入口配置钉成 direct，免得 /app-config.json 的拉取吃掉 mock 的回复。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { loadClaudeModels } from "@/features/chat/claude-models-load";
import { setAppConfigForTest } from "@/lib/app-config";

const realFetch = globalThis.fetch;
beforeAll(() => setAppConfigForTest({ mode: "direct", fp: "local", machineName: "test", version: "" }));
afterAll(() => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
});

test("失败带原因且不缓存 → 重试成功后缓存", async () => {
  let calls = 0;
  const urls: string[] = [];
  const replies: Array<() => Response> = [
    () => new Response(JSON.stringify({ ok: false, error: "Bridge 不可达: ECONNREFUSED" }), { status: 502 }),
    () => new Response(JSON.stringify({ ok: true, models: [{ id: "claude-opus-5-5", name: "Opus 5.5", section: "main" }] })),
  ];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return replies[calls++]();
  }) as unknown as typeof fetch;

  const first = await loadClaudeModels();
  expect(first).toEqual({ models: [], error: "Bridge 不可达: ECONNREFUSED" });

  const second = await loadClaudeModels();
  expect(second.error).toBeNull();
  expect(second.models).toEqual([{ value: "claude-opus-5-5", label: "Opus 5.5", section: "main" }]);

  const third = await loadClaudeModels();
  expect(third.models).toHaveLength(1);
  expect(calls).toBe(2); // 成功之后不再请求
  expect(urls[0]).toBe("/api/v1/claude-models"); // 直托管：同源根 + /api/v1
});
