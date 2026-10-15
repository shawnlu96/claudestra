/**
 * 列表接口的条件请求（SYN-2）：正文哈希成弱 ETag，请求带的 If-None-Match 对上就回 304 不带正文。
 * 哈希的是完整 JSON 正文（每次都变的字段由调用方用 volatile 排除），内容有任何变化 ETag 就跟着变，不会把旧内容当新的。
 * 304 也带 ETag：客户端缓存按它续期；只给 200 加，错误状态码原样走 apiJson 的老路。
 */
import { createHash } from "node:crypto";

export function etagOf(text: string): string {
  return `W/"${createHash("sha1").update(text).digest("base64url")}"`;
}

/** If-None-Match 可能是逗号分隔的多个、或 *；弱比较（W/ 前缀不计） */
export function etagMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").some((t) => { const v = t.trim(); return v === "*" || v.replace(/^W\//, "") === bare; });
}

/**
 * 200 的 JSON 回包，带 ETag；If-None-Match 对上回 304。volatile：不进哈希、但照常放进 200 正文的字段（如 /asks 的 now）
 */
export function conditionalJson(ifNoneMatch: string | null | undefined, body: Record<string, unknown>, volatile: readonly string[] = []): Response {
  const stable = volatile.length ? Object.fromEntries(Object.entries(body).filter(([k]) => !volatile.includes(k))) : body;
  const etag = etagOf(JSON.stringify(stable));
  const headers = { ETag: etag, "Cache-Control": "no-cache" };
  if (etagMatches(ifNoneMatch, etag)) return new Response(null, { status: 304, headers });
  return new Response(JSON.stringify(body), { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
}
