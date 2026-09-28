/**
 * 协作视图「上次以来」（T12c）：
 *   GET /api/v1/me/last-seen/:project[?events=1[&since=<ms>]]
 *       → { ok, lastSeen: ms | null, now [, events, truncated] }
 *       events = 基准之后、now 之前的任务事件（lib/ledger-since.ts）；基准是 since（同一标签页刷新前的那份），缺省用 lastSeen。
 *       一个请求拿齐，网页不必为了摘要再拉一次整份总览。
 *   PUT /api/v1/me/last-seen/:project   → 记为「现在看过」，{ ok, lastSeen, now }；不收 body，时刻用服务端的 now
 * 门与台账同一道（canReadLedger）：这个时刻只拿来切台账事件，读不了台账的凭据要它没用。project 必须在 projects.json。
 * 按 principal.id 记（lib/last-seen.ts），scope 为 collab:<project>。
 */
import { canReadLedger } from "../../lib/devices.js";
import { getLastSeen, markSeen } from "../../lib/last-seen.js";
import { sinceEvents } from "../../lib/ledger-since.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";
import { ledgerDb } from "../ledger-feed.js";
import { webDb } from "./db.js";
import { ledgerProjectExists } from "./ledger.js";

const RE = /^\/me\/last-seen\/([^/]+)$/;

/** ?since= 只认非负的有限毫秒数；缺省或写坏 = 用服务端记的 lastSeen */
function sinceParam(url: URL | undefined): number | null {
  const raw = url?.searchParams.get("since");
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function eventsSince(project: string, base: number | null, now: number): { events: unknown[]; truncated: boolean } | Response {
  if (base === null) return { events: [], truncated: false };
  let db: ReturnType<typeof ledgerDb>;
  try {
    db = ledgerDb();
  } catch (e) {
    return apiJson(503, { ok: false, error: `ledger unavailable: ${(e as Error).message}` });
  }
  return db ? sinceEvents(db, project, base, now) : { events: [], truncated: false };
}

export async function handleLastSeen(req: Request, path: string, principal: Principal, url?: URL): Promise<Response | null> {
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
  if (req.method === "PUT") return apiJson(200, { ok: true, lastSeen: markSeen(webDb(), principal.id, scope, now), now });
  const lastSeen = getLastSeen(webDb(), principal.id, scope);
  if (url?.searchParams.get("events") !== "1") return apiJson(200, { ok: true, lastSeen, now });
  const got = eventsSince(project, sinceParam(url) ?? lastSeen, now);
  return got instanceof Response ? got : apiJson(200, { ok: true, lastSeen, now, ...got });
}
