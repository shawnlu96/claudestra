/**
 * SYN-2：web/lib/etag-cache.ts——第二次起带上次的 ETag，回 304 交还上次的正文；正文变了换新的；
 * 老 bridge 不给 ETag 就不带条件头；错误照旧抛 ApiError。fetch 换成假的，配置钉成 direct。
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { directFallback, setAppConfigForTest } from "@/lib/app-config";
import { ApiError } from "@/lib/api/client";
import { apiCached, clearEtagCacheForTest } from "@/lib/etag-cache";

const realFetch = globalThis.fetch;
let sent: (string | null)[] = [];
let reply: (inm: string | null) => Response = () => new Response("{}");
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  const inm = (init?.headers as Record<string, string> | undefined)?.["If-None-Match"] ?? null;
  sent.push(inm);
  return reply(inm);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  setAppConfigForTest(null);
});
beforeEach(() => {
  setAppConfigForTest(directFallback());
  clearEtagCacheForTest();
  sent = [];
});

const json = (body: unknown, etag?: string, status = 200) => new Response(JSON.stringify(body), { status, headers: etag ? { ETag: etag } : {} });

test("首拉不带条件头；之后带上次的 ETag，304 交还同一份正文；正文变了换新 ETag", async () => {
  let version = 1;
  reply = (inm) => (inm === `W/"v${version}"` ? new Response(null, { status: 304 }) : json({ ok: true, v: version }, `W/"v${version}"`));
  const a = await apiCached<{ ok: boolean; v: number }>("/agents");
  const b = await apiCached<{ ok: boolean; v: number }>("/agents");
  expect(a).toEqual({ ok: true, v: 1 });
  expect(b).toBe(a);
  version = 2;
  const c = await apiCached<{ ok: boolean; v: number }>("/agents");
  expect(c).toEqual({ ok: true, v: 2 });
  expect(sent).toEqual([null, 'W/"v1"', 'W/"v1"']);
  await apiCached("/agents");
  expect(sent[3]).toBe('W/"v2"');
});

test("路径分开记：/asks 和 /asks?history=1 各是各的", async () => {
  reply = () => json({ ok: true }, 'W/"x"');
  await apiCached("/asks");
  await apiCached("/asks?history=1");
  expect(sent).toEqual([null, null]);
});

test("没有 ETag（老 bridge）不带条件头；错误状态码照旧抛 ApiError、不进缓存", async () => {
  reply = () => json({ ok: true });
  await apiCached("/projects");
  await apiCached("/projects");
  expect(sent).toEqual([null, null]);
  reply = () => json({ ok: false, error: "boom" }, undefined, 503);
  const err = await apiCached("/projects").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(503);
});
