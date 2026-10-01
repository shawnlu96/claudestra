/**
 * GET /api/v1/lend/workers（i28-W6）：A 借到的远端 worker，一单一行（lib/lend-workers-view.ts），只读。
 * 门和 /team/* 同一道（canReadLedger = owner 的全 scope 管理凭据）：peer、guest、部分 scope 一律 403；
 * peer 的 messages-only 白名单（lib/peer-scope-gate.ts）里没有它，peer token 在鉴权那一层就到不了这里。
 */
import { canReadLedger } from "../../lib/devices.js";
import { lendWorkerRows } from "../../lib/lend-workers-view.js";
import type { Principal } from "../../lib/principals.js";
import { apiJson, forbidden } from "../api-respond.js";
import { ledgerDb } from "../ledger-feed.js";

export function handleLendWorkersApi(req: Request, path: string, principal: Principal, url: URL): Response | null {
  if (path !== "/lend/workers") return null;
  if (!canReadLedger(principal)) return forbidden("lend workers require a full-scope owner credential");
  if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
  const db = ledgerDb();
  if (!db) return apiJson(200, { ok: true, workers: [] });
  const project = url.searchParams.get("project") ?? undefined;
  try {
    return apiJson(200, { ok: true, workers: lendWorkerRows(db, Date.now(), project) });
  } catch (e) {
    console.warn("[lend-workers] 读台账失败：", e);
    return apiJson(503, { ok: false, error: "lend workers unavailable" });
  }
}
