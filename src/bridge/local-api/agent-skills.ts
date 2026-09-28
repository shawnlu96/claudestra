/**
 * 会话详情 ·「技能」栏：按 agent 启停技能（台账 i03 第一期）。
 *   GET  /api/v1/agents/:name/skill-settings → { agent, runtime, view: AgentSkillView }（lib/agent-skills.ts）
 *   POST /api/v1/agents/:name/skill-settings {skill, state} → manager skill-toggle 的输出（manager 是唯一写者）
 * 要 manage：技能路径是机器信息，关技能等于改 agent 的行为。master 也能管（名字就是 master）。
 * 改完不自动重启：CC 会话运行中不重读 --settings（lib/agent-settings.ts 顶部的实测），由界面提示「重启后生效」。
 */
import { isSkillName, isSkillState, readAgentSettings, skillOverridesOf } from "../../lib/agent-settings.js";
import { agentSkillView } from "../../lib/agent-skills.js";
import { canManage } from "../../lib/devices.js";
import { normalizePiEnvProfile } from "../../lib/pi-env.js";
import type { Principal } from "../../lib/principals.js";
import { agentRuntime, readRegistryAgents, type RegistryAgent } from "../../lib/registry.js";
import { runManagerProcess } from "../../lib/run-manager.js";
import { expandHome, localSkillLibrary } from "../../lib/skill-library.js";
import { apiJson, forbidden, INVALID_JSON, invalidJsonBody, readJsonBody } from "../api-respond.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "../config.js";

const PATH_RE = /^\/agents\/([^/]+)\/skill-settings$/;

/** master 不在 registry：当成 cwd 为空的 Claude Code agent（只看个人 / 插件 / 同步技能） */
async function resolveAgent(param: string): Promise<RegistryAgent | null> {
  if (param === "master") return { name: "master", runtime: "claude-code" };
  const key = param.startsWith("agent-") ? param : `agent-${param}`;
  return (await readRegistryAgents()).find((a) => a.name === key) ?? null;
}

export async function handleAgentSkills(req: Request, path: string, principal: Principal): Promise<Response | null> {
  const m = path.match(PATH_RE);
  if (!m || (req.method !== "GET" && req.method !== "POST")) return null;
  if (!canManage(principal)) return forbidden("skill-settings requires a credential with manage grant");
  const agent = await resolveAgent(decodeURIComponent(m[1]));
  if (!agent) return apiJson(404, { ok: false, error: `agent "${decodeURIComponent(m[1])}" not found` });
  const runtime = agentRuntime(agent);
  if (req.method === "GET") {
    const view = agentSkillView(runtime, (await localSkillLibrary()).skills, {
      cwd: agent.cwd ? expandHome(agent.cwd) : null,
      overrides: runtime === "claude-code" ? skillOverridesOf(readAgentSettings(agent.name)) : {},
      piEnv: normalizePiEnvProfile(agent.piEnv),
    });
    return apiJson(200, { ok: true, agent: agent.name, runtime, view });
  }
  const body: any = await readJsonBody(req);
  if (body === INVALID_JSON) return invalidJsonBody();
  const { skill, state } = body ?? {};
  if (!isSkillName(skill) || !isSkillState(state)) return apiJson(400, { ok: false, error: 'body must be {"skill": <name>, "state": "on"|"off"|"name-only"|"user-invocable-only"}' });
  const r = await runManagerProcess(["skill-toggle", agent.name, skill, state], { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: ENV_WITH_BUN, timeoutMs: 30_000 });
  console.log(`🧩 [api] skill-toggle ${agent.name} ${skill}=${state} → ${r?.ok ? "ok" : r?.error}`);
  return apiJson(r?.ok ? 200 : 400, r ?? { ok: false, error: "manager skill-toggle failed" });
}
