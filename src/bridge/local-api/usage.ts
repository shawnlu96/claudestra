/**
 * GET /api/v1/usage/{task,feature,agent}/:id：卡 / feature 的归属汇总，以及 agent 的今日、近 7 天汇总和逐轮明细。
 * 只给全权设备：canAdministerPairing = 全 scope、非 peer、manage、且是设备凭据，与 /ai-inventory 同一道门（老的全 scope Bearer 不放）。
 * 只读现有数据：bridge 每 10 分钟那趟 `usage ingest` 导入时已按台账重算过归属，这里不导入、不重算、不开写连接。
 * feature 只认 id（feature id 或事项 id）；按名字找在 CLI（usage by-feature）。见 tests/usage-attr-api.test.ts。
 * 卡另给 summary（usage-task-summary.ts）：按家族合计（归档 + 明细）、出借单数（读台账，对方未回传用量）、估算占本周额度（读本周额度，缺就不给）。
 */
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { canAdministerPairing } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { agentUsage, parseAgentUsageOptions, type AgentUsageOptions } from "../../lib/usage-agent.js";
import { LEDGER_PATH } from "../../lib/ledger-store.js";
import { readWeekQuota, type QuotaReport } from "../../lib/quota-week.js";
import { openLedgerReadonly } from "../../lib/usage-attr.js";
import { lendOrderCounts, taskUsageFacts, usageByFeature, usageByTask } from "../../lib/usage-query.js";
import { USAGE_DB_PATH } from "../../lib/usage-store.js";
import { summarizeTaskUsage, weekStartsOf, type TaskUsageSummary } from "../../lib/usage-task-summary.js";
import { lendReportedUsage, type LendReported } from "../../lib/lend-usage-report.js";
import { apiJson, forbidden } from "../api-respond.js";

const ROUTE = /^\/usage\/(task|feature|agent)\/([^/]+)$/;
let dbPath = USAGE_DB_PATH;
let ledgerPath = LEDGER_PATH;
let readQuota: () => Promise<QuotaReport> = () => readWeekQuota();

/** 单测注入；生产不调 */
export function setUsageDbPathForTest(p: string | null): void {
  dbPath = p ?? USAGE_DB_PATH;
}

/** 单测注入台账路径与本周额度；生产不调 */
export function setUsageSummaryDepsForTest(deps: { ledger?: string; quota?: () => Promise<QuotaReport> } | null): void {
  ledgerPath = deps?.ledger ?? LEDGER_PATH;
  readQuota = deps?.quota ?? (() => readWeekQuota());
}

/** 出借单在台账里；没有台账（新装、沙箱）= 没有出借单 */
function lendCounts(taskId: string): { counts: Record<string, Record<string, number>>; reported: LendReported[] } {
  const ledger = openLedgerReadonly(ledgerPath);
  if (!ledger) return { counts: {}, reported: [] };
  try {
    return { counts: lendOrderCounts(ledger, taskId), reported: lendReportedUsage(ledger, taskId) }; // LENDUSAGE1：对方回传的用量同一连接读
  } finally {
    ledger.close();
  }
}

/** 逐行结果和汇总在同一个读事务里取：两者加总对得上，不会夹着一趟导入 */
async function taskUsage(id: string): Promise<{ rows: ReturnType<typeof usageByTask>; summary: TaskUsageSummary }> {
  const quota = await readQuota(); // readWeekQuota 自己吞错：读不到 = 空对象，估算占比就不给
  const lend = lendCounts(id);
  if (!existsSync(dbPath)) {
    return { rows: [], summary: summarizeTaskUsage({ detail: [], archive: [], sessions: {}, week: {}, detailFrom: null, unarchivedBefore: null }, lend.counts, quota, lend.reported) };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const [rows, facts] = db.transaction(() => [usageByTask(db, id), taskUsageFacts(db, id, weekStartsOf(quota))] as const)();
    return { rows, summary: summarizeTaskUsage(facts, lend.counts, quota, lend.reported) };
  } finally {
    db.close();
  }
}

function query(kind: string, id: string, options: AgentUsageOptions) {
  if (!existsSync(dbPath)) return kind === "agent" ? agentUsage(null, id, options) : [];
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (kind === "agent") return db.transaction(() => agentUsage(db, id, options))();
    return usageByFeature(db, [id]);
  } finally {
    db.close();
  }
}

async function taskResponse(id: string): Promise<Response> {
  try {
    return apiJson(200, { ok: true, task: id, ...await taskUsage(id) });
  } catch (e) {
    console.error("[usage-api] 查询失败:", (e as Error).message); // 同 handleUsageApi：库没迁移 / 被锁，下一趟导入之后再取
    return apiJson(503, { ok: false, error: "token usage unavailable" });
  }
}

/** agent / feature 同步回（tests/usage-agent.test.ts 直接读 .status）；只有卡要等本周额度，回 Promise */
export function handleUsageApi(req: Request, path: `/usage/${"agent" | "feature"}/${string}`, principal: Principal): Response | null;
export function handleUsageApi(req: Request, path: string, principal: Principal): Response | Promise<Response> | null;
export function handleUsageApi(req: Request, path: string, principal: Principal): Response | Promise<Response> | null {
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
  if (m[1] === "task") return taskResponse(id);
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
