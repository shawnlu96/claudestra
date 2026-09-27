/**
 * 回环控制路由的 manage 版（docs/design-hosted-frontend.md §9 A†）：老 web BFF 在本机直打 /relay/status、/relay/pair/new、/stats，
 * 静态前端经中继 / 局域网进来时不是回环，只能走 /api/v1 + 凭据。体与响应和控制路由完全一致（同一个函数）：
 *   GET  /api/v1/relay/status · POST /api/v1/relay/pair {agents?, terminal?, manage?, guest?} · GET /api/v1/stats
 * 动态 import：relay-routes / stats-dashboard 拖着中继连接与 Discord 客户端，本地 API 其余端点族的单测不该为它们付出加载代价。
 */
import { canManage } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { forbidden } from "../api-respond.js";

const MANAGE_MSG = "control routes require a credential with manage grant";

export async function handleControl(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const status = path === "/relay/status" && req.method === "GET";
  const pair = path === "/relay/pair" && req.method === "POST";
  const stats = path === "/stats" && req.method === "GET";
  if (!status && !pair && !stats) return null;
  if (!canManage(principal)) return forbidden(MANAGE_MSG);
  if (stats) return (await import("../stats-dashboard.js")).handleStatsRequest();
  const relay = await import("../relay-routes.js");
  return status ? relay.relayStatusResponse() : relay.pairNew(req);
}
