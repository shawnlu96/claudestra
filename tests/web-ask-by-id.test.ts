/** 引用条按 id 取 ask 的缓存（web/features/asks/ask-by-id.ts）：取到的、404 的记住；网络失败、5xx 不记，下次再取 */
import { expect, test } from "bun:test";
import { askByIdCache } from "@/features/asks/ask-by-id";
import { ApiError } from "@/lib/api/client";
import type { WebAsk } from "@/features/asks/asks-model";

test("取到的和 404 只取一次；断网、503 不记，下次挂载再取", async () => {
  const calls: string[] = [];
  const outcome: Record<string, () => Promise<{ ask: WebAsk }>> = {
    ok: async () => ({ ask: { id: "ok", title: "发吗" } as WebAsk }),
    gone: async () => Promise.reject(new ApiError("not found", 404, {})),
    flaky: async () => Promise.reject(new TypeError("Failed to fetch")),
    down: async () => Promise.reject(new ApiError("unavailable", 503, {})),
  };
  const get = askByIdCache((id) => (calls.push(id), outcome[id]()));
  for (let i = 0; i < 2; i++) for (const id of Object.keys(outcome)) await get(id);
  expect(calls).toEqual(["ok", "gone", "flaky", "down", "flaky", "down"]);
  expect((await get("ok"))?.title).toBe("发吗");
  expect(await get("gone")).toBeNull();
  outcome.flaky = async () => ({ ask: { id: "flaky", title: "恢复了" } as WebAsk });
  expect((await get("flaky"))?.title).toBe("恢复了");
});
