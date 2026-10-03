/**
 * 子 DAG 看板的读接口（i28-L4，docs/design/feature-dag.md「看板读接口」），DAG 图与进度图共用：
 *   GET /api/v1/ledger/:project/dag                                   各 feature 当前版的节点投影 + 进度图的 agent 行
 *   GET /api/v1/ledger/:project/dag/:featureId[?version=<n>|pending]  版本列表 + 某一版快照
 *   GET /api/v1/ledger/:project/dag/:featureId/diff?from=<n>&to=<n|pending>
 * 门和 /ledger/:project 同一道（canReadLedger），在解析参数、查 projects.json、查库之前判：拿不到门的人探不出项目、feature 在不在。
 * 一个请求一个 deferred 读事务，连接是 ledgerDb() 的 query_only 只读连接；不写库，不发事件。
 */
import { canReadLedger } from "../../lib/devices.js";
import { dagBoard, hasFeatureSchema } from "../../lib/ledger-dag-board.js";
import { featureDetail, featureDiff, type VersionSel } from "../../lib/ledger-dag-board-history.js";
import { getFeature, type Feature } from "../../lib/ledger-feature.js";
import { LedgerError } from "../../lib/ledger-store.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";
import { ledgerDb } from "../ledger-feed.js";
import { ledgerProjectExists } from "./ledger.js";

const bad = (error: string) => apiJson(400, { ok: false, error });
const notFound = (error: string) => apiJson(404, { ok: false, error });

/** 路径段解码：坏的百分号编码、控制字符、超长都算请求方的错（null → 400） */
function segment(s: string): string | null {
  let d: string;
  try {
    d = decodeURIComponent(s);
  } catch {
    // 非法百分号编码是请求方的错，调用方回 400
    return null;
  }
  return d.length > 200 || /[\u0000-\u001f\u007f]/.test(d) ? null : d;
}

/** 查询参数里的版本号：缺省 undefined；正整数字面量；allowPending 时也认 pending；其余 null（→ 400） */
function versionParam(raw: string | null, allowPending: boolean): VersionSel | null {
  if (raw === null) return undefined;
  if (raw === "pending") return allowPending ? "pending" : null;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

type Db = NonNullable<ReturnType<typeof ledgerDb>>;

/** 台账只读连接：库不存在 = { db: null }；打开出错 = 503 */
function openReadDb(): { db: Db | null } | Response {
  try {
    return { db: ledgerDb() };
  } catch (e) {
    return apiJson(503, { ok: false, error: `ledger unavailable: ${(e as Error).message}` });
  }
}
type Route = { kind: "board" } | { kind: "detail"; version: VersionSel } | { kind: "diff"; from: number | undefined; to: VersionSel };

export async function handleLedgerDagApi(req: Request, path: string, principal: Principal, url: URL): Promise<Response | null> {
  const m = path.match(/^\/ledger\/([^/]+)\/dag(?:\/([^/]+)(\/diff)?)?$/);
  if (!m) return null;
  if (!canReadLedger(principal)) return forbidden("ledger requires a full-scope owner credential");
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  const project = segment(m[1]);
  const featureId = m[2] === undefined ? undefined : segment(m[2]);
  if (project === null || featureId === null) return bad("bad path segment");
  let route: Route = { kind: "board" };
  if (featureId !== undefined && m[3]) {
    const from = versionParam(url.searchParams.get("from"), false);
    const to = versionParam(url.searchParams.get("to"), true);
    if (from === null || to === null) return bad("from must be a version number; to a version number or pending");
    route = { kind: "diff", from: from as number | undefined, to };
  } else if (featureId !== undefined) {
    const version = versionParam(url.searchParams.get("version"), true);
    if (version === null) return bad("version must be a version number or pending");
    route = { kind: "detail", version };
  }
  if (!(await ledgerProjectExists(project))) return notFound(`project "${project}" not found`);
  const opened = openReadDb();
  if (opened instanceof Response) return opened;
  const { db } = opened;
  const now = Date.now();
  if (featureId === undefined) {
    if (!db) return apiJson(200, { ok: true, project, exists: false, now, asOfSeq: 0, features: [], agents: [] });
    const board = db.transaction(() => dagBoard(db, project, now)).deferred();
    return apiJson(200, { ok: true, project, exists: true, now, ...board });
  }
  return db ? featureRoute(db, project, featureId, route, now) : notFound(`feature "${featureId}" not found in "${project}"`);
}

function featureRoute(db: Db, project: string, featureId: string, route: Route, now: number): Response {
  try {
    return db.transaction(() => {
      // 不存在和属于别的项目同一个 404：用 A 项目的路径探不出 B 项目的 feature
      const f: Feature | null = hasFeatureSchema(db) ? getFeature(db, featureId) : null;
      if (!f || f.project !== project) return notFound(`feature "${featureId}" not found in "${project}"`);
      if (route.kind === "diff") return apiJson(200, { ok: true, project, featureId, now, ...featureDiff(db, f, route.from, route.to, now) });
      return apiJson(200, { ok: true, project, now, ...featureDetail(db, f, route.kind === "detail" ? route.version : undefined, now) });
    }).deferred();
  } catch (e) {
    if (e instanceof LedgerError && e.code === "not_found") return notFound(e.message);
    if (e instanceof LedgerError && e.code === "invalid") return bad(e.message);
    throw e;
  }
}
