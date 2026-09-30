/**
 * 跨实例委托的台账接口（lib/peer-ledger.ts、docs/team/peer-delegation.md）：只收 peer token，按 token 对应的 peer 名判能碰哪几张卡。
 *   GET  /api/v1/peer-ledger              委托给我的卡（执行方或审查方），跨项目
 *   GET  /api/v1/peer-ledger/tasks/:id    卡 + 事件时间线；不是给我的一律 404
 *   POST /api/v1/peer-ledger/tasks/:id    {op: note | pr | stage | review, …, dedup?} → manager `ledger peer-write`（bridge 只读台账）
 * 「只能投递消息」的 token 也放行这组（lib/peer-scope-gate.ts messagesOnlyAllows）。
 */
import { peerTaskDetail, peerTasks } from "../../lib/peer-ledger.js";
import type { Principal } from "../../lib/principals.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "../config.js";
import { ledgerDb } from "../ledger-feed.js";

const STATUS: Record<string, number> = { not_found: 404, forbidden: 403, conflict: 409, invalid: 400 };
const notFound = (id: string) => apiJson(404, { ok: false, error: `task "${id}" not found` });

export async function handlePeerLedgerApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path.match(/^\/peer-ledger(?:\/tasks\/([^/]+))?$/);
  if (!m) return null;
  const peer = principal.peer;
  if (!peer || peer.startsWith("invite:")) return forbidden("peer-ledger only serves redeemed peer tokens");
  const id = m[1] === undefined ? undefined : decodeURIComponent(m[1]); // 非法编码抛 URIError → 400（apiErrorResponse）
  if (req.method === "GET") {
    const db = ledgerDb();
    if (id === undefined) return apiJson(200, { ok: true, peer, tasks: db ? peerTasks(db, peer) : [] });
    const d = db ? peerTaskDetail(db, peer, id) : null;
    return d ? apiJson(200, { ok: true, ...d }) : notFound(id);
  }
  if (req.method !== "POST" || id === undefined) return apiJson(405, { ok: false, error: "method not allowed" });
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  // 频道号置空 = 以 owner 身份跑，事件 actor 由 peer-write 记成 peer:<名>；「--」之后全当位置参数，任务 id 写成 --help 也不会被当旗标
  const env = { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: "" };
  const r = await runManagerProcess(["ledger", "peer-write", "--", peer, id, JSON.stringify(body)], { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env, timeoutMs: 30_000 });
  if (r?.ok) return apiJson(200, r);
  // lend_managed（T93）：本轮审查归出借单管，对方要看得出不是权限问题而是走错了入口
  const code = r?.current?.lend === "lend_managed" ? "lend_managed" : r?.code;
  return apiJson(STATUS[r?.code] ?? 500, { ok: false, code: code ?? "internal", error: r?.error ?? "ledger write failed", ...(r?.current ? { current: r.current } : {}) });
}
