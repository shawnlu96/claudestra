/**
 * 回环控制路由的 manage 版（docs/design-hosted-frontend.md §9 A†）：老 web BFF 在本机直打 /relay/status、/relay/pair/new、/stats，
 * 静态前端经中继 / 局域网进来时不是回环，只能走 /api/v1 + 凭据。体与响应和控制路由完全一致（同一个函数）：
 *   GET  /api/v1/relay/status · POST /api/v1/relay/pair {agents?, terminal?, manage?, guest?} · GET /api/v1/stats[?refresh=1]
 *   POST /api/v1/relay/setup {relayUrl?}：一键接入中继（写 .env 的 RELAY_URL、当场连上，bridge/relay-link.ts enableRelay）
 * ?refresh=1 = 老 BFF 转成 POST /stats/refresh 的那条路：强制重抓账号用量（最长 ~20 s，前端给 30 s）。
 * 动态 import：relay-routes / stats-dashboard 拖着中继连接与 Discord 客户端，本地 API 其余端点族的单测不该为它们付出加载代价。
 */
import { canAdministerPairing, canManage } from "../../lib/devices.js";
import type { Principal } from "../../lib/principals.js";
import { forbidden } from "../api-respond.js";

const MANAGE_MSG = "control routes require a credential with manage grant";

export async function handleControl(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const status = path === "/relay/status" && req.method === "GET";
  const pair = path === "/relay/pair" && req.method === "POST";
  const stats = path === "/stats" && req.method === "GET";
  const setup = path === "/relay/setup" && req.method === "POST";
  if (!status && !pair && !stats && !setup) return null;
  if (!canManage(principal)) return forbidden(MANAGE_MSG);
  // 发配对码、改本机 .env 只认设备凭据：老的全 scope Bearer token 能过 canManage，但不该签出带终端和管理的新设备、也不该改机器配置
  if (pair && !canAdministerPairing(principal)) return forbidden("pairing requires a device credential with manage grant");
  if (setup && !canAdministerPairing(principal)) return forbidden("relay setup requires a device credential with manage grant");
  if (stats) {
    const dash = await import("../stats-dashboard.js");
    return new URL(req.url).searchParams.get("refresh") === "1" ? dash.handleStatsRefreshRequest() : dash.handleStatsRequest();
  }
  if (setup) {
    const body = (await req.json().catch(() => null)) as { relayUrl?: unknown } | null; // 空 body = 用官方中继
    const r = await (await import("../relay-link.js")).enableRelay(body?.relayUrl);
    return Response.json(r, { status: r.ok ? 200 : r.status });
  }
  const relay = await import("../relay-routes.js");
  return status ? relay.relayStatusResponse() : relay.pairNew(req, principal);
}
