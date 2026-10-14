/**
 * SYN-1 验收 3：整页拉取只有 404（会话不存在 / 轮转中途还没落盘）才退到更早的会话；超时、5xx 照抛——
 * 退下去会把错的会话当成当前会话显示（10-13 现场：超时后退到旧会话，还多下 135KB）。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { setAppConfigForTest } from "../web/lib/app-config";

// 根 tsc 不开 jsx，连 import type 都会牵进 lib/i18n.tsx；按运行时路径导入，只声明用到的公开面
interface HistoryPage { data: { content: string }[]; sessionId?: string; lastSeq?: number | null; hasMore?: boolean }
const spec = "@/lib/api/history";
const { fetchHistory, FULL_PAGE } = (await import(spec)) as { fetchHistory(agent: string): Promise<HistoryPage>; FULL_PAGE: number };

const realFetch = globalThis.fetch;
const calls: string[] = [];
let newest: () => Promise<Response>;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

beforeAll(() => {
  setAppConfigForTest({ mode: "direct", fp: "local", machineName: "t", version: "" });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost/");
    calls.push(url.pathname + url.search);
    if (url.pathname === "/api/v1/agents/a/history") return json({ sessions: [{ sessionId: "s2" }, { sessionId: "s1" }] });
    if (url.pathname === "/api/v1/agents/a/history/s2") return newest();
    if (url.pathname === "/api/v1/agents/a/history/s1") return json({ messages: [{ seq: 1, role: "user", text: "old session" }] });
    if (url.pathname === "/api/v1/agents/a/hidden") return json({ ranges: [] });
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
});
afterAll(() => void (globalThis.fetch = realFetch));
beforeEach(() => void (calls.length = 0));

const olderTried = () => calls.some((c) => c.startsWith("/api/v1/agents/a/history/s1"));

test("最新会话 404 → 退到更早的会话", async () => {
  newest = async () => json({ error: "not found" }, 404);
  const page = await fetchHistory("a");
  expect(page.sessionId).toBe("s1");
  expect(page.data.map((m) => m.content)).toEqual(["old session"]);
});

test("5xx 不退，原样抛给调用方重试", async () => {
  newest = async () => json({ error: "upstream" }, 502);
  await expect(fetchHistory("a")).rejects.toMatchObject({ status: 502 });
  expect(olderTried()).toBe(false);
});

test("超时不退", async () => {
  newest = () => Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
  await expect(fetchHistory("a")).rejects.toBeDefined();
  expect(olderTried()).toBe(false);
});

test("整页按 FULL_PAGE 取；拿满一页 = 还有更早", async () => {
  newest = async () => json({ messages: Array.from({ length: FULL_PAGE }, (_, i) => ({ seq: i + 1, role: "user", text: `m${i}` })) });
  const page = await fetchHistory("a");
  expect(calls).toContain(`/api/v1/agents/a/history/s2?limit=${FULL_PAGE}`);
  expect(page.hasMore).toBe(true);
  expect(page.lastSeq).toBe(FULL_PAGE);
});
