/**
 * GET /api/v1/usage/{task,feature,agent}/:id：卡 / feature 的归属汇总，以及 agent 的今日、近 7 天汇总和逐轮明细。
 * 只给全权设备：canAdministerPairing = 全 scope、非 peer、manage、且是设备凭据，与 /ai-inventory 同一道门（老的全 scope Bearer 不放）。
 * 只读现有数据：bridge 每 10 分钟那趟 `usage ingest` 导入时已按台账重算过归属，这里不导入、不重算、不开写连接。
 * feature 只认 id（feature id 或事项 id）；按名字找在 CLI（usage by-feature）。见 tests/usage-attr-api.test.ts。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { canAdministerPairing } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { agentUsage, parseAgentUsageOptions, type AgentUsageOptions } from "../../lib/usage-agent.js";
import { usageByFeature, usageByTask } from "../../lib/usage-query.js";
import { USAGE_DB_PATH } from "../../lib/usage-store.js";
import { apiJson, forbidden } from "../api-respond.js";

const ROUTE = /^\/usage\/(task|feature|agent)\/([^/]+)$/;
let dbPath = USAGE_DB_PATH;

/** 单测注入；生产不调 */
export function setUsageDbPathForTest(p: string | null): void {
  dbPath = p ?? USAGE_DB_PATH;
}

function query(kind: string, id: string, options: AgentUsageOptions) {
  if (!existsSync(dbPath)) return kind === "agent" ? agentUsage(null, id, options) : [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (kind === "agent") return db.transaction(() => agentUsage(db, id, options))();
    return kind === "task" ? usageByTask(db, id) : usageByFeature(db, [id]);
  } finally {
    db.close();
  }
}

export function handleUsageApi(req: Request, path: string, principal: Principal): Response | null {
  const m = ROUTE.exec(path);
  if (!m) return null;
  if (!canAdministerPairing(principal)) return forbidden("token usage requires a full-scope owner device credential");
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  let id: string;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return apiJson(400, { ok: false, error: "bad id" }); // 坏的百分号编码：这是调用方的错，回 400 就够，不用记日志
  }
  if (!id || id.length > 200 || /[\p{Cc}]/u.test(id)) return apiJson(400, { ok: false, error: "bad id" });
  const options = parseAgentUsageOptions(new URL(req.url));
  if (m[1] === "agent" && !options) return apiJson(400, { ok: false, error: "bad usage query" });
  try {
    const rows = query(m[1], id, options ?? { since: 0, limit: 20 });
    if (m[1] === "agent") return apiJson(200, { ok: true, ...rows });
    return apiJson(200, { ok: true, [m[1]]: id, rows });
  } catch (e) {
    // 库还没迁到带归属列的版本（部署后第一趟导入之前）或正被别的进程锁着：回 503，下一趟导入之后再取
    console.error("[usage-api] 查询失败:", (e as Error).message);
    return apiJson(503, { ok: false, error: "token usage unavailable" });
  }
}
