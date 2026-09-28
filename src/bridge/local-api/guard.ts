/**
 * Chat Guard 的管理面（docs/design-chat-guard.md）：
 *   GET  /api/v1/guard/quarantine[?agent=]      待放行清单（manage）
 *   POST /api/v1/guard/quarantine/:id/release   放行（manage）→ 原信封走原路投递
 *   POST /api/v1/guard/quarantine/:id/drop      丢弃（manage）
 *   GET/PUT /api/v1/guard/settings              { mode: off|on, blockAt, configured }（PUT 要 manage）
 * 只有 manage 凭据能放行：发送方是 guest / peer 时不能放自己。
 */
import { readConfig, setChatGuard } from "../../lib/config-store.js";
import { canManage } from "../../lib/devices.js";
import { DEFAULT_THRESHOLDS } from "../../lib/chat-guard.js";
import { jevConfigured } from "../../lib/jev.js";
import type { Principal } from "../../lib/principals.js";
import { dropQuarantined, listQuarantine, releaseQuarantined } from "../chat-guard.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";

const MANAGE_MSG = "chat guard management requires a credential with manage grant";

export async function handleGuard(req: Request, path: string, principal: Principal, url: URL): Promise<Response | null> {
  if (!path.startsWith("/guard/")) return null;
  if (path === "/guard/settings" && req.method === "GET") {
    const cfg = (await readConfig()).chatGuard;
    return apiJson(200, { ok: true, mode: cfg?.mode === "off" ? "off" : "on", blockAt: cfg?.blockAt ?? DEFAULT_THRESHOLDS.blockAt, configured: await jevConfigured() });
  }
  if (!canManage(principal)) return forbidden(MANAGE_MSG);
  if (path === "/guard/settings" && req.method === "PUT") {
    const body = await readJsonBody(req);
    if (body === INVALID_JSON) return invalidJsonBody();
    const b = (body ?? {}) as { mode?: unknown; blockAt?: unknown };
    if (b.mode !== undefined && b.mode !== "off" && b.mode !== "on") return apiJson(400, { ok: false, error: 'mode must be "off" or "on"' });
    if (b.blockAt !== undefined && (typeof b.blockAt !== "number" || b.blockAt < 0.5 || b.blockAt > 1)) return apiJson(400, { ok: false, error: "blockAt must be a number in [0.5, 1]" });
    const cfg = (await setChatGuard({ ...(b.mode !== undefined ? { mode: b.mode } : {}), ...(typeof b.blockAt === "number" ? { blockAt: b.blockAt } : {}) })).chatGuard;
    return apiJson(200, { ok: true, mode: cfg?.mode === "off" ? "off" : "on", blockAt: cfg?.blockAt ?? DEFAULT_THRESHOLDS.blockAt, configured: await jevConfigured() });
  }
  if (path === "/guard/quarantine" && req.method === "GET") {
    const agent = url.searchParams.get("agent") || undefined;
    const items = listQuarantine(agent).map((i) => ({
      id: i.id, agent: i.agent, from: i.subject.sender.name, trust: i.subject.sender.trust, text: i.subject.text, at: i.at, hits: i.decision.hits, sourceKind: i.env.from.kind,
    }));
    return apiJson(200, { ok: true, items });
  }
  const m = path.match(/^\/guard\/quarantine\/([^/]+)\/(release|drop)$/);
  if (m && req.method === "POST") {
    const id = decodeURIComponent(m[1]);
    const by = principal.name || principal.id;
    const r = m[2] === "release" ? await releaseQuarantined(id, by) : dropQuarantined(id, by);
    return apiJson(r.ok ? 200 : 409, { ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  }
  return apiJson(404, { ok: false, error: "unknown guard endpoint" });
}
