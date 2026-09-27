/**
 * 中继网页切到本机直连时带走浏览器本地的偏好（web/features/machines/local-hop.ts）：两个网址的 localStorage 互不相通。
 *   POST /api/v1/handoff {entries: {key: value}} → {id}      中继页面在跳转前存一份
 *   GET  /api/v1/handoff/:id                    → {entries}  本机页面配对后取一次（取完即删）
 * 放 bridge 而不是塞进跳转链接：链接里的数据谁都能伪造（一条恶意链接就能往本机页面写偏好），这里只有已配对的同一个身份才存得进、取得出。
 * 纯内存、2 分钟过期、一次性；只收 cstra_ 开头的键（前端的键名空间），本机页面写入时还会再按白名单过一遍。
 */
import { tokenIdOf, type Principal } from "../../lib/principals.js";
import { apiJson, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";

const TTL_MS = 2 * 60_000;
const MAX_PENDING = 32;
const MAX_BYTES = 256 * 1024;
const KEY_RE = /^cstra_[\w.:-]{1,120}$/;

interface Pending {
  owner: string;
  entries: Record<string, string>;
  expiresAt: number;
}
const pending = new Map<string, Pending>();

function sweep(now: number): void {
  for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id);
}

/** 只留 cstra_ 键、字符串值；总量超限 → null */
export function cleanEntries(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  let bytes = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_RE.test(k) || typeof v !== "string") continue;
    bytes += k.length + v.length;
    if (bytes > MAX_BYTES) return null;
    out[k] = v;
  }
  return out;
}

export async function handleHandoff(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path === "/handoff" && req.method === "POST") return create(req, principal);
  const m = path.match(/^\/handoff\/([A-Za-z0-9_-]{16,64})$/);
  if (m && req.method === "GET") return take(m[1], principal);
  return null;
}

async function create(req: Request, principal: Principal): Promise<Response> {
  if (principal.peer) return apiJson(403, { ok: false, error: "peer tokens cannot hand off browser state" });
  const raw = await readJsonBody(req);
  if (raw === INVALID_JSON) return invalidJsonBody();
  const entries = cleanEntries((raw as { entries?: unknown } | null)?.entries);
  if (!entries) return apiJson(400, { ok: false, error: `"entries" must be an object of cstra_* strings, ≤ ${MAX_BYTES} bytes` });
  const now = Date.now();
  sweep(now);
  if (pending.size >= MAX_PENDING) return apiJson(429, { ok: false, error: "too many pending handoffs" });
  const id = crypto.randomUUID().replace(/-/g, "");
  pending.set(id, { owner: tokenIdOf(principal), entries, expiresAt: now + TTL_MS });
  return apiJson(200, { ok: true, id, expiresAt: new Date(now + TTL_MS).toISOString() });
}

function take(id: string, principal: Principal): Response {
  sweep(Date.now());
  const p = pending.get(id);
  // 别人的交接当不存在：不告诉调用方这个 id 是否有效
  if (!p || p.owner !== tokenIdOf(principal)) return apiJson(404, { ok: false, error: "handoff not found or expired" });
  pending.delete(id);
  return apiJson(200, { ok: true, entries: p.entries });
}
