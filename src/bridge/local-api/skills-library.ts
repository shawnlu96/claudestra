/**
 * 设置 ·「技能」页：本机的有效技能清单（lib/skill-library.ts）。
 *   GET /api/v1/skills/library → { roots: [{runtime, scope, dir, exists, project?, plugin?}], skills: LibrarySkill[], overrides: {agent: {skill: 档位}} }
 * 要 manage：技能路径、项目目录都是机器信息。只读；按 agent 启停走 agent-skills.ts → manager skill-toggle（唯一写者）。
 */
import { allSkillOverrides } from "../../lib/agent-settings.js";
import { canManage } from "../../lib/devices.js";
import { agentInScope, type Principal } from "../../lib/principals.js";
import { localSkillLibrary } from "../../lib/skill-library.js";
import { apiJson, forbidden } from "../api-respond.js";

export async function handleSkillLibrary(req: Request, path: string, principal: Principal): Promise<Response | null> {
  if (path !== "/skills/library" || req.method !== "GET") return null;
  if (!canManage(principal)) return forbidden("skills/library requires a credential with manage grant");
  // 只报凭据 scope 内的 agent（scope 外的 agent 名和档位不该漏给部分授权的设备）
  const overrides = Object.fromEntries(Object.entries(allSkillOverrides()).filter(([agent]) => agentInScope(principal, agent)));
  return apiJson(200, { ok: true, ...(await localSkillLibrary()), overrides });
}
