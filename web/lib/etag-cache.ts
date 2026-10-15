/**
 * 列表接口的条件请求（SYN-2，bridge 侧 src/lib/etag.ts）：api client 用 cache: "no-store"，浏览器不会自己带 If-None-Match，
 * 这里按「机器 fp + 路径」记上次的 ETag 和正文，下次带上；回 304 就交还上次的正文（同一个对象，调用方的 diff 照常比）。
 * 只记 200 + 带 ETag 的；老 bridge 不给 ETag 就每次 200，行为和以前一样。只放内存：刷新页面后第一次照常整份拉。
 */
import { apiErrorFrom, apiRaw, parseBody, type ApiInit } from "./api/client";
import { machines } from "./machines";

const cache = new Map<string, { etag: string; body: unknown }>();
const MAX_ENTRIES = 32;

export async function apiCached<T>(path: string, init: ApiInit = {}): Promise<T> {
  const fp = machines.currentFp() ?? "";
  const key = `${fp}\n${path}`;
  const hit = cache.get(key);
  const res = await apiRaw(path, { ...init, headers: { ...(init.headers ?? {}), ...(hit ? { "If-None-Match": hit.etag } : {}) } });
  if (res.status === 304 && hit) return hit.body as T;
  const body = await parseBody(res, "GET");
  if (!res.ok) throw apiErrorFrom(res.status, body, fp);
  const etag = res.headers.get("etag");
  if (!etag) cache.delete(key);
  else {
    if (cache.size >= MAX_ENTRIES && !cache.has(key)) cache.delete(cache.keys().next().value!);
    cache.set(key, { etag, body });
  }
  return body as T;
}

/** 单测：清空 */
export function clearEtagCacheForTest(): void {
  cache.clear();
}
