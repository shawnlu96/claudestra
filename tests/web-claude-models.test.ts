/**
 * 模型目录的前端加载：一次失败不能把切换器永远卡在「加载中…」（2026-09-23 新用户报）。
 * 失败要带原因、不缓存（下次调用重拉）；成功才缓存，之后不再发请求。
 */
import { afterAll, expect, test } from "bun:test";
import { loadClaudeModels } from "@/features/chat/claude-models-load";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("失败带原因且不缓存 → 重试成功后缓存", async () => {
  let calls = 0;
  const replies: Array<() => Response> = [
    () => new Response(JSON.stringify({ error: "Bridge 不可达: ECONNREFUSED" }), { status: 502 }),
    () => new Response(JSON.stringify({ data: { models: [{ id: "claude-opus-5-5", name: "Opus 5.5", section: "main" }] } })),
  ];
  globalThis.fetch = (async () => replies[calls++]()) as unknown as typeof fetch;

  const first = await loadClaudeModels();
  expect(first).toEqual({ models: [], error: "Bridge 不可达: ECONNREFUSED" });

  const second = await loadClaudeModels();
  expect(second.error).toBeNull();
  expect(second.models).toEqual([{ value: "claude-opus-5-5", label: "Opus 5.5", section: "main" }]);

  const third = await loadClaudeModels();
  expect(third.models).toHaveLength(1);
  expect(calls).toBe(2); // 成功之后不再请求
});
