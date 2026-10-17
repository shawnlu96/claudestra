import { cachedBoardBuild } from "../../lib/board-build-cache.js";
import { canReadLedger } from "../../lib/devices.js";
import { productBoard } from "../../lib/ledger-product-board.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";
import { ledgerDb } from "../ledger-feed.js";
import { ledgerProjectExists } from "./ledger.js";

export interface ProductBoardIO {
  projectExists(project: string): Promise<boolean>;
  db: typeof ledgerDb;
  now(): number;
}
const live: ProductBoardIO = { projectExists: ledgerProjectExists, db: ledgerDb, now: Date.now };

export async function handleProductBoardApi(req: Request, path: string, principal: Principal, _url: URL, io: ProductBoardIO = live): Promise<Response | null> {
  const m = path.match(/^\/ledger\/([^/]+)\/product$/);
  if (!m) return null;
  if (!canReadLedger(principal)) return forbidden("ledger requires a full-scope owner credential");
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  let project: string;
  try { project = decodeURIComponent(m[1]); } catch {
    // Malformed URL encoding is a client error and does not require database access.
    return apiJson(400, { ok: false, error: "bad path segment" });
  }
  if (project.length > 200 || /[\u0000-\u001f\u007f]/.test(project)) return apiJson(400, { ok: false, error: "bad path segment" });
  if (!(await io.projectExists(project))) return apiJson(404, { ok: false, error: `project "${project}" not found` });
  let db: ReturnType<typeof ledgerDb>;
  try { db = io.db(); } catch (e) {
    return apiJson(503, { ok: false, error: `ledger unavailable: ${(e as Error).message}` });
  }
  const now = io.now();
  const build = () => ({ ok: true, project, exists: !!db, now, ...(db ? productBoard(db, project, now)
    : { throughput: { verified12h: 0, perHour: 0.25 }, features: [], deps: [] }) });
  const result = db ? await cachedBoardBuild(db, "product", project, {}, build) : build();
  return apiJson(200, result);
}
