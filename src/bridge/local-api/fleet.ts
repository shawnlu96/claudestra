/**
 * 批量管理（bridge/fleet/，docs/architecture/fleet-ops.md）：
 *   GET  /api/v1/fleet/state                          { ok, agents: [...含 lp], compactKeep }（现抓一遍各 CC 窗口的 LP 状态）
 *   POST /api/v1/fleet/run {action, select, dryRun?}  { ok, report: { runId, results[], excluded[], summary } }
 *   GET  /api/v1/fleet/access                         { ok }：只问有没有权限、不抓屏（网页据此决定显不显示「直接压缩」按钮）
 * 只给 owner 本人的全 scope manage 凭据（canRunFleet）：这些动作往一批会话里敲键，guest、部分 scope、peer 一律 403。
 * 过了门也只能动凭据 scope 里的 agent（agentInScope）：全 scope 不含大总管，设备没授 master 就列不出、选不中它（codex r4 P1-2）。
 * 动态 import：service 拖着 tmux 与台账，本地 API 其余端点族的单测不该为它付加载代价（同 quota.ts）。
 */
import { parseFleetAction, parseFleetSelect } from "../../lib/fleet-plan.js";
import { agentInScope, canRunFleet, tokenIdOf, type Principal } from "../../lib/principals.js";
import type { ApiUserEndpoint } from "../router.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";

export async function handleFleetApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/fleet/state" && path !== "/fleet/run" && path !== "/fleet/access") return null;
  if (!canRunFleet(principal)) return forbidden("fleet operations require the owner's full-scope manage credential");
  if (path === "/fleet/access") return apiJson(200, { ok: true });
  const svc = await import("../fleet/service.js");
  const allowed = (name: string) => agentInScope(principal, name);
  if (path === "/fleet/state") {
    if (req.method !== "GET") return apiJson(405, { ok: false, error: "method not allowed" });
    return apiJson(200, { ok: true, ...(await svc.fleetState(allowed)) });
  }
  if (req.method !== "POST") return apiJson(405, { ok: false, error: "method not allowed" });
  const body = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const b = (body ?? {}) as { action?: unknown; select?: unknown; dryRun?: unknown };
  const a = parseFleetAction(b.action);
  if (!a.ok) return apiJson(400, { ok: false, error: a.error });
  const s = parseFleetSelect(b.select);
  if (!s.ok) return apiJson(400, { ok: false, error: s.error });
  // 群发文字的回信地址 = 这台 owner 设备的会话（和它直接给 agent 发消息同一个 chat_id）：目标的回复落回它自己那段对话
  const replyTo: ApiUserEndpoint = { kind: "api", tokenId: tokenIdOf(principal), name: principal.name || tokenIdOf(principal), owner: true };
  const report = await svc.runFleet({ action: a.action, select: s.select, dryRun: b.dryRun === true, actor: "owner", via: `web:${principal.name || principal.id}`, allowed, replyTo });
  return apiJson(200, { ok: true, report });
}
