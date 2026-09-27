/**
 * 网页上开 / 关值守（lib/missions.ts；推进在 bridge/mission.ts）：
 *   POST   /api/v1/agents/:name/mission {goal, until, ledger?}   until 同命令行：HH:MM / +3h / ISO
 *   DELETE /api/v1/agents/:name/mission                          收回
 * 进行中的值守随 GET /agents 的 mission 字段下发（agent-info-routes.ts），这里不另设列表接口。
 * 要 manage 权限：值守会让 agent 在没人看着的时候一直干活，等同替 owner 下长期指令。
 */
import { canManage } from "../../lib/devices.js";
import { MISSIONS_PATH, missionKey, parseUntil, updateMissions, type Mission } from "../../lib/missions.js";
import type { Principal } from "../../lib/principals.js";
import { readRegistryAgents } from "../../lib/registry.js";
import { apiJson, forbidden, inScopeEitherName, INVALID_JSON, invalidJsonBody, notInScope, readJsonBody } from "../api-respond.js";

let paths: { missions: string; registry?: string } = { missions: MISSIONS_PATH };
/** 单测：状态文件与 registry 指到临时文件；生产不调 */
export function setMissionApiPathsForTest(p: { missions: string; registry?: string } | undefined): void {
  paths = p ?? { missions: MISSIONS_PATH };
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function handleMissionApi(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path.match(/^\/agents\/([^/]+)\/mission$/);
  if (!m || (req.method !== "POST" && req.method !== "DELETE")) return null;
  if (!canManage(principal)) return forbidden("missions require a credential with manage grant");
  const agent = missionKey(decodeURIComponent(m[1]));
  if (!inScopeEitherName(principal, agent)) return notInScope(agent);
  if (agent !== "master" && !(await readRegistryAgents(paths.registry)).some((a) => missionKey(a.name) === agent)) {
    return apiJson(404, { ok: false, error: `agent "${agent}" not found` });
  }
  if (req.method === "DELETE") {
    const hit = await updateMissions((all) => {
      const cur = all[agent];
      if (!cur || cur.status !== "active") return false;
      Object.assign(cur, { status: "stopped", finishedAt: new Date().toISOString() });
      delete cur.resumeAt;
      return true;
    }, paths.missions);
    return hit ? apiJson(200, { ok: true }) : apiJson(404, { ok: false, error: "no active mission" });
  }
  const raw = await readJsonBody(req);
  if (raw === INVALID_JSON) return invalidJsonBody();
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const goal = str(body.goal, 2000);
  const until = parseUntil(str(body.until, 64));
  if (!goal) return apiJson(400, { ok: false, error: '"goal" required' });
  if (!until) return apiJson(400, { ok: false, error: '"until" must be HH:MM, +3h or an ISO time within 7 days' });
  const ledger = str(body.ledger, 500);
  const mission: Mission = {
    agent, goal, until: until.toISOString(), createdAt: new Date().toISOString(), status: "active", nudges: 0, fastTurns: 0,
    ...(ledger ? { ledger } : {}),
  };
  await updateMissions((all) => void (all[agent] = mission), paths.missions);
  return apiJson(200, { ok: true, mission });
}
