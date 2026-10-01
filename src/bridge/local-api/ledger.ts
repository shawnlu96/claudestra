/**
 * 内置台账的读接口（docs 10-ledger §4）；写只走 CLI（bun src/manager.ts ledger …），这里一律 GET：
 *   GET /api/v1/ledger/:project[?dayStart=<ms>]  事项 + 任务（每个带最近一条事件、指标、blockedBy / runnable）+ 依赖边 + 最近的项目级事件 + meta；
 *                                            已完成卡只带窗口，dayStart = 网页的当地零点（定「今日完成」带不带小圆点，lib/ledger-read-done.ts）
 *   GET /api/v1/ledger/:project/tasks/:id    任务 + 全部事件 + 阶段时间线 + 指标 + 进出依赖边 + 审查分叉
 *   GET /api/v1/ledger/:project/done?before=<游标>&limit=<n>   总览窗口外的已完成卡，按完成时刻倒序一页（lib/ledger-read-done.ts）
 *   GET /api/v1/ledger/:project/docs/<path>  meta.docsDir 下的 .md / .png / .jpg / .jpeg 原文件（规格卡、报告、截图）
 * 门是 canReadLedger（全 scope、非 peer 的 manage 凭据）；project 必须在 projects.json。库还不存在时总览回空台账（exists:false）。
 * 实时靠 SSE ledger 事件（bridge/ledger-feed.ts），网页连上 / 重连都全量重拉这里。
 */
import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { canReadLedger } from "../../lib/devices.js";
import { PROJECT_EVENTS_LIMIT, projectView, taskDetail } from "../../lib/ledger-read.js";
import { DONE_PAGE_DEFAULT, DONE_PAGE_MAX, donePage, parseDoneCursor } from "../../lib/ledger-read-done.js";
import { LEDGER_SCHEMA_VERSION, getMeta, schemaVersion } from "../../lib/ledger-store.js";
import type { Principal } from "../../lib/principals.js";
import { isUmbrellaDir, normalizeDir, PROJECTS_PATH, readProjects } from "../../lib/projects.js";
import { apiJson, forbidden } from "../api-respond.js";
import { ledgerDb } from "../ledger-feed.js";

const DOC_TYPES: Record<string, string> = { ".md": "text/markdown; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
/** 单个文档的上限：规格卡、报告、截图都远小于它；再大多半是放错了东西 */
const DOC_MAX_BYTES = 10 * 1024 * 1024;

let projectsPath = PROJECTS_PATH;
/** 单测：projects.json 指到临时文件；生产不调 */
export function setLedgerApiProjectsForTest(p: string | undefined): void {
  projectsPath = p ?? PROJECTS_PATH;
}

const notFound = (error: string) => apiJson(404, { ok: false, error });

/** project 在不在 projects.json（台账与「上次以来」两个端点共用这份校验） */
export async function ledgerProjectExists(project: string): Promise<boolean> {
  return (await readProjects(projectsPath)).projects.some((p) => p.id === project);
}

function decode(s: string): string | null {
  try {
    const d = decodeURIComponent(s);
    return d.includes("\0") ? null : d;
  } catch {
    // 非法百分号编码是请求方的错，调用方回 400
    return null;
  }
}

export async function handleLedgerApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path.match(/^\/ledger\/([^/]+)(?:\/tasks\/([^/]+)|\/docs\/(.+)|\/(done))?$/);
  if (!m) return null;
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  if (!canReadLedger(principal)) return forbidden("ledger requires a full-scope owner credential");
  const project = decode(m[1]);
  const taskId = m[2] === undefined ? undefined : decode(m[2]);
  if (project === null || taskId === null) return apiJson(400, { ok: false, error: "bad path encoding" });
  if (!(await ledgerProjectExists(project))) return notFound(`project "${project}" not found`);
  let db: ReturnType<typeof ledgerDb>;
  try {
    db = ledgerDb();
  } catch (e) {
    return apiJson(503, { ok: false, error: `ledger unavailable: ${(e as Error).message}` });
  }
  const now = Date.now();
  if (m[3] !== undefined) return db ? serveDoc(getMeta(db, project).docsDir, m[3]) : notFound("ledger has no docsDir");
  if (m[4] !== undefined) return serveDonePage(req, db, project, now);
  if (taskId !== undefined) {
    const detail = db ? taskDetail(db, project, taskId, now) : null;
    return detail ? apiJson(200, { ok: true, project, ...detail, now }) : notFound(`task "${taskId}" not found in "${project}"`);
  }
  if (!db) {
    const meta = { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } };
    return apiJson(200, { ok: true, project, exists: false, schema: LEDGER_SCHEMA_VERSION, meta, items: [], tasks: [], deps: [], projectEvents: [], audit: [], now });
  }
  // schema 报库里实际的版本：CLI 先升级、bridge 还没重启时它会比代码常量新（LedgerReader 打开时已记一次日志）
  return apiJson(200, { ok: true, project, exists: true, schema: schemaVersion(db), projectEventsLimit: PROJECT_EVENTS_LIMIT, ...projectView(db, project, now, clientDayStart(req)), now });
}

