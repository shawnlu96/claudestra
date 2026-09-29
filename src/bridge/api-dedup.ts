/**
 * POST /api/v1/agents/:name/messages 的投递幂等（T48 P2-1）：请求体带 `dedup`（发送方的稳定标识，统一派单是「派单编号 + 轮次」）时，
 * 同一个发送方的同一个标识只投一次，重发直接回第一次的 threadId，不再唤醒、不再建 thread（lib/delivery-dedup.ts）。
 * 包在 serveApiRequest 外面，不动路由本体：发送方按 Bearer 的哈希区分（peer / API token 各算各的），没带 Bearer（设备 cookie）不管。
 * 命中发生在鉴权之前：只有持同一个 Bearer 的人能命中，拿到的只是他自己第一次拿到的 threadId，不会投递任何东西。
 */
import { createHash } from "node:crypto";
import { dedupKeyOf, noteDelivery, seenDelivery } from "../lib/delivery-dedup.js";
import { apiJson } from "./api-respond.js";

const MESSAGES_PATH = /^\/api\/v1\/agents\/[^/]+\/messages$/;

export async function withDeliveryDedup(req: Request, url: URL, handle: () => Promise<Response>): Promise<Response> {
  if (req.method !== "POST" || !MESSAGES_PATH.test(url.pathname) || !(req.headers.get("content-type") ?? "").includes("application/json")) return handle();
  const bearer = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!bearer) return handle();
  let key: string | null;
  try {
    key = dedupKeyOf(((await req.clone().json()) as { dedup?: unknown } | null)?.dedup);
  } catch {
    return handle(); // 不是合法 JSON：交给路由本体按原样报 400，这里不重复判
  }
  if (!key) return handle();
  const sender = `b:${createHash("sha256").update(bearer).digest("hex").slice(0, 24)}:${url.pathname}`;
  const seen = seenDelivery(sender, key);
  if (seen) return apiJson(202, { ok: true, accepted: true, duplicate: true, threadId: seen });
  const res = await handle();
  if (res.ok) {
    const j = (await res.clone().json().catch(() => null)) as { threadId?: unknown } | null; // 读不出 threadId：不记，重发会再投一次
    if (typeof j?.threadId === "string") noteDelivery(sender, key, j.threadId);
  }
  return res;
}
