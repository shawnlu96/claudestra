/**
 * 设置 ·「技能」页：本机的有效技能清单（lib/skill-library.ts）。
 *   GET /api/v1/skills/library → { roots: [{runtime, scope, dir, exists, project?, plugin?}], skills: LibrarySkill[], overrides: {agent: {skill: 档位}} }
 * 要 manage（canReadScopedManage：部分 scope 的 manage 设备也能读，按 scope 过滤）：技能路径、项目目录都是机器信息。只读；按 agent 启停走 agent-skills.ts → manager skill-toggle（唯一写者）。
 * 只报凭据 scope 内的 agent：它们的开关、以及它们工作目录下的项目技能 / 搜索根；scope 外 agent 的目录不该漏给部分授权的设备。
 */
import { allSkillOverrides } from "../../lib/agent-settings.js";
import { canReadScopedManage } from "../../lib/devices.js";
import { agentInScope, type Principal } from "../../lib/principals.js";
import { readActiveAgents } from "../../lib/registry.js";
import { expandHome, localSkillLibrary, onlyProjects } from "../../lib/skill-library.js";
import { apiJson, forbidden } from "../api-respond.js";

export async function handleSkillLibrary(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/skills/library" || req.method !== "GET") return null;
  if (!canReadScopedManage(principal)) return forbidden("skills/library requires a credential with manage grant");
  const lib = await localSkillLibrary();
  const cwds = new Set((await readActiveAgents()).filter((a) => a.cwd && agentInScope(principal, a.name)).map((a) => expandHome(a.cwd!)));
  const overrides = Object.fromEntries(Object.entries(allSkillOverrides()).filter(([agent]) => agentInScope(principal, agent)));
  return apiJson(200, { ok: true, roots: onlyProjects(lib.roots, cwds), skills: onlyProjects(lib.skills, cwds), overrides });
}