/** ?dayStart= 是整数毫秒才用；格式不对当没传（总览不因为这个参数失败，按服务器零点） */
function clientDayStart(req: Request): number | null {
  const raw = new URL(req.url).searchParams.get("dayStart");
  return raw !== null && /^\d{1,16}$/.test(raw) ? Number(raw) : null;
}

/** 已完成分页：before 缺省 = 从最新一张起；limit 缺省 DONE_PAGE_DEFAULT、封顶 DONE_PAGE_MAX；库不存在 = 空页 */
function serveDonePage(req: Request, db: ReturnType<typeof ledgerDb>, project: string, now: number): Response {
  const q = new URL(req.url).searchParams;
  const rawBefore = q.get("before");
  const before = rawBefore === null || rawBefore === "" ? null : parseDoneCursor(rawBefore);
  if (rawBefore && !before) return apiJson(400, { ok: false, error: "bad cursor" });
  const rawLimit = q.get("limit");
  const limit = rawLimit === null ? DONE_PAGE_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return apiJson(400, { ok: false, error: "bad limit" });
  const page = db ? donePage(db, project, before, Math.min(limit, DONE_PAGE_MAX), now) : { tasks: [], nextCursor: null };
  return apiJson(200, { ok: true, project, ...page, now });
}

/**
 * docsDir 下的一个文件。根与目标都 realpath 后按「根 + 分隔符」比前缀（`..`、编码过的 `..`、指向根外的软链都挡在这里）；
 * 扩展名白名单对请求的名字和软链解析后的真名都查。不在白名单、不存在一律 404，不区分「有但不给」。
 */
function serveDoc(docsDir: string | null, rawRel: string): Response {
  const rel = decode(rawRel);
  if (rel === null) return apiJson(400, { ok: false, error: "bad path encoding" });
  const dir = docsDir ? normalizeDir(docsDir) : "";
  if (!dir || !isAbsolute(dir)) return notFound("ledger has no docsDir");
  let root: string, real: string;
  try {
    root = realpathSync(dir);
  } catch {
    // docsDir 指向的目录不在了：对调用方就是没有文档
    return notFound("doc not found");
  }
  // 纵深防御：meta 的写者身份是自报的（docs 10-ledger §2），docsDir 被设成 / 或家目录就等于整机的 .md / 图片可读
  if (isUmbrellaDir(dir) || isUmbrellaDir(root)) return notFound("ledger has no docsDir");
  const inRoot = (p: string) => p.startsWith(root.endsWith(sep) ? root : root + sep);
  // 先按字面比一次：`..` 穿越在碰文件系统之前就拒，不给根外文件当「存不存在」的探针
  if (!inRoot(resolve(root, rel))) return forbidden("path escapes docsDir");
  try {
    real = realpathSync(resolve(root, rel));
  } catch {
    // 目标不存在（含软链断了）
    return notFound("doc not found");
  }
  if (!inRoot(real)) return forbidden("path escapes docsDir");
  const type = DOC_TYPES[extname(real).toLowerCase()];
  if (!DOC_TYPES[extname(rel).toLowerCase()] || !type) return notFound("doc not found");
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    // realpath 之后文件恰好被删：和不存在一样
    return notFound("doc not found");
  }
  if (!st.isFile()) return notFound("doc not found");
  if (st.size > DOC_MAX_BYTES) return apiJson(413, { ok: false, error: "doc too large" });
  return new Response(Bun.file(real), { headers: { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
}
