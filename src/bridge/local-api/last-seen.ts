/**
 * 协作视图「上次以来」（T12c）：
 *   GET /api/v1/me/last-seen/:project   → { ok, lastSeen: ms | null, now }
 *   PUT /api/v1/me/last-seen/:project   → 记为「现在看过」，{ ok, lastSeen, now }；不收 body，时刻用服务端的 now
 * 门与台账同一道（canReadLedger）：这个时刻只拿来切台账事件，读不了台账的凭据要它没用。project 必须在 projects.json。
 * 按 principal.id 记（lib/last-seen.ts），scope 为 collab:<project>。
 */
import { canReadLedger } from "../../lib/devices.js";
import { getLastSeen, markSeen } from "../../lib/last-seen.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";
import { webDb } from "./db.js";
import { ledgerProjectExists } from "./ledger.js";

const RE = /^\/me\/last-seen\/([^/]+)$/;

export async function handleLastSeen(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path.match(RE);
  if (!m) return null;
  if (req.method !== "GET" && req.method !== "PUT") return apiJson(405, { ok: false, error: "method not allowed" });
  if (!canReadLedger(principal)) return forbidden("last-seen requires a full-scope owner credential");
  let project: string;
  try {
    project = decodeURIComponent(m[1]);
  } catch {
    // 非法百分号编码是请求方的错
    return apiJson(400, { ok: false, error: "bad path encoding" });
  }
  if (!(await ledgerProjectExists(project))) return apiJson(404, { ok: false, error: `project "${project}" not found` });
  const scope = `collab:${project}`;
  const now = Date.now();
  const lastSeen = req.method === "PUT" ? markSeen(webDb(), principal.id, scope, now) : getLastSeen(webDb(), principal.id, scope);
  return apiJson(200, { ok: true, lastSeen, now });
}
